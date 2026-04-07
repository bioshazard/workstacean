import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionStrategyDeps } from "./session-strategy";
import { BaseSessionStrategy } from "./session-strategy";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class LongLivedSessionStrategy extends BaseSessionStrategy {
  private sessions = new Map<string, AgentSession>();

  constructor(deps: SessionStrategyDeps) {
    super(deps);
  }

  async reset(channelId: string): Promise<void> {
    const session = await this.createSessionForChannel(channelId, false);
    this.sessions.set(channelId, session);
    this.resetQueue(channelId);
  }

  protected async getSession(channelId: string): Promise<AgentSession> {
    if (!this.sessions.has(channelId)) {
      const session = await this.createSessionForChannel(channelId, true);
      this.sessions.set(channelId, session);
    }
    return this.sessions.get(channelId)!;
  }

  private async createSessionForChannel(
    channelId: string,
    continueRecent: boolean,
  ): Promise<AgentSession> {
    const safeChannelId = channelId.replace(/[^a-zA-Z0-9_\-+]/g, "_");
    const channelDir = join(this.sessionsDir, safeChannelId);
    if (!existsSync(channelDir)) {
      mkdirSync(channelDir, { recursive: true });
    }

    const session = await this.createAgentSessionForDir(
      channelDir,
      channelId,
      continueRecent ? "continue" : "create",
    );

    debug(
      "Session for",
      channelId,
      "->",
      channelDir,
      continueRecent ? "(continued)" : "(fresh)",
    );
    return session;
  }
}
