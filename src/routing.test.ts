import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import type { BusMessage } from "../lib/types";
import type { SessionStrategy } from "../lib/clients/agent/session-strategy";
import { AgentPlugin } from "../lib/clients/agent";

const TEST_DIR = join(import.meta.dir, ".test-routing");

/** Mock strategy that returns a canned response */
function mockStrategy(response: string = "mock response"): SessionStrategy {
  const calls: { channelId: string; message: string; channel?: string }[] = [];
  return {
    async run(channelId, message, channel) {
      calls.push({ channelId, message, channel });
      return response;
    },
    async reset() {},
    // Expose calls for assertions
    get _calls() { return calls; },
  } as SessionStrategy & { _calls: typeof calls };
}

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("AgentPlugin handleCron routing", () => {
  let bus: InMemoryEventBus;
  let strategy: ReturnType<typeof mockStrategy>;

  beforeEach(() => {
    setup();
    bus = new InMemoryEventBus();
    strategy = mockStrategy("cron reply");
  });

  afterEach(cleanup);

  function installAgent() {
    const agent = new AgentPlugin(TEST_DIR, TEST_DIR, strategy);
    agent.install(bus);
    return agent;
  }

  function fireCron(topic: string, payload: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    const msg: BusMessage = {
      id,
      correlationId: id,
      topic,
      timestamp: Date.now(),
      payload,
      reply: payload.content as string,
    };
    bus.publish(msg.topic, msg);
    return id;
  }

  test("cron with channel=cli routes to message.outbound.cli", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    fireCron("cron.daily-weather", {
      content: "Tell the weather",
      sender: "cron",
      channel: "cli",
    });

    // Wait for async handler
    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].topic).toBe("message.outbound.cli");
    expect(replies[0].reply).toBe("cron reply");
  });

  test("cron with channel=signal and recipient routes to signal recipient", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.signal.#", "test", (msg) => replies.push(msg));

    fireCron("cron.morning-update", {
      content: "Good morning",
      sender: "cron",
      channel: "signal",
      recipient: "+1234567890",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].topic).toBe("message.outbound.signal.+1234567890");
    expect(replies[0].reply).toBe("cron reply");
  });

  test("cron with channel=signal but no recipient routes to signal.cron", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.signal.#", "test", (msg) => replies.push(msg));

    fireCron("cron.orphan-signal", {
      content: "No recipient",
      sender: "cron",
      channel: "signal",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].topic).toBe("message.outbound.signal.cron");
  });

  test("cron without channel defaults to cli", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    fireCron("cron.no-channel", {
      content: "Default routing",
      sender: "cron",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].topic).toBe("message.outbound.cli");
  });

  test("cron without content is ignored", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    fireCron("cron.empty", { sender: "cron" });

    await Bun.sleep(50);

    expect(replies.length).toBe(0);
  });

  test("cron passes channel to strategy.run", async () => {
    installAgent();

    fireCron("cron.channel-pass", {
      content: "Check channel",
      sender: "cron",
      channel: "signal",
      recipient: "+1234",
    });

    await Bun.sleep(50);

    expect(strategy._calls.length).toBe(1);
    expect(strategy._calls[0].channelId).toBe("cron:channel-pass");
    expect(strategy._calls[0].message).toBe("Check channel");
    expect(strategy._calls[0].channel).toBe("signal");
  });

  test("cron preserves correlationId in reply", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    const correlationId = fireCron("cron.correlation", {
      content: "Track me",
      sender: "cron",
      channel: "cli",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].correlationId).toBe(correlationId);
  });
});

describe("AgentPlugin handleInbound routing", () => {
  let bus: InMemoryEventBus;
  let strategy: ReturnType<typeof mockStrategy>;

  beforeEach(() => {
    setup();
    bus = new InMemoryEventBus();
    strategy = mockStrategy("agent reply");
  });

  afterEach(cleanup);

  function installAgent() {
    const agent = new AgentPlugin(TEST_DIR, TEST_DIR, strategy);
    agent.install(bus);
    return agent;
  }

  test("inbound message routes reply to matching outbound topic", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    const id = crypto.randomUUID();
    bus.publish("message.inbound.signal.+1234", {
      id,
      correlationId: id,
      topic: "message.inbound.signal.+1234",
      timestamp: Date.now(),
      payload: { sender: "+1234", content: "hello" },
      reply: "hello",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].topic).toBe("message.outbound.signal.+1234");
    expect(replies[0].reply).toBe("agent reply");
  });

  test("/new resets session and replies", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    const id = crypto.randomUUID();
    bus.publish("message.inbound.cli", {
      id,
      correlationId: id,
      topic: "message.inbound.cli",
      timestamp: Date.now(),
      payload: { sender: "cli", content: "/new" },
      reply: "/new",
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(1);
    expect(replies[0].reply).toContain("reset");
  });

  test("inbound with missing sender is ignored", async () => {
    installAgent();

    const replies: BusMessage[] = [];
    bus.subscribe("message.outbound.#", "test", (msg) => replies.push(msg));

    const id = crypto.randomUUID();
    bus.publish("message.inbound.test", {
      id,
      correlationId: id,
      topic: "message.inbound.test",
      timestamp: Date.now(),
      payload: { content: "no sender" },
    });

    await Bun.sleep(50);

    expect(replies.length).toBe(0);
  });
});
