# WorkStacean

A generic message bus with plugin architecture. Signal in, agent replies.

## Current State

**Architecture:**
- Generic in-memory event bus with hierarchical topic matching (`#`, `*`)
- Plugin system: core plugins always loaded, built-in plugins opt-in
- SQLite event log captures all messages with correlation IDs

**Core Plugins:**
- `LoggerPlugin` - subscribes to `#`, writes all messages to `data/events.db`
- `CLIPlugin` - stdin reader, publishes commands to bus
- `SignalPlugin` - WebSocket listener for inbound, subscribes to `message.outbound.signal.#` for replies
- `AgentPlugin` - LLM agent using OpenAI SDK + Ollama, manages sessions per channel

**Built-in Plugins (disabled by default):**
- `EchoPlugin` - replies to inbound messages with "Echo: {content}" (enable via `ENABLED_PLUGINS=echo`)

## Quick Start

```bash
# Copy environment config
cp .env.dist .env
# Edit .env with your settings
# Start
bun run src/index.ts
# Or with debug
DEBUG=1 bun run src/index.ts
```

## CLI Commands

```
signal +1234 hello    Send message to signal number
topics                Show available topics
consumers             Show active consumers
help                  Show commands
{"topic":"..."}       Raw JSON publish
```

## Environment Variables

See `.env.dist` for full configuration.

## Topic Hierarchy

```
message.inbound.#         All inbound messages
message.inbound.signal.#  Inbound from Signal
message.outbound.#        All outbound messages
message.outbound.signal.# Outbound to Signal
command.#                 CLI commands
```

## Plugin Interface

```typescript
interface Plugin {
  name: string;
  description: string;
  capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
```

Plugins subscribe to topics and publish responses. The bus handles routing.

## Architecture Notes

- Agent subscribes to `message.inbound.#` and `command.#`
- Signal subscribes to `message.outbound.signal.#`
- Logger subscribes to `#` (everything)
- Correlation IDs link request/response pairs
- Sessions are per-channel (signal:{sender})

## File Structure

```
lib/
  bus.ts              Core EventBus with topic matching
  types.ts            Shared interfaces
  plugins/
    agent.ts          LLM agent with tool loop
    cli.ts            CLI input handler
    echo.ts           Echo test plugin
    logger.ts         SQLite event logger
    signal.ts         Signal bridge
src/
  index.ts            Plugin wiring
  *.test.ts           Tests
```
