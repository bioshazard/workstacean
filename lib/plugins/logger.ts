import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../types";

export class LoggerPlugin implements Plugin {
  name = "logger";
  description = "Event log subscriber - writes all messages to SQLite";
  capabilities: string[] = ["persist", "query"];

  private db: Database | null = null;
  private subscriptionId: string | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  install(bus: EventBus): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this.db = new Database(`${this.dataDir}/events.db`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        parent_id TEXT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);

    // Migrate: add missing columns if upgrading from old schema
    const columns = this.db.query("PRAGMA table_info(events)").all() as { name: string }[];
    if (!columns.some(c => c.name === "correlation_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some(c => c.name === "parent_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN parent_id TEXT");
    }

    this.subscriptionId = bus.subscribe("#", this.name, (msg: BusMessage) => {
      if (msg.topic.startsWith("debug.")) return;
      this.log(msg);
    });
  }

  uninstall(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private log(msg: BusMessage): void {
    if (!this.db) return;
    
    this.db.run(
      "INSERT INTO events (id, correlation_id, parent_id, topic, payload, timestamp, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [msg.id, msg.correlationId, msg.parentId ?? null, msg.topic, JSON.stringify(msg), msg.timestamp, msg.topic.split(".")[0]]
    );
  }

  getEvents(limit: number = 100): BusMessage[] {
    if (!this.db) return [];
    
    const rows = this.db.query("SELECT payload FROM events ORDER BY timestamp DESC LIMIT ?").all(limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  getEventsByTopic(topic: string, limit: number = 100): BusMessage[] {
    if (!this.db) return [];
    
    const rows = this.db.query(
      "SELECT payload FROM events WHERE topic LIKE ? ORDER BY timestamp DESC LIMIT ?"
    ).all(`${topic}%`, limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  getEventsByCorrelationId(correlationId: string): BusMessage[] {
    if (!this.db) return [];
    
    const rows = this.db.query(
      "SELECT payload FROM events WHERE correlation_id = ? ORDER BY timestamp ASC"
    ).all(correlationId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
}