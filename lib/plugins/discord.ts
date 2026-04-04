/**
 * DiscordPlugin — bridges Discord gateway events to/from the Workstacean bus.
 *
 * Inbound:
 *   @mentions, DMs → message.inbound.discord.{channelId}
 *   📋 reactions   → message.inbound.discord.{channelId}  (skill hint: bug_triage)
 *   /quinn *       → message.inbound.discord.slash.{interactionId}
 *
 * Outbound:
 *   message.outbound.discord.#  → reply to originating message/interaction
 *   message.outbound.discord.push.{channelId} → unprompted post (cron, etc.)
 *
 * Env vars:
 *   DISCORD_BOT_TOKEN       (required)
 *   DISCORD_GUILD_ID        (required for slash command registration)
 *   DISCORD_DIGEST_CHANNEL  channel ID for cron-triggered posts
 *   DISCORD_WELCOME_CHANNEL channel ID for member welcome messages
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

// Pending reply handles: correlationId → Discord context
// Kept outside the bus payload so the SQLite logger never tries to serialize them.
const pendingReplies = new Map<
  string,
  { message?: Message; interaction?: ChatInputCommandInteraction }
>();

// Simple rate-limit: max 5 messages per 10s per user
const rateLimits = new Map<string, number[]>();
function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const window = 10_000;
  const hits = (rateLimits.get(userId) ?? []).filter(t => now - t < window);
  hits.push(now);
  rateLimits.set(userId, hits);
  return hits.length > 5;
}

// Spam patterns (same as Quinn's bot)
const SPAM_PATTERNS = [
  /free\s*nitro/i,
  /discord\.gift\//i,
  /@everyone.*https?:\/\//i,
  /steamcommunity\.com\/gift/i,
];
function isSpam(content: string): boolean {
  return SPAM_PATTERNS.some(p => p.test(content));
}

function makeId(): string {
  return crypto.randomUUID();
}

export class DiscordPlugin implements Plugin {
  readonly name = "discord";
  readonly description = "Discord gateway — routes messages to/from the A2A agent fleet";
  readonly capabilities = ["discord-inbound", "discord-outbound"];

  private client!: Client;
  private busRef!: EventBus;

  install(bus: EventBus): void {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.log("[discord] DISCORD_BOT_TOKEN not set — plugin disabled");
      return;
    }

    this.busRef = bus;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    // ── Ready ──────────────────────────────────────────────────────────────
    this.client.once(Events.ClientReady, async client => {
      console.log(`[discord] Logged in as ${client.user.tag}`);
      await this._registerSlashCommands();
    });

    // ── Message create ──────────────────────────────────────────────────────
    this.client.on(Events.MessageCreate, async message => {
      if (message.author.bot) return;

      const isMentioned = message.mentions.has(this.client.user!);
      const isDM = !message.guild;
      if (!isMentioned && !isDM) return;

      const userId = message.author.id;

      if (isSpam(message.content)) {
        await message.delete().catch(() => {});
        return;
      }
      if (isRateLimited(userId)) {
        await message.reply("Easy there — you're sending messages too quickly.").catch(() => {});
        return;
      }

      await message.react("👀").catch(() => {});

      const correlationId = makeId();
      pendingReplies.set(correlationId, { message });

      const content = message.cleanContent
        .replace(/<@!?\d+>/g, "")
        .trim();

      bus.publish(`message.inbound.discord.${message.channelId}`, {
        id: message.id,
        correlationId,
        topic: `message.inbound.discord.${message.channelId}`,
        timestamp: Date.now(),
        payload: {
          sender: userId,
          channel: message.channelId,
          content,
          isThread: message.channel.isThread(),
          guildId: message.guildId,
        },
        reply: { topic: `message.outbound.discord.${message.channelId}` },
      });
    });

    // ── Clipboard 📋 reaction → bug triage ────────────────────────────────
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return;
      if (reaction.emoji.name !== "📋") return;

      const message = reaction.partial
        ? await reaction.message.fetch()
        : reaction.message as Message;

      await message.react("👀").catch(() => {});

      const correlationId = makeId();
      pendingReplies.set(correlationId, { message });

      bus.publish(`message.inbound.discord.${message.channelId}`, {
        id: `${message.id}-clip`,
        correlationId,
        topic: `message.inbound.discord.${message.channelId}`,
        timestamp: Date.now(),
        payload: {
          sender: user.id,
          channel: message.channelId,
          content: message.content,
          skillHint: "bug_triage",
          isReaction: true,
        },
        reply: { topic: `message.outbound.discord.${message.channelId}` },
      });
    });

    // ── Slash commands ──────────────────────────────────────────────────────
    this.client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "quinn") return;

      await interaction.deferReply();

      const subcommand = interaction.options.getSubcommand(false) ?? "status";
      const version = interaction.options.getString("version") ?? "";

      const cmdMap: Record<string, { content: string; skillHint: string }> = {
        status:  { content: "/status",                skillHint: "qa_report"   },
        bugs:    { content: "/bugs",                  skillHint: "bug_triage"  },
        release: { content: `/release ${version}`.trim(), skillHint: "qa_report" },
      };

      const cmd = cmdMap[subcommand] ?? cmdMap.status;
      const correlationId = makeId();
      pendingReplies.set(correlationId, { interaction });

      const topicSuffix = `slash.${interaction.id}`;
      bus.publish(`message.inbound.discord.${topicSuffix}`, {
        id: interaction.id,
        correlationId,
        topic: `message.inbound.discord.${topicSuffix}`,
        timestamp: Date.now(),
        payload: {
          sender: interaction.user.id,
          channel: interaction.channelId,
          content: cmd.content,
          skillHint: cmd.skillHint,
        },
        reply: { topic: `message.outbound.discord.${topicSuffix}` },
      });
    });

    // ── Welcome new members ────────────────────────────────────────────────
    this.client.on(Events.GuildMemberAdd, async member => {
      const channelId = process.env.DISCORD_WELCOME_CHANNEL;
      if (!channelId) return;
      const ch = member.guild.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send(`Welcome to the protoLabs community, <@${member.id}>! 👋`).catch(() => {});
    });

    // ── Outbound: reply to pending messages / interactions ─────────────────
    bus.subscribe("message.outbound.discord.#", "discord-outbound", async (msg: BusMessage) => {
      const payload = msg.payload as Record<string, unknown>;
      const content = String(payload.content ?? "").slice(0, 2000) || "(no response)";
      const correlationId = msg.correlationId;

      // 1. Pending reply from a prior inbound message
      if (correlationId) {
        const pending = pendingReplies.get(correlationId);
        if (pending) {
          pendingReplies.delete(correlationId);

          if (pending.interaction) {
            await pending.interaction.editReply({ content }).catch(console.error);
            return;
          }

          if (pending.message) {
            const reply = await pending.message.reply({ content }).catch(console.error);
            // Start a thread on first response if not already in one
            if (reply && !pending.message.channel.isThread()) {
              await reply.startThread({ name: content.slice(0, 50) || "Quinn response" }).catch(() => {});
            }
            // Update reactions: 👀 → ✅
            await pending.message.reactions.resolve("👀")?.users.remove(this.client.user!).catch(() => {});
            await pending.message.react("✅").catch(() => {});
            return;
          }
        }
      }

      // 2. Unprompted push (cron, proactive notification)
      const channelId = String(payload.channel ?? payload.recipient ?? "");
      if (channelId) {
        const ch = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        await ch?.send({ content }).catch(console.error);
      }
    });

    this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  uninstall(_bus: EventBus): void {
    this.client?.destroy();
  }

  private async _registerSlashCommands(): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!guildId) {
      console.log("[discord] DISCORD_GUILD_ID not set — skipping slash command registration");
      return;
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      console.log(`[discord] Guild ${guildId} not found`);
      return;
    }

    await guild.commands.set([
      {
        name: "quinn",
        description: "Quinn QA commands",
        options: [
          { name: "status",  type: 1, description: "QA status report" },
          { name: "bugs",    type: 1, description: "Active bugs across apps" },
          {
            name: "release",
            type: 1,
            description: "Generate release notes",
            options: [{ name: "version", type: 3, description: "Version tag (e.g. v1.2.0)", required: false }],
          },
        ],
      },
    ]);

    console.log("[discord] Slash commands registered");
  }
}
