import { createAgentSession, createCodingTools } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionStrategy, SessionStrategyDeps } from "./session-strategy";
import { makeResourceLoader, makeSessionManager, makeTools, runSessionPrompt } from "./session-strategy";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

interface SessionInfo {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

export class LongLivedSessionStrategy implements SessionStrategy {
  private sessions = new Map<string, SessionInfo>();
  private messageQueues = new Map<string, Promise<unknown>>();
  private sessionsDir: string;

  constructor(
    private deps: SessionStrategyDeps,
  ) {
    this.sessionsDir = join(deps.dataDir, "sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private async createSession(
    channelId: string,
    continueRecent: boolean,
  ): Promise<SessionInfo> {
    const safeChannelId = channelId.replace(/[^a-zA-Z0-9_\-+]/g, "_");
    const channelDir = join(this.sessionsDir, safeChannelId);
    if (!existsSync(channelDir)) {
      mkdirSync(channelDir, { recursive: true });
    }

    const loader = makeResourceLoader();
    await loader.reload();

    const customTools = makeTools(this.deps, channelId);

    const sessionManager = makeSessionManager(
      this.deps.workspaceDir,
      channelDir,
      continueRecent ? "continue" : "create",
    );

    const { session } = await createAgentSession({
      cwd: this.deps.workspaceDir,
      tools: createCodingTools(this.deps.workspaceDir),
      customTools,
      sessionManager,
      modelRegistry: this.deps.modelRegistry ?? undefined,
      authStorage: this.deps.authStorage ?? undefined,
      resourceLoader: loader,
    });

    const info = { session };
    this.sessions.set(channelId, info);
    debug(
      "Session for",
      channelId,
      "->",
      channelDir,
      continueRecent ? "(continued)" : "(fresh)",
    );
    return info;
  }

  private async getSession(channelId: string): Promise<SessionInfo> {
    if (!this.sessions.has(channelId)) {
      return this.createSession(channelId, true);
    }
    return this.sessions.get(channelId)!;
  }

  async reset(channelId: string): Promise<void> {
    await this.createSession(channelId, false);
    this.messageQueues.delete(channelId);
  }

  async run(channelId: string, message: string): Promise<string | null> {
    const prev = this.messageQueues.get(channelId) ?? Promise.resolve();
    let resolve!: (v: string | null) => void;
    const next = prev
      .then(() => this.doRun(channelId, message))
      .then(
        (v) => {
          resolve(v);
        },
        () => {
          resolve(null);
        },
      );
    this.messageQueues.set(channelId, next);
    return new Promise<string | null>((r) => {
      resolve = r;
    });
  }

  private async doRun(
    channelId: string,
    userMessage: string,
  ): Promise<string | null> {
    const { session } = await this.getSession(channelId);
    return runSessionPrompt(session, userMessage);
  }
}
