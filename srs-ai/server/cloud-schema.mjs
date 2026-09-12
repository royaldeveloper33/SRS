import "dotenv/config";
import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  api_key_hash TEXT,
  api_key_created_at TIMESTAMP(6),
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  client_idea TEXT NOT NULL,
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
  ,status VARCHAR(30) NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS clarification_questions (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  question TEXT NOT NULL,
  answer TEXT,
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS srs_documents (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title VARCHAR(255) NOT NULL,
  content JSONB,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS srs_versions (
  id SERIAL PRIMARY KEY,
  srs_document_id INTEGER NOT NULL REFERENCES srs_documents(id) ON DELETE CASCADE,
  content JSONB,
  version INTEGER NOT NULL,
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_exports (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format VARCHAR(10) NOT NULL CHECK (format IN ('pdf', 'docx')),
  storage_url TEXT NOT NULL,
  created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects(user_id);
CREATE INDEX IF NOT EXISTS clarification_questions_project_id_idx ON clarification_questions(project_id);
CREATE INDEX IF NOT EXISTS srs_documents_project_id_idx ON srs_documents(project_id);
CREATE INDEX IF NOT EXISTS srs_versions_document_id_idx ON srs_versions(srs_document_id);
CREATE INDEX IF NOT EXISTS document_exports_project_id_idx ON document_exports(project_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMP(6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_otp_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_otp_expires_at TIMESTAMP(6);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'draft';
`;

try {
  await client.connect();
  await client.query(schemaSql);
  console.log("SRS AI cloud database tables are ready.");
} finally {
  await client.end();
}
