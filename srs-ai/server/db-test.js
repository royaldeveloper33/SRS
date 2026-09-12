const { Client } = require("pg");

const client = new Client({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "bsc348",
  database: "srs_ai",
});

client.connect()
  .then(() => {
    console.log("✅ PostgreSQL connected successfully!");
    return client.end();
  })
  .catch((error) => {
    console.error("❌ PostgreSQL connection failed:");
    console.error(error.message);
  });