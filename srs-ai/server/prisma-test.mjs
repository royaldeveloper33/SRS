import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is missing from .env");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

try {
  const users = await prisma.users.findMany({
    select: { id: true, name: true, email: true, created_at: true },
  });
  console.table(users);
} catch (error) {
  console.error("Prisma query failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
