# Platform Design — Distillation

A single-process, single-container AI agent platform built on Bun, SQLite, and the pi SDK. The bus carries signals. SQLite carries truth. The agent carries nothing between runs.

---

## The Bus Contract

The bus is a dumb wire. It delivers typed payloads to subscribers and knows nothing else.

It does not know about runs, DAGs, skills, sessions, agents, cron, WhatsApp, world state, or anything in this document. It knows that topics exist and that messages get delivered to subscribers.

Every piece of domain logic lives in the clients. The bus could be a Bun `EventEmitter`, Redis pub/sub, NATS, or a WebSocket. Swapping it requires zero application changes. This is the most important invariant in the system. Cross it once — add a routing rule that knows about run status, a filter that understands skill concepts — and the architecture collapses into a coupled monolith.

**Bus responsibility:** deliver typed payloads to subscribers.  
**Client responsibility:** everything else.

---

## The Handler

Every trigger — inbound WhatsApp message, cron fire, Windmill callback, skill created, subtask resolved, ingest event, webhook — routes to one function:

```typescript
handleTrigger(trigger: Trigger): void
```

`handleTrigger` is non-blocking. It reads SQLite to determine what context is needed, spawns a pi agent session with JIT-constructed context and injected tools, and returns immediately. The session runs asynchronously. Concurrency is gated per trigger key (e.g. `whatsapp:+447...`), not globally — multiple independent threads run in parallel freely.

Adding a new integration means writing a new publisher that calls `handleTrigger`. It requires no knowledge of sessions, the KG, the DAG, or any other system concern.

---

## The Session Model

Every trigger produces a fresh pi SDK session. No session state is held between runs. This is the Ralph loop applied to a conversational agent: context rot is avoided by design, not managed.

```typescript
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),   // ephemeral, no file written
  tools: makeTools(db, channels, trigger),      // injected per-run
})

session.subscribe(event => {
  if (event.type === "block_reply")
    channel.send(trigger.from, event.text)      // streaming side effect
})

await session.prompt(buildContext(db, trigger)) // the ask
writeBack(db, session, runId)                   // KG merge, summary update
```

Sessions are compute. SQLite is memory. The agent never needs to remember — it reads from the substrate at the start of every run and writes back at the end.

---

## Context Construction — Three Tiers

Context is assembled JIT from SQLite before `session.prompt()` is called. Three tiers of progressive disclosure:

**Tier 0 — always injected, always tiny**  
Trigger type, sender identity, timestamp, 2–3 sentence world state summary. Fits in every session. Costs almost nothing.

**Tier 1 — JIT bootstrap, bounded**  
Last N messages for this thread, upcoming cron jobs, directly relevant KG subgraph (nodes matching trigger entities). Assembled by querying SQLite before session spawn. Target: 500–1000 tokens.

**Tier 2 — agent-pulled, lazy**  
The agent calls tools mid-run when it determines it needs depth: `kgQuery()`, `ragSearch()`, `getMessageHistory(n=50)`, `getTaskDetail(id)`. Tier 2 is pull-on-demand, not pre-injected.

The bootstrap stays lean regardless of trigger type. The agent manages its own context budget via tool calls.

---

## Memory Layers

Two complementary memory systems. Neither replaces the other.

**Knowledge Graph (KG) — SQLite**  
Structured, queryable, current. Nodes are entities (people, tasks, events, preferences, facts). Edges are relationships, scored by confidence and recency. The KG answers "what is true now." Tier 1 bootstrap pulls a relevant subgraph. The agent writes back to the KG after every run via `kgAssert()`, `kgRetract()`, `kgUpdate()`.

**RAG — MCP**  
Fuzzy, semantic, historical. The agent's existing RAG MCP server plugs in at `createAgentSession()` as a tool in the registry. No architectural change needed. RAG answers "what was said or documented before." The agent reaches into RAG via tool call when the KG doesn't have enough depth.

Over time, facts repeatedly pulled from RAG become candidates for promotion into the KG as first-class nodes. The nightly consolidation cron handles this promotion automatically.

---

## The DAG — Emergent Decomposition

The agent decomposes large asks into subtasks by emitting triggers for child runs. No orchestrator exists. The DAG resolves itself.

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES runs(id),
  scope TEXT,           -- what this run is responsible for
  status TEXT,          -- pending | running | resolved | failed | awaiting_children | awaiting_skill
  result TEXT,          -- JSON, populated on resolution
  depth INTEGER,
  created_at INTEGER
);

