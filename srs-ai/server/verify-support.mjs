import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

try {
  await client.connect();

  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name IN ('support_tickets', 'support_replies')
    ORDER BY table_name;
  `);

  console.log("Support tables found:");
  console.table(result.rows);
} catch (error) {
  console.error("Database verification failed:", error.message);
} finally {
  await client.end();
}