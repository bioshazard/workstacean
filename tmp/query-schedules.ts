import { Database } from "bun:sqlite";
const db = new Database("./data/events.db");

console.log("All scheduled tasks (command.schedule with action=add):");
const schedules = db.query(`
  SELECT * FROM events 
  WHERE topic = 'command.schedule' 
  ORDER BY timestamp DESC
`).all();

for (const event of schedules) {
  const payload = JSON.parse(event.payload);
  if (payload.action === "add") {
    console.log(`\n📅 ${payload.id}`);
    console.log(`   Type: ${payload.type}`);
    console.log(`   Schedule: ${payload.schedule}`);
    console.log(`   Topic: ${payload.topic}`);
    console.log(`   Content: ${payload.payload.content}`);
    console.log(`   Channel: ${payload.payload.channel || 'not set'}`);
  }
}
