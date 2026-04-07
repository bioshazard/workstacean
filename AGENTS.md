This project uses Bun

## Runtime

Active test bed runs via `docker-compose.yml` (dev target). Source is mounted from host.

- **Workspace volume** → `/workspace` — agent-writable filesystem (memory/, plugins/)
- **Data volume** → `/data` — sessions, events.db (SQLite), cron YAMLs
- **Source mount** → `/usr/src/app` — live-reloads via `bun run --watch`

## Architecture

Single-process event bus (`lib/bus.ts`) with MQTT-style topic matching.
Clients in `lib/clients/` subscribe to bus topics and do all domain logic.
Session strategy: Ralph (fresh per trigger, JIT context from event log).
Storage: SQLite WAL mode for events, YAML files for cron schedules.

## Search

You have access to search at https://searxng.lab1.bios.dev/search?q=
