import {
  createAgentSession,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  createCodingTools,
  DefaultResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, BusMessage } from "../../types";
import { createScheduleTaskTool, createCancelScheduleTaskTool } from "./tools";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

// Injected into Pi SDK agent sessions via agentsFilesOverride.
// Lives in code, not in workspace volume, so agents can't corrupt it.
export const AGENT_INSTRUCTIONS = `# Agent Behavior

You are an autonomous agent running inside WorkStacean, a message bus system with plugin architecture.

## Workspace Structure

Your tools (bash, read, write, edit) operate within the workspace directory. Do not modify files outside it.

- \`memory/\` — Your long-term memory. Write notes, summaries, structured data here. Reference across sessions.
- \`plugins/\` — Drop \`.ts\` or \`.js\` files implementing the Plugin interface here. Loaded on container restart.

## Built-in Topics

The message bus uses MQTT-style topic matching (\`#\` for multi-level, \`*\` for single-level wildcard).

- \`message.inbound.#\` — Inbound messages (from Signal, CLI, etc.)
- \`message.outbound.#\` — Outbound messages (replies)
- \`cron.#\` — Scheduled events (from SchedulerPlugin)
- \`command.#\` — System commands (\`command.restart\`, \`command.schedule\`)
- \`schedule.list\` — Response topic for schedule list queries
- \`#\` — Subscribe to everything (used by logger)

## Writing Plugins

Create a \`.ts\` or \`.js\` file in \`plugins/\` that exports an object implementing:

\`\`\`ts
interface Plugin {
  name: string;
  description: string;
  capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
\`\`\`

The \`bus\` provides \`publish(topic, message)\` and \`subscribe(pattern, pluginName, handler)\`. After writing a plugin, restart the container to load it.

## Scheduling

You have two tools for scheduling:

\`schedule_task\` — Schedule a recurring or one-time task. Parameters: \`id\` (kebab-case), \`schedule\` (cron or ISO datetime), \`message\` (your prompt when it fires), optional \`channel\` and \`timezone\`.

\`cancel_schedule_task\` — Cancel a scheduled task by \`id\`.

When a schedule fires, you receive the \`message\` as a prompt. Just respond naturally — your reply is automatically routed to the configured channel. Do NOT try to send messages yourself or reference delivery channels in your response. The system handles routing.

Example: user says "daily at 8a send me the weather" → call \`schedule_task\` with \`message: "Tell the user today's weather"\`. When it fires, you'll get that prompt, check the weather, and reply. The system delivers your reply.

**Important:** For relative times ("in 2 minutes", "tomorrow at 3pm"), always run \`date -u\` first to get the current UTC time, then compute the ISO datetime from that. Do NOT guess the current time — your internal clock may be wrong.

## Memory

Write important context to \`memory/\` as structured files. This persists across sessions and container restarts. Use it for:
- User preferences and recurring requests
- Summaries of long conversations
- Configuration or context that helps you serve the user better
`;

export interface SessionStrategy {
  run(channelId: string, message: string, channel?: string, forceBuffered?: boolean, context?: string): Promise<string | null>;
  reset(channelId: string): Promise<void>;
}

export interface SessionStrategyDeps {
  bus: EventBus;
  workspaceDir: string;
  dataDir: string;
  modelRegistry: ModelRegistry | null;
  authStorage: AuthStorage | null;
}

