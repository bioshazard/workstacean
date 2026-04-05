import { createAgentSession, createCodingTools } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionStrategy, SessionStrategyDeps } from "./session-strategy";
import { makeResourceLoader, makeSessionManager, makeTools, runSessionPrompt } from "./session-strategy";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

// TODO: 3-Tier JIT Context Assembler
//
// When implemented, buildContext() will be called before session.prompt()
// to assemble progressive disclosure from SQLite.
//
// Tier 0 — always injected, always tiny
//   Trigger type, sender identity, timestamp, 2–3 sentence world state summary.
//   Fits in every session. Costs almost nothing.
//
// Tier 1 — JIT bootstrap, bounded
//   Last N messages for this thread, upcoming cron jobs, directly relevant
//   KG subgraph (nodes matching trigger entities). Assembled by querying
//   SQLite before session spawn. Target: 500–1000 tokens.
//
// Tier 2 — agent-pulled, lazy
//   The agent calls tools mid-run when it determines it needs depth:
//   kgQuery(), ragSearch(), getMessageHistory(n=50), getTaskDetail(id).
//   Tier 2 is pull-on-demand, not pre-injected. These tools would be
//   added to makeTools().
//
// Memory layers:
//   KG (SQLite) — structured, queryable, current. Answers "what is true now."
//   RAG (MCP) — fuzzy, semantic, historical. Answers "what was said before."
//
// For now, context is just the raw trigger message + AGENT_INSTRUCTIONS.

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

export class RalphSessionStrategy implements SessionStrategy {
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

  async reset(_channelId: string): Promise<void> {
    debug("Ralph strategy: reset is a no-op (every run is already fresh)");
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
    const safeChannelId = channelId.replace(/[^a-zA-Z0-9_\-+]/g, "_");
    const runId = `${Date.now()}_${crypto.randomUUID()}`;
    const channelDir = join(this.sessionsDir, safeChannelId, runId);

    if (!existsSync(channelDir)) {
      mkdirSync(channelDir, { recursive: true });
    }

    const loader = makeResourceLoader();
    await loader.reload();

    const customTools = makeTools(this.deps, channelId);

    const sessionManager = makeSessionManager(
      this.deps.workspaceDir,
      channelDir,
      "create",
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

    debug("Ralph session for", channelId, "->", channelDir, "(fresh, audit trail)");

    return runSessionPrompt(session, userMessage);
  }
}
