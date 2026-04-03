import { Database } from "bun:sqlite";
const db = new Database("./data/events.db");

console.log("=== ACTIVE SCHEDULED TASKS ===\n");

const allSchedules = db.query(`
  SELECT * FROM events 
  WHERE topic = 'command.schedule'
  ORDER BY timestamp DESC
`).all();

const firedCrons = new Set();
const firedEvents = db.query(`
  SELECT topic FROM events 
  WHERE topic LIKE 'cron.%'
`).all();
for (const e of firedEvents) {
  firedCrons.add(e.topic);
}

for (const event of allSchedules) {
  const payload = JSON.parse(event.payload);
  if (payload.action !== 'add') continue;
  
  const hasFired = firedCrons.has(payload.topic);
  
  console.log(`📅 ${payload.id}`);
  console.log(`   Type: ${payload.type}`);
  console.log(`   Schedule: ${payload.schedule}`);
  console.log(`   Topic: ${payload.topic}`);
  console.log(`   Content: ${payload.payload.content}`);
  console.log(`   Channel: ${payload.payload.channel || 'cli (default)'}`);
  console.log(`   Status: ${hasFired ? '✅ FIRED' : '⏳ PENDING'}`);
  console.log();
}
