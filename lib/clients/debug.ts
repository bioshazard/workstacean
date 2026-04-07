import type { Plugin, EventBus, BusMessage } from "../types";

export class DebugPlugin implements Plugin {
  name = "debug";
  description = "Captures console output and publishes to debug.* topics on the bus";
  capabilities: string[] = ["debug", "logging"];

  private bus: EventBus | null = null;
  private originals = {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  install(bus: EventBus): void {
    this.bus = bus;

    const wrap = (level: string, original: typeof console.log) => {
      const topic = `debug.${level}`;
      return (...args: unknown[]) => {
        original(...args);
        const msg: BusMessage = {
          id: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          topic,
          timestamp: Date.now(),
          payload: { level, message: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "), args },
        };
        bus.publish(topic, msg);
      };
    };

    console.log = wrap("log", this.originals.log);
    console.debug = wrap("debug", this.originals.debug);
    console.info = wrap("info", this.originals.info);
    console.warn = wrap("warn", this.originals.warn);
    console.error = wrap("error", this.originals.error);
  }

  uninstall(): void {
    console.log = this.originals.log;
    console.debug = this.originals.debug;
    console.info = this.originals.info;
    console.warn = this.originals.warn;
    console.error = this.originals.error;
  }
}
