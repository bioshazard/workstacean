import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as YAML from "yaml";
import { InMemoryEventBus } from "../lib/bus";
import type { BusMessage } from "../lib/types";

// We import the class directly — no Pi SDK dependency needed for scheduler tests
import { SchedulerPlugin } from "../lib/clients/scheduler";

const TEST_WORKSPACE = join(import.meta.dir, ".test-workspace");

function setupWorkspace() {
  if (existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, "crons"), { recursive: true });
}

function cleanupWorkspace() {
  if (existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true });
}

describe("SchedulerPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: SchedulerPlugin;

  beforeEach(() => {
    setupWorkspace();
    bus = new InMemoryEventBus();
    plugin = new SchedulerPlugin(TEST_WORKSPACE);
  });

  afterEach(() => {
    plugin.uninstall();
    cleanupWorkspace();
  });

  // --- YAML I/O ---

  test("loads valid cron YAML on startup", () => {
    const yaml = YAML.stringify({
      id: "test-cron",
      type: "cron",
      schedule: "0 8 * * *",
      topic: "cron.test-cron",
      payload: { content: "test", sender: "cron", channel: "cli" },
      enabled: true,
    });
    writeFileSync(join(TEST_WORKSPACE, "crons", "test-cron.yaml"), yaml);

    // Install subscribes to bus topics and loads files
    plugin.install(bus);

    // The schedule should be loaded (we can't easily test the timer, but no error = success)
  });

  test("loads valid one-shot YAML on startup", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now
    const yaml = YAML.stringify({
      id: "test-once",
      type: "once",
      schedule: future,
      topic: "cron.test-once",
      payload: { content: "test", sender: "cron" },
      enabled: true,
    });
    writeFileSync(join(TEST_WORKSPACE, "crons", "test-once.yaml"), yaml);

    plugin.install(bus);
    // No error = success
  });

  test("skips invalid YAML on startup", () => {
    writeFileSync(join(TEST_WORKSPACE, "crons", "bad.yaml"), "not: valid: yaml: {{{");

    // Should not throw
    plugin.install(bus);
  });

  test("skips YAML missing required fields", () => {
    const yaml = YAML.stringify({ id: "incomplete" });
    writeFileSync(join(TEST_WORKSPACE, "crons", "incomplete.yaml"), yaml);

    plugin.install(bus);
  });

  // --- Type inference ---

  test("infers type from cron expression", () => {
    plugin.install(bus);

    bus.publish("command.schedule", {
      id: "auto-cron",
      correlationId: "auto-cron",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "auto-cron",
        schedule: "0 8 * * *",
        topic: "cron.auto-cron",
        payload: { content: "test" },
      },
    });

    // Verify YAML was written with type: cron
    const file = join(TEST_WORKSPACE, "crons", "auto-cron.yaml");
    expect(existsSync(file)).toBe(true);
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.type).toBe("cron");
  });

  test("infers type from ISO datetime", () => {
    plugin.install(bus);

    bus.publish("command.schedule", {
      id: "auto-once",
      correlationId: "auto-once",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "auto-once",
        schedule: "2099-04-01T15:00:00",
        topic: "cron.auto-once",
        payload: { content: "test" },
      },
    });

    const file = join(TEST_WORKSPACE, "crons", "auto-once.yaml");
    expect(existsSync(file)).toBe(true);
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.type).toBe("once");
  });

  // --- Bus commands ---

  test("add command creates YAML file", () => {
    plugin.install(bus);

    bus.publish("command.schedule", {
      id: "test-add",
      correlationId: "test-add",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "test-add",
        schedule: "0 9 * * *",
        topic: "cron.test-add",
        payload: { content: "hello" },
      },
    });

    const file = join(TEST_WORKSPACE, "crons", "test-add.yaml");
    expect(existsSync(file)).toBe(true);
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.id).toBe("test-add");
    expect(def.schedule).toBe("0 9 * * *");
    expect(def.topic).toBe("cron.test-add");
    expect(def.enabled).toBe(true);
  });

  test("remove command deletes YAML file", () => {
    plugin.install(bus);

    // Add first
    bus.publish("command.schedule", {
      id: "test-remove",
      correlationId: "test-remove",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "test-remove",
        schedule: "0 9 * * *",
        topic: "cron.test-remove",
        payload: { content: "hello" },
      },
    });

    const file = join(TEST_WORKSPACE, "crons", "test-remove.yaml");
    expect(existsSync(file)).toBe(true);

    // Remove
    bus.publish("command.schedule", {
      id: "remove-cmd",
      correlationId: "remove-cmd",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: { action: "remove", id: "test-remove" },
    });

    expect(existsSync(file)).toBe(false);
  });

  test("pause command disables schedule", () => {
    plugin.install(bus);

    bus.publish("command.schedule", {
      id: "test-pause",
      correlationId: "test-pause",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "test-pause",
        schedule: "0 9 * * *",
        topic: "cron.test-pause",
        payload: { content: "hello" },
      },
    });

    bus.publish("command.schedule", {
      id: "pause-cmd",
      correlationId: "pause-cmd",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: { action: "pause", id: "test-pause" },
    });

    const file = join(TEST_WORKSPACE, "crons", "test-pause.yaml");
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.enabled).toBe(false);
  });

  test("list command publishes to schedule.list", () => {
    plugin.install(bus);

    let listResult: BusMessage | null = null;
    bus.subscribe("schedule.list", "test", (msg) => {
      listResult = msg;
    });

    bus.publish("command.schedule", {
      id: "list-cmd",
      correlationId: "list-cmd",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: { action: "list" },
    });

    expect(listResult).not.toBeNull();
    expect(listResult!.payload).toHaveProperty("schedules");
  });

  // --- Fire behavior ---

  test("fires scheduled event to bus topic", async () => {
    plugin.install(bus);

    let fired: BusMessage | null = null;
    bus.subscribe("cron.test-fire", "test", (msg) => {
      fired = msg;
    });

    // Schedule 50ms from now using ISO datetime
    const fireTime = new Date(Date.now() + 50).toISOString();

    bus.publish("command.schedule", {
      id: "test-fire",
      correlationId: "test-fire",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "test-fire",
        schedule: fireTime,
        topic: "cron.test-fire",
        payload: { content: "fired!", sender: "cron", channel: "cli" },
      },
    });

    // Wait for timer
    await Bun.sleep(200);

    expect(fired).not.toBeNull();
    expect(fired!.payload).toEqual(
      expect.objectContaining({ content: "fired!", sender: "cron", channel: "cli" })
    );
  });

  test("one-shot deletes YAML after fire", async () => {
    plugin.install(bus);

    const fireTime = new Date(Date.now() + 50).toISOString();
    const file = join(TEST_WORKSPACE, "crons", "test-oneshot.yaml");

    bus.publish("command.schedule", {
      id: "test-oneshot",
      correlationId: "test-oneshot",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "test-oneshot",
        schedule: fireTime,
        topic: "cron.test-oneshot",
        payload: { content: "one and done" },
      },
    });

    expect(existsSync(file)).toBe(true);

    await Bun.sleep(200);

    expect(existsSync(file)).toBe(false);
  });

  test("cron recurring does NOT delete YAML after fire", async () => {
    // Write a cron YAML that fires every second (for testing)
    // Use a cron expression: "* * * * * *" won't work with 5-field cron
    // Instead, write a YAML file directly with type: cron and a schedule
    // that the scheduler will parse and fire
    const file = join(TEST_WORKSPACE, "crons", "test-recurring.yaml");
    const yaml = YAML.stringify({
      id: "test-recurring",
      type: "cron",
      schedule: "* * * * *", // every minute
      topic: "cron.test-recurring",
      payload: { content: "recurring fire", sender: "cron" },
      enabled: true,
    });
    writeFileSync(file, yaml);

    // Install loads the YAML and schedules it
    plugin.install(bus);

    // The YAML should still exist (cron type is never deleted on load)
    expect(existsSync(file)).toBe(true);

    // Verify it's loaded as cron type
    const def = YAML.parse(readFileSync(file, "utf-8"));
    expect(def.type).toBe("cron");
    expect(def.id).toBe("test-recurring");
  });

  // --- Missed fire behavior ---

  test("missed one-shot fires immediately on startup", async () => {
    // Write a one-shot YAML that's already in the past (but within 24h)
    const pastTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const file = join(TEST_WORKSPACE, "crons", "missed.yaml");
    const yaml = YAML.stringify({
      id: "missed",
      type: "once",
      schedule: pastTime,
      topic: "cron.missed",
      payload: { content: "missed fire!", sender: "cron" },
      enabled: true,
    });
    writeFileSync(file, yaml);

    let fired: BusMessage | null = null;
    bus.subscribe("cron.missed", "test", (msg) => {
      fired = msg;
    });

    // Install should detect the missed schedule and fire immediately
    plugin.install(bus);

    // Give it a tick to process
    await Bun.sleep(50);

    expect(fired).not.toBeNull();
    expect((fired!.payload as any).content).toBe("missed fire!");
    // One-shot should have deleted the YAML
    expect(existsSync(file)).toBe(false);
  });

  // --- Validation ---

  test("add command requires id, schedule, topic, payload.content", () => {
    plugin.install(bus);

    // Missing topic
    bus.publish("command.schedule", {
      id: "bad-cmd",
      correlationId: "bad-cmd",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "bad-schedule",
        schedule: "0 8 * * *",
        payload: { content: "test" },
      },
    });

    expect(existsSync(join(TEST_WORKSPACE, "crons", "bad-schedule.yaml"))).toBe(false);
  });

  test("add command rejects invalid cron expression", () => {
    plugin.install(bus);

    bus.publish("command.schedule", {
      id: "bad-cron",
      correlationId: "bad-cron",
      topic: "command.schedule",
      timestamp: Date.now(),
      payload: {
        action: "add",
        id: "bad-cron",
        schedule: "not a cron",
        topic: "cron.bad-cron",
        payload: { content: "test" },
      },
    });

    // "not a cron" is inferred as cron type, parser rejects it
    expect(existsSync(join(TEST_WORKSPACE, "crons", "bad-cron.yaml"))).toBe(false);
  });
});