const BUFFERED_MODE = process.env.BUFFERED_MODE === "true" || process.env.BUFFERED_MODE === "1";

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export abstract class BaseSessionStrategy implements SessionStrategy {
  protected sessionsDir: string;
  private messageQueues = new Map<string, Promise<unknown>>();

  constructor(protected deps: SessionStrategyDeps) {
    this.sessionsDir = join(deps.dataDir, "sessions");
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  abstract reset(channelId: string): Promise<void>;

  protected abstract getSession(channelId: string): Promise<AgentSession>;

  async run(channelId: string, message: string, channel?: string, forceBuffered?: boolean, context?: string): Promise<string | null> {
    const prev = this.messageQueues.get(channelId) ?? Promise.resolve();
    let resolve!: (v: string | null) => void;
    const next = prev
      .then(() => this.doRun(channelId, message, channel, forceBuffered, context))
      .then(
        (v) => { resolve(v); },
        () => { resolve(null); },
      );
    this.messageQueues.set(channelId, next);
    return new Promise<string | null>((r) => { resolve = r; });
  }

  protected resetQueue(channelId: string): void {
    this.messageQueues.delete(channelId);
  }

  private publishChunk(channelId: string, content: string, channel?: string): void {
    const isSignalChannel = channel === "signal" || channelId.startsWith("signal:");
    if (!isSignalChannel) return;
    if (channelId.startsWith("cron:")) return;

    const recipient = channelId.startsWith("signal:")
      ? channelId.replace("signal:", "")
      : undefined;
    if (!recipient) return;

    const replyTopic = `message.outbound.signal.${recipient}`;
    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content },
      reply: content,
    };

    this.deps.bus.publish(replyTopic, reply);
    debug("Streamed chunk to", replyTopic, content.slice(0, 100));
  }

  private async doRun(
    channelId: string,
    userMessage: string,
    channel?: string,
    forceBuffered?: boolean,
    context?: string,
  ): Promise<string | null> {
    const session = await this.getSession(channelId);
    const prompt = context ? `${context}\n\n${userMessage}` : userMessage;
    const useBuffered = BUFFERED_MODE || forceBuffered || channel === "signal";
    if (useBuffered || channelId.startsWith("cron:")) {
      return runSessionPrompt(session, prompt);
    }
    await runSessionPrompt(session, prompt, (chunk: string) => this.publishChunk(channelId, chunk, channel));
    return null;
  }

  protected async createAgentSessionForDir(
    channelDir: string,
    channelId: string,
    mode: "create" | "continue",
  ): Promise<AgentSession> {
    const loader = makeResourceLoader();
    await loader.reload();

    const customTools = makeTools(this.deps, channelId);
    const sessionManager = makeSessionManager(this.deps.workspaceDir, channelDir, mode);

    const { session } = await createAgentSession({
      cwd: this.deps.workspaceDir,
      tools: createCodingTools(this.deps.workspaceDir),
      customTools,
      sessionManager,
      modelRegistry: this.deps.modelRegistry ?? undefined,
      authStorage: this.deps.authStorage ?? undefined,
      resourceLoader: loader,
    });

    return session;
  }

  protected async createInMemorySession(channelId: string): Promise<AgentSession> {
    const loader = makeResourceLoader();
    await loader.reload();

    const customTools = makeTools(this.deps, channelId);

    const { session } = await createAgentSession({
      cwd: this.deps.workspaceDir,
      tools: createCodingTools(this.deps.workspaceDir),
      customTools,
      sessionManager: SessionManager.inMemory(this.deps.workspaceDir),
      modelRegistry: this.deps.modelRegistry ?? undefined,
      authStorage: this.deps.authStorage ?? undefined,
      resourceLoader: loader,
    });

    return session;
  }
}

export async function runSessionPrompt(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  userMessage: string,
  onChunk?: (chunk: string) => void,
): Promise<string | null> {
  let responseText = "";
  let currentBlock = "";

  const flushBlock = () => {
    if (currentBlock.length > 0) {
      onChunk?.(currentBlock);
      currentBlock = "";
    }
  };

  return new Promise<string | null>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta;
            responseText += delta;
            currentBlock += delta;
          }
          break;
        case "tool_execution_start":
          debug("Tool call:", event.toolName, JSON.stringify(event.args));
          flushBlock();
          break;
        case "tool_execution_end":
          debug("Tool result:", event.toolName, event.isError ? "error" : "success");
          break;
        case "agent_end":
          unsubscribe();
          flushBlock();
          debug("Response:", responseText.slice(0, 200));
          resolve(responseText || null);
          break;
      }
    });

    session.prompt(userMessage).catch((e) => {
      unsubscribe();
      debug("Prompt error:", e);
      resolve(null);
    });
  });
}

export function makeTools(
  deps: SessionStrategyDeps,
  channelId: string,
): ToolDefinition[] {
  return [
    createScheduleTaskTool(deps.bus, channelId, deps.dataDir),
    createCancelScheduleTaskTool(deps.bus, deps.dataDir),
  ];
}

export function makeResourceLoader() {
  return new DefaultResourceLoader({
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        { path: "virtual:agent-instructions", content: AGENT_INSTRUCTIONS },
      ],
    }),
  });
}

export function makeSessionManager(
  workspaceDir: string,
  sessionDir: string,
  mode: "create" | "continue",
) {
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  return mode === "continue"
    ? SessionManager.continueRecent(workspaceDir, sessionDir)
    : SessionManager.create(workspaceDir, sessionDir);
}
