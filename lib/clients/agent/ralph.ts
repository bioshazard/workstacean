import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionStrategyDeps } from "./session-strategy";
import { BaseSessionStrategy } from "./session-strategy";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export class RalphSessionStrategy extends BaseSessionStrategy {
  constructor(deps: SessionStrategyDeps) {
    super(deps);
  }

  async reset(_channelId: string): Promise<void> {
    debug("Ralph strategy: reset is a no-op (every run is already fresh)");
  }

  protected async getSession(channelId: string): Promise<AgentSession> {
    const session = await this.createInMemorySession(channelId);
    debug("Ralph session for", channelId, "(ephemeral, bus log is audit trail)");
    return session;
  }
}
