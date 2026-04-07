import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as YAML from "yaml";
import { InMemoryEventBus } from "../lib/bus";
import type { BusMessage } from "../lib/types";
import { createScheduleTaskTool, createCancelScheduleTaskTool } from "../lib/clients/agent/tools";

const TEST_DIR = join(import.meta.dir, ".test-tools");

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("schedule_task tool", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    setup();
    bus = new InMemoryEventBus();
  });

  afterEach(cleanup);

  test("writes correct YAML for cron schedule", async () => {
    const tool = createScheduleTaskTool(bus, "cli", TEST_DIR);
    await tool.execute("call-1", {
      id: "daily-weather",
      schedule: "0 8 * * *",
      message: "Tell the user today's weather",
    }, undefined as any, undefined as any, undefined as any);

    const file = join(TEST_DIR, "crons", "daily-weather.yaml");
    expect(existsSync(file)).toBe(true);

    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.id).toBe("daily-weather");
    expect(def.type).toBe("cron");
    expect(def.schedule).toBe("0 8 * * *");
    expect(def.topic).toBe("cron.daily-weather");
    expect(def.payload.content).toBe("Tell the user today's weather");
    expect(def.payload.sender).toBe("cron");
    expect(def.payload.channel).toBe("cli");
    expect(def.payload.recipient).toBeUndefined();
    expect(def.enabled).toBe(true);
  });

  test("writes correct YAML for one-shot schedule", async () => {
    const tool = createScheduleTaskTool(bus, "cli", TEST_DIR);
    await tool.execute("call-1", {
      id: "reminder",
      schedule: "2026-04-10T15:00:00",
      message: "Remind user about meeting",
    }, undefined as any, undefined as any, undefined as any);

    const file = join(TEST_DIR, "crons", "reminder.yaml");
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.type).toBe("once");
    expect(def.schedule).toBe("2026-04-10T15:00:00");
  });

  test("infers signal channel and recipient from channelId", async () => {
    const tool = createScheduleTaskTool(bus, "signal:+1234567890", TEST_DIR);
    await tool.execute("call-1", {
      id: "signal-task",
      schedule: "0 9 * * *",
      message: "Morning update",
    }, undefined as any, undefined as any, undefined as any);

    const file = join(TEST_DIR, "crons", "signal-task.yaml");
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.payload.channel).toBe("signal");
    expect(def.payload.recipient).toBe("+1234567890");
  });

  test("explicit channel overrides inferred channel", async () => {
    const tool = createScheduleTaskTool(bus, "signal:+1234567890", TEST_DIR);
    await tool.execute("call-1", {
      id: "cli-override",
      schedule: "0 9 * * *",
      message: "Go to CLI instead",
      channel: "cli",
    }, undefined as any, undefined as any, undefined as any);

    const file = join(TEST_DIR, "crons", "cli-override.yaml");
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.payload.channel).toBe("cli");
    // recipient still set even though channel is cli (tool doesn't filter it)
    expect(def.payload.recipient).toBe("+1234567890");
  });

  test("publishes command.schedule to bus", async () => {
    let published: BusMessage | null = null;
    bus.subscribe("command.schedule", "test", (msg) => {
      published = msg;
    });

    const tool = createScheduleTaskTool(bus, "cli", TEST_DIR);
    await tool.execute("call-1", {
      id: "bus-test",
      schedule: "0 8 * * *",
      message: "test",
    }, undefined as any, undefined as any, undefined as any);

    expect(published).not.toBeNull();
    expect((published!.payload as any).action).toBe("add");
    expect((published!.payload as any).id).toBe("bus-test");
  });

  test("returns correct result shape", async () => {
    const tool = createScheduleTaskTool(bus, "cli", TEST_DIR);
    const result = await tool.execute("call-1", {
      id: "result-test",
      schedule: "0 8 * * *",
      message: "test",
    }, undefined as any, undefined as any, undefined as any);

    expect(result.content[0].text).toContain("result-test");
    expect(result.content[0].text).toContain("recurring");
    expect(result.details.type).toBe("cron");
  });

  test("timezone is passed through to YAML", async () => {
    const tool = createScheduleTaskTool(bus, "cli", TEST_DIR);
    await tool.execute("call-1", {
      id: "tz-test",
      schedule: "0 8 * * *",
      message: "test",
      timezone: "America/New_York",
    }, undefined as any, undefined as any, undefined as any);

    const file = join(TEST_DIR, "crons", "tz-test.yaml");
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.timezone).toBe("America/New_York");
  });
});

describe("cancel_schedule_task tool", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    setup();
    bus = new InMemoryEventBus();
  });

  afterEach(cleanup);

  test("publishes remove command to bus", async () => {
    let published: BusMessage | null = null;
    bus.subscribe("command.schedule", "test", (msg) => {
      published = msg;
    });

    const tool = createCancelScheduleTaskTool(bus, TEST_DIR);
    await tool.execute("call-1", { id: "some-task" }, undefined as any, undefined as any, undefined as any);

    expect(published).not.toBeNull();
    expect((published!.payload as any).action).toBe("remove");
    expect((published!.payload as any).id).toBe("some-task");
  });

  test("reports 'Cancelled' when YAML file exists", async () => {
    // Create the cron YAML file first
    const cronsDir = join(TEST_DIR, "crons");
    mkdirSync(cronsDir, { recursive: true });
    const filePath = join(cronsDir, "existing-task.yaml");
    Bun.write(filePath, "id: existing-task\nschedule: '0 8 * * *'\n");

    const tool = createCancelScheduleTaskTool(bus, TEST_DIR);
    const result = await tool.execute("call-1", { id: "existing-task" }, undefined as any, undefined as any, undefined as any);

    expect(result.content[0].text).toContain("Cancelled");
    expect(result.details.removed).toBe(true);
  });

  test("reports 'not found' when YAML file missing", async () => {
    const tool = createCancelScheduleTaskTool(bus, TEST_DIR);
    const result = await tool.execute("call-1", { id: "nonexistent" }, undefined as any, undefined as any, undefined as any);

    expect(result.content[0].text).toContain("not found");
    expect(result.details.removed).toBe(false);
  });
});
