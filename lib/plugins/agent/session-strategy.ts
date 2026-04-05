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
import type { EventBus } from "../../types";
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
  run(channelId: string, message: string): Promise<string | null>;
  reset(channelId: string): Promise<void>;
}

export interface SessionStrategyDeps {
  bus: EventBus;
  workspaceDir: string;
  dataDir: string;
  modelRegistry: ModelRegistry | null;
  authStorage: AuthStorage | null;
}

export async function runSessionPrompt(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  userMessage: string,
): Promise<string | null> {
  let responseText = "";

  return new Promise<string | null>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            responseText += event.assistantMessageEvent.delta;
          }
          break;
        case "tool_execution_start":
          debug("Tool call:", event.toolName, JSON.stringify(event.args));
          break;
        case "tool_execution_end":
          debug("Tool result:", event.toolName, event.isError ? "error" : "success");
          break;
        case "agent_end":
          unsubscribe();
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
