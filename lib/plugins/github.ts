/**
 * GitHubPlugin — receives GitHub webhook events and routes @mentions to the bus.
 *
 * Inbound:
 *   POST /webhook/github → validates signature → filters for @mentions
 *   → message.inbound.github.{owner}.{repo}.{event}.{number}
 *
 * Outbound:
 *   message.outbound.github.# → posts GitHub comment via API
 *
 * Config: workspace/github.yaml (mention handle, skill hints per event type)
 *
 * Env vars:
 *   GITHUB_TOKEN            (required — enables plugin, used for posting comments)
 *   GITHUB_WEBHOOK_SECRET   (recommended — validates X-Hub-Signature-256)
 *   GITHUB_WEBHOOK_PORT     port for webhook HTTP server (default: 8082)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface GitHubConfig {
  mentionHandle: string;
  skillHints: Record<string, string>;
}

function loadConfig(workspaceDir: string): GitHubConfig {
  const configPath = join(workspaceDir, "github.yaml");
  if (!existsSync(configPath)) {
    return {
      mentionHandle: "@quinn",
      skillHints: {
        issue_comment: "bug_triage",
        issues: "bug_triage",
        pull_request_review_comment: "pr_review",
        pull_request: "pr_review",
      },
    };
  }
  return parseYaml(readFileSync(configPath, "utf8")) as GitHubConfig;
}

// ── Pending comment context ───────────────────────────────────────────────────
// Keyed by correlationId — same pattern as DiscordPlugin's pendingReplies.
// Stores enough info to POST a comment back to GitHub.

interface PendingComment {
  owner: string;
  repo: string;
  number: number;
}

const pendingComments = new Map<string, PendingComment>();

// ── GitHub event helpers ──────────────────────────────────────────────────────

interface GitHubEventContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
}

function extractContext(event: string, payload: Record<string, unknown>): GitHubEventContext | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  const repoName = repo?.name as string | undefined;

  if (!owner || !repoName) return null;

  if (event === "issue_comment") {
    const issue = payload.issue as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    return {
      owner,
      repo: repoName,
      number: issue.number as number,
      title: issue.title as string,
      url: comment.html_url as string,
      body: comment.body as string ?? "",
      author: (comment.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "pull_request_review_comment") {
    const pr = payload.pull_request as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    return {
      owner,
      repo: repoName,
      number: pr.number as number,
      title: pr.title as string,
      url: comment.html_url as string,
      body: comment.body as string ?? "",
      author: (comment.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "issues" && payload.action === "opened") {
    const issue = payload.issue as Record<string, unknown>;
    return {
      owner,
      repo: repoName,
      number: issue.number as number,
      title: issue.title as string,
      url: issue.html_url as string,
      body: issue.body as string ?? "",
      author: (issue.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
    const pr = payload.pull_request as Record<string, unknown>;
    return {
      owner,
      repo: repoName,
      number: pr.number as number,
      title: pr.title as string,
      url: pr.html_url as string,
      body: pr.body as string ?? "",
      author: (pr.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  return null;
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

// Add an "eyes" reaction to acknowledge receipt — fire-and-forget, best-effort.
function reactToMention(token: string, event: string, payload: Record<string, unknown>): void {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  const repoName = repo?.name as string | undefined;
  if (!owner || !repoName) return;

  let url: string;
  if (event === "issue_comment") {
    const id = (payload.comment as Record<string, unknown>)?.id;
    url = `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${id}/reactions`;
  } else if (event === "pull_request_review_comment") {
    const id = (payload.comment as Record<string, unknown>)?.id;
    url = `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${id}/reactions`;
  } else if (event === "issues") {
    const number = (payload.issue as Record<string, unknown>)?.number;
    url = `https://api.github.com/repos/${owner}/${repoName}/issues/${number}/reactions`;
  } else if (event === "pull_request") {
    const number = (payload.pull_request as Record<string, unknown>)?.number;
    url = `https://api.github.com/repos/${owner}/${repoName}/issues/${number}/reactions`;
  } else {
    return;
  }

  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ content: "eyes" }),
  })
    .then(res => {
      if (!res.ok) res.text().then(t => console.error(`[github] reaction failed ${res.status}: ${t}`));
    })
    .catch(err => console.error("[github] reaction error:", err));
}

// ── HMAC-SHA256 signature validation ─────────────────────────────────────────

async function validateSignature(secret: string, body: string, sigHeader: string | null): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = sigHeader.slice(7);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

  // Constant-time comparison
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class GitHubPlugin implements Plugin {
  readonly name = "github";
  readonly description = "GitHub webhook receiver — @mentions → bus → agent replies as comments";
  readonly capabilities = ["github-inbound", "github-outbound"];

  private server: ReturnType<typeof Bun.serve> | null = null;
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.log("[github] GITHUB_TOKEN not set — plugin disabled");
      return;
    }

    const config = loadConfig(this.workspaceDir);
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const port = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "8082", 10);

    // ── Outbound: post comment back to GitHub ────────────────────────────────
    bus.subscribe("message.outbound.github.#", "github-outbound", async (msg: BusMessage) => {
      const correlationId = msg.correlationId;
      if (!correlationId) return;

      const pending = pendingComments.get(correlationId);
      if (!pending) return;
      pendingComments.delete(correlationId);

      const content = String((msg.payload as Record<string, unknown>).content ?? "").trim();
      if (!content) return;

      await this._postComment(token, pending, content);
    });

    // ── Inbound: webhook HTTP server ─────────────────────────────────────────
    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/webhook/github") {
          return new Response("Not found", { status: 404 });
        }
        if (req.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }

        const body = await req.text();

        if (webhookSecret) {
          const sig = req.headers.get("X-Hub-Signature-256");
          if (!await validateSignature(webhookSecret, body, sig)) {
            console.warn("[github] Invalid webhook signature — request rejected");
            return new Response("Unauthorized", { status: 401 });
          }
        }

        const event = req.headers.get("X-GitHub-Event") ?? "";
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        this._handleEvent(event, payload, config, bus, token);

        return new Response("OK", { status: 200 });
      },
    });

    console.log(`[github] Webhook receiver on :${port}/webhook/github`);
  }

  uninstall(_bus: EventBus): void {
    this.server?.stop();
  }

  private _handleEvent(
    event: string,
    payload: Record<string, unknown>,
    config: GitHubConfig,
    bus: EventBus,
    token: string,
  ): void {
    const ctx = extractContext(event, payload);
    if (!ctx) return;

    // Only act on explicit @mentions
    if (!ctx.body.toLowerCase().includes(config.mentionHandle.toLowerCase())) return;

    // Acknowledge receipt immediately — eyes reaction signals the bot is working
    reactToMention(token, event, payload);

    const skillHint = config.skillHints[event];
    const correlationId = crypto.randomUUID();

    pendingComments.set(correlationId, {
      owner: ctx.owner,
      repo: ctx.repo,
      number: ctx.number,
    });

    // Build a rich content string so the agent has full context
    const content = [
      `${config.mentionHandle} — ${event} on ${ctx.owner}/${ctx.repo}#${ctx.number}`,
      `Title: ${ctx.title}`,
      `Author: @${ctx.author}`,
      `URL: ${ctx.url}`,
      ``,
      ctx.body,
    ].join("\n");

    const topic = `message.inbound.github.${ctx.owner}.${ctx.repo}.${event}.${ctx.number}`;
    const replyTopic = `message.outbound.github.${ctx.owner}.${ctx.repo}.${ctx.number}`;

    bus.publish(topic, {
      id: `${event}-${ctx.owner}-${ctx.repo}-${ctx.number}-${correlationId.slice(0, 8)}`,
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        sender: ctx.author,
        channel: `${ctx.owner}/${ctx.repo}#${ctx.number}`,
        content,
        skillHint,
        github: {
          event,
          owner: ctx.owner,
          repo: ctx.repo,
          number: ctx.number,
          title: ctx.title,
          url: ctx.url,
        },
      },
      reply: { topic: replyTopic },
    });

    console.log(`[github] ${event} on ${ctx.owner}/${ctx.repo}#${ctx.number} → ${skillHint ?? "default"}`);
  }

  private async _postComment(
    token: string,
    ctx: PendingComment,
    body: string,
  ): Promise<void> {
    const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "protoWorkstacean/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[github] Failed to post comment: ${res.status} ${err}`);
      } else {
        console.log(`[github] Comment posted to ${ctx.owner}/${ctx.repo}#${ctx.number}`);
      }
    } catch (err) {
      console.error("[github] Error posting comment:", err);
    }
  }
}
