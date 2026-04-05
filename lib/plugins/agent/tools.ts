import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { EventBus, BusMessage } from "../../types";
import * as YAML from "yaml";

export function createScheduleTaskTool(
  bus: EventBus,
  channelId: string,
  dataDir: string,
): ToolDefinition {
  const cronsDir = join(dataDir, "crons");

  return {
    name: "schedule_task",
    label: "Schedule Task",
    description:
      "Schedule a recurring or one-time task. The message you provide is delivered to you as a prompt when it fires — just respond naturally. Your reply is automatically routed to the correct channel.",
    promptSnippet: "Schedule recurring or one-time tasks",
    promptGuidelines: [
      "Use schedule_task when the user asks to do something on a schedule (daily, weekly, at a specific time, etc.).",
      "The id should be a short kebab-case identifier (e.g., 'daily-weather', 'morning-standup').",
      "For schedule: use cron expressions ('0 8 * * *' for 8am daily) or ISO datetimes ('2026-04-01T15:00:00') for one-shots.",
      "The message is a prompt delivered to you when it fires. Write it like a user message (e.g., 'Tell the user today's weather'). Your reply is auto-routed — do NOT include delivery instructions.",
      "Do NOT reference Signal, channels, or delivery mechanisms in the message. Just describe what to do.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Short kebab-case identifier, e.g. 'daily-weather'",
      }),
      schedule: Type.String({
        description:
          "Cron expression ('0 8 * * *') or ISO datetime ('2026-04-01T15:00:00')",
      }),
      message: Type.String({
        description:
          "Prompt delivered to you when this fires. Write like a user message. Your reply is auto-routed.",
      }),
      channel: Type.Optional(
        Type.String({
          description: "Reply channel: 'signal' or 'cli'. Default: 'cli'.",
        }),
      ),
      timezone: Type.Optional(
        Type.String({
          description: "IANA timezone, e.g. 'America/New_York'. Default: system TZ.",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: {
        id: string;
        schedule: string;
        message: string;
        channel?: string;
        timezone?: string;
      },
      _signal,
      _onUpdate,
      _ctx,
    ) {
      const cronDir = cronsDir;
      if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });

      const type = /^\d{4}-\d{2}-\d{2}T/.test(params.schedule) ? "once" : "cron";

      const sessionChannel = channelId.startsWith("signal:")
        ? "signal"
        : channelId.startsWith("cli")
          ? "cli"
          : "cli";
      const channel = params.channel || sessionChannel;
      const recipient = channelId.startsWith("signal:")
        ? channelId.slice("signal:".length)
        : undefined;

      const def = {
        id: params.id,
        type,
        schedule: params.schedule,
        timezone: params.timezone,
        topic: `cron.${params.id}`,
        payload: {
          content: params.message,
          sender: "cron",
          channel,
          recipient,
        },
        enabled: true,
        lastFired: null,
      };

      const filePath = join(cronDir, `${params.id}.yaml`);
      const doc = new YAML.Document(def);
      writeFileSync(filePath, doc.toString());

      const cmdMsgId = crypto.randomUUID();
      const cmdMsg: BusMessage = {
        id: cmdMsgId,
        correlationId: cmdMsgId,
        topic: "command.schedule",
        timestamp: Date.now(),
        payload: { action: "add", ...def },
      };
      bus.publish("command.schedule", cmdMsg);

      const typeLabel = type === "cron" ? "recurring" : "one-shot";
      return {
        content: [
          {
            type: "text",
            text: `Scheduled "${params.id}" (${typeLabel}, ${params.schedule}) → ${def.topic}`,
          },
        ],
        details: { id: params.id, schedule: params.schedule, type },
      };
    },
  };
}

export function createCancelScheduleTaskTool(
  bus: EventBus,
  dataDir: string,
): ToolDefinition {
  const cronsDir = join(dataDir, "crons");

  return {
    name: "cancel_schedule_task",
    label: "Cancel Scheduled Task",
    description: "Cancel a previously scheduled task by its id.",
    promptSnippet: "Cancel a scheduled task",
    promptGuidelines: [
      "Use cancel_schedule_task when the user asks to cancel, remove, or stop a scheduled task.",
      "The id must match the one used when scheduling.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "The id of the scheduled task to cancel",
      }),
    }),
    async execute(
      _toolCallId,
      params: { id: string },
      _signal,
      _onUpdate,
      _ctx,
    ) {
      const filePath = join(cronsDir, `${params.id}.yaml`);

      const cancelId = crypto.randomUUID();
      const cmdMsg: BusMessage = {
        id: cancelId,
        correlationId: cancelId,
        topic: "command.schedule",
        timestamp: Date.now(),
        payload: { action: "remove", id: params.id },
      };
      bus.publish("command.schedule", cmdMsg);

      const existed = !existsSync(filePath);
      return {
        content: [
          {
            type: "text",
            text: existed
              ? `Cancelled "${params.id}"`
              : `Schedule "${params.id}" not found (may have already fired)`,
          },
        ],
        details: { id: params.id, removed: existed },
      };
    },
  };
}