CREATE TABLE run_dependencies (
  run_id TEXT REFERENCES runs(id),
  depends_on TEXT REFERENCES runs(id)
);
```

When a run resolves, it checks SQLite: are all siblings resolved and all dependencies satisfied? If yes, it emits a trigger for the parent. The parent re-triggers as a synthesis run — it reads all child results from SQLite, spawns a fresh session, and synthesises.

The DAG is not pre-specified. It grows dynamically as runs execute and agents decompose. A run discovering mid-execution that a subtask is too broad decomposes it further. Depth is bounded (max configurable, default 5) to prevent runaway recursion.

Many paths are supported. A root ask can fan out to N concurrent leaves, some of which fan out further. Dependencies are expressed explicitly via `run_dependencies`. A run waits for all its declared dependencies before triggering.

---

## The Skill Loop

When an agent needs a capability it doesn't have, it calls `skillMiss()` rather than failing.

```typescript
skillMiss({ name: "invoice-parser", description: "...", requestedBy: runId })
// → SQLite INSERT into skill_requests
// → emits trigger: { type: "skill_miss", skillRequestId }
// → current run status set to: "awaiting_skill"
```

A skill builder client subscribes to `skill_miss` triggers. It runs its own pi session, writes and tests the skill, registers it in SQLite, then emits `skill_created`.

`handleTrigger` receives `skill_created`, queries SQLite for which runs were awaiting that skill, rebuilds context, and spawns a fresh session with the new skill in the tool registry. The run continues from where it conceptually left off — not literally (fresh session) but via SQLite state.

The skill builder is just another client of the bus. It could be another pi session, a Windmill flow, or a human. The bus doesn't care.

---

## Self-Improvement Loop

The agent writes back to the substrate that shapes its future sessions. This is intentional and bounded.

**Auto-approved mutations:**
- KG node/edge updates (confidence scores, new facts, retractions)
- Bootstrap tier promotion (moving frequently-needed facts from tier 2 to tier 1)
- Cron schedule tuning (adjusting job timing based on observed patterns)
- Rolling summary rewrites

**Human-gated mutations:**
- New tool definitions
- Core system prompt changes
- New external integrations

Human-gated changes land in a `pending_approvals` SQLite table. The agent notifies via WhatsApp and proceeds only after explicit confirmation. All mutations are tagged with the `runId` that produced them and are auditable via SQLite.

The nightly consolidation cron reads `session_runs` for the day, identifies patterns (repeated RAG calls for the same topic, slow bootstrap queries, frequent skill misses), and emits self-improvement actions. The substrate improves without external training.

---

## External Delegation

The agent delegates long-running or structured work to external systems (Windmill, code executors, etc.) via tool call. It does not await the result.

```typescript
windmillRun("flows/expense-reconciler", { month: "2026-03", userId })
// → fires Windmill job
// → SQLite INSERT: pending_delegations (jobId, threadId, context, runId)
// → current session ends, agent may send "on it" message
```

When the external system completes, it calls back (webhook or polled). `handleTrigger` receives `{ type: "windmill", jobId, result }`, queries `pending_delegations` for the original context, and spawns a fresh synthesis session. The process does not need to hold state between delegation and result — SQLite holds the thread.

---

## Invariants

These hold regardless of which run is executing or which trigger fired:

| Invariant | Enforcement |
|---|---|
| One run per trigger key at a time | `activeRuns` Set checked before session spawn |
| The bus knows nothing of domain | No business logic in publisher/subscriber wiring |
| State writes are idempotent | All SQLite writes are `INSERT OR REPLACE`, tagged with `runId` |
| Crash recovery is automatic | On startup: requeue `runs` with `status='running'` older than N minutes |
| Delegation results always resume | `pending_delegations` in SQLite survives process restart |
| DAG depth is bounded | `depth` checked before decompose; exceeding max flags rather than recurses |
| Human-gated mutations require explicit approval | `pending_approvals` table, notify + block until confirmed |
| SQLite in WAL mode | `PRAGMA journal_mode=WAL` — concurrent reads during writes |

---

## What the System Is Not

Not a chatbot. The agent's primary obligation is to act correctly. Sending a WhatsApp reply is one possible side effect of a run — sometimes the right output is a KG update, a new cron job, a Windmill delegation, or silence.

Not an orchestrator. No coordinator watches the DAG. Runs self-resolve by checking SQLite on completion and emitting triggers for parents.

Not coupled to any channel. WhatsApp is a publisher and a tool. Telegram, Slack, webhooks, or any future channel plugs in identically. The handler doesn't know what channel a trigger came from — it knows the payload shape.

---

## Stack Summary

| Concern | Implementation |
|---|---|
| Runtime | Bun (single process) |
| Persistence | SQLite (WAL mode) |
| Agent | pi SDK — `createAgentSession()` + `session.prompt()` |
| Session model | Fresh per trigger — `SessionManager.inMemory()` |
| Bus | EventEmitter locally / Redis pub-sub for multi-host |
| WhatsApp | Baileys in-process |
| RAG | Existing MCP server, injected as tool at session creation |
| Cron | `setInterval` loop checking SQLite for due jobs |
| Deployment | Single Docker container, single volume mount for SQLite |