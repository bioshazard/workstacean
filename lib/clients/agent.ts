import { ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../types";
import {
  AGENT_INSTRUCTIONS,
  type SessionStrategy,
  type SessionStrategyDeps,
} from "./agent/session-strategy";
import { LongLivedSessionStrategy } from "./agent/long-lived";
import { RalphSessionStrategy } from "./agent/ralph";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const CONTEXT_LIMIT = parseInt(process.env.CONTEXT_LIMIT || "20", 10);

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

export class AgentPlugin implements Plugin {
  name = "agent";
  description = "Pi SDK agent - processes inbound messages and replies";
  capabilities: string[] = ["reason", "execute", "reply"];

  private bus: EventBus | null = null;
  private strategy!: SessionStrategy;
  private strategyOverride: SessionStrategy | null = null;
  private modelRegistry: ModelRegistry | null = null;
  private authStorage: AuthStorage | null = null;
  private workspaceDir: string;
  private dataDir: string;

  constructor(
    workspaceDir: string,
    dataDir: string,
    strategy?: SessionStrategy,
  ) {
    this.workspaceDir = resolve(workspaceDir);
    this.dataDir = resolve(dataDir);
    this.strategyOverride = strategy ?? null;

    this.authStorage = AuthStorage.inMemory({
      "local-llm": {
        type: "api_key",
        key: process.env.OPENAI_API_KEY || "sk-dummy",
      },
    });

    const modelsPath = resolve(process.cwd(), "models.json");
    this.modelRegistry = existsSync(modelsPath)
      ? ModelRegistry.create(this.authStorage, modelsPath)
      : null;
  }

  install(bus: EventBus): void {
    this.bus = bus;

    if (this.strategyOverride) {
      this.strategy = this.strategyOverride;
    } else {
      const deps: SessionStrategyDeps = {
        bus,
        workspaceDir: this.workspaceDir,
        dataDir: this.dataDir,
        modelRegistry: this.modelRegistry,
        authStorage: this.authStorage,
      };

      const mode = process.env.SESSION_MODE || "long-lived";

      switch (mode) {
        case "ralph":
          this.strategy = new RalphSessionStrategy(deps);
          debug("Agent plugin: Ralph session strategy (fresh per trigger, JIT context)");
          break;
        case "long-lived":
        default:
          this.strategy = new LongLivedSessionStrategy(deps);
          debug("Agent plugin: Long-lived session strategy (persistent sessions)");
          break;
      }
    }

    bus.subscribe("message.inbound.#", this.name, (msg: BusMessage) => {
      this.handleInbound(bus, msg);
    });

    bus.subscribe("cron.#", this.name, (msg: BusMessage) => {
      this.handleCron(bus, msg);
    });

    bus.subscribe("command.#", this.name, (msg: BusMessage) => {
      this.handleCommand(bus, msg);
    });

    debug("Agent plugin installed, strategy:", this.strategy.constructor.name);
  }

  uninstall(): void {}

  private async handleInbound(bus: EventBus, msg: BusMessage): Promise<void> {
    const sender = (msg.payload as { sender?: string })?.sender;
    const content = msg.reply || (msg.payload as { content?: string })?.content;

    if (!sender || !content) return;

    if (content === "/new") {
      await this.strategy.reset(`signal:${sender}`);
      const replyTopic = msg.topic.replace("inbound", "outbound");
      const reply: BusMessage = {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: { content: "Session reset. How can I help you?" },
        reply: "Session reset. How can I help you?",
      };
      bus.publish(reply.topic, reply);
      return;
    }

    debug("Processing from", sender, content);

    const context = this.buildContext([
      `message.inbound.signal.${sender}`,
      `message.outbound.signal.${sender}`,
    ]);

    const response = await this.strategy.run(`signal:${sender}`, content, undefined, undefined, context ?? undefined);

    if (!response) return;

    const replyTopic = msg.topic.replace("inbound", "outbound");
    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
      reply: response,
    };

    debug("Replying to", sender);
    bus.publish(reply.topic, reply);
  }

  private async handleCron(bus: EventBus, msg: BusMessage): Promise<void> {
    const payload = msg.payload as {
      content?: string;
      sender?: string;
      channel?: string;
      recipient?: string;
      [key: string]: unknown;
    };

    const content = payload?.content;
    if (!content) return;

    const channel = payload.channel || "cli";
    const recipient = payload.recipient;
    const cronId = msg.topic.replace("cron.", "");
    const channelId = `cron:${cronId}`;

    debug(
      "Processing cron:",
      cronId,
      "→",
      channel,
      recipient ? `(recipient: ${recipient})` : "",
    );

    // Build context from recipient's channel history if available
    let context: string | null = null;
    if (recipient && channel === "signal") {
      context = this.buildContext([
        `message.inbound.signal.${recipient}`,
        `message.outbound.signal.${recipient}`,
      ]);
    }

    const response = await this.strategy.run(channelId, content, channel, undefined, context ?? undefined);
    if (!response) return;

    const replyTopic =
      channel === "signal" && recipient
        ? `message.outbound.signal.${recipient}`
        : channel === "signal"
          ? `message.outbound.signal.cron`
          : `message.outbound.${channel}`;

    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
      reply: response,
    };

    debug("Cron reply →", replyTopic);
    bus.publish(reply.topic, reply);
  }

  private async handleCommand(bus: EventBus, msg: BusMessage): Promise<void> {
    const action = (msg.payload as { action?: string })?.action;

    if (action === "reset") {
      const channel = (msg.payload as { channel?: string })?.channel;
      if (channel) {
        await this.strategy.reset(channel);
        console.log(`[Agent] Session reset for ${channel}`);
      }
    }
  }

  /**
   * Build a conversation context string from recent event log entries.
   * Returns null if no history or DB unavailable.
   */
  private buildContext(topicPatterns: string[]): string | null {
    const dbPath = join(this.dataDir, "events.db");
    if (!existsSync(dbPath)) return null;

    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const placeholders = topicPatterns.map(() => "topic LIKE ?").join(" OR ");
      const rows = db
        .query(
          `SELECT payload FROM events WHERE (${placeholders}) ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(...topicPatterns.map((p) => `${p}%`), CONTEXT_LIMIT) as {
        payload: string;
      }[];

      if (rows.length === 0) return null;

      // Reverse to chronological order (oldest first)
      const messages = rows.reverse().map((r) => {
        const msg: BusMessage = JSON.parse(r.payload);
        const isInbound = msg.topic.includes("inbound");
        const content =
          msg.reply || (msg.payload as { content?: string })?.content || "";
        const ts = new Date(msg.timestamp).toISOString().slice(0, 19);
        return `[${ts}] ${isInbound ? "User" : "Agent"}: ${content}`;
      });

      return `[Recent conversation history]\n${messages.join("\n")}`;
    } catch (e) {
      debug("Context build failed:", e);
      return null;
    } finally {
      db?.close();
    }
  }
}
