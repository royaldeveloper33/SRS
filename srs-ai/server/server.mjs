import "dotenv/config";
import express from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is missing from .env");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const app = express();
const port = process.env.PORT || 5000;
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : "development-only-change-me");
if (!jwtSecret) throw new Error("JWT_SECRET is required in production");
let geminiTokensUsed = 0;

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (request.method === "OPTIONS") return response.sendStatus(204);
  return next();
});

const json = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signToken = (payload) => {
  const header = json({ alg: "HS256", typ: "JWT" });
  const body = json({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 });
  const signature = crypto.createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
};
const verifyToken = (token) => {
  const [header, body, signature] = String(token || "").split(".");
  if (!header || !body || !signature) throw new Error("Invalid token");
  const expected = crypto.createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ) throw new Error("Invalid token");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
};
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, created_at: user.created_at });
const authResponse = (user) => ({ user: publicUser(user), token: signToken({ sub: user.id, email: user.email }) });
const parseId = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const ownedProject = (userId, projectId) => prisma.projects.findFirst({ where: { id: projectId, user_id: userId }, select: { id: true } });
const requireAuth = (request, response, next) => {
  try {
    const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
    const payload = verifyToken(token);
    request.user = { id: Number(payload.sub), email: payload.email };
    return next();
  } catch {
    return response.status(401).json({ error: "Authentication required" });
  }
};
const handle = (fn) => (request, response, next) => Promise.resolve(fn(request, response, next)).catch((error) => {
  console.error(`Request failed: ${request.method} ${request.originalUrl}`, error);
  if (!response.headersSent) response.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to complete request" });
});
const geminiGenerate = async (prompt, { jsonResponse = false } = {}) => {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is missing. Add a free Gemini API key to server/.env, then restart the API.");
    error.statusCode = 503;
    throw error;
  }
  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const models = [...new Set([configuredModel, "gemini-3.6-flash"])];
  let response;
  let payload;
  for (const model of models) {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          ...(jsonResponse ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok) break;
    const unavailable = response.status === 404 || (response.status === 400 && /model|not available|not found/i.test(payload.error?.message || ""));
    if (!unavailable) break;
  }
  if (!response?.ok) {
    const error = new Error(payload?.error?.message || "Gemini AI request failed");
    error.statusCode = response?.status === 429 ? 429 : response?.status >= 500 ? 503 : 502;
    throw error;
  }
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) {
    const error = new Error("Gemini returned an empty response");
    error.statusCode = 502;
    throw error;
  }
  const tokens = payload.usageMetadata?.totalTokenCount || 0;
  geminiTokensUsed += tokens;
  return { text, tokens };
};
const aiError = (response, error, fallback) => { console.error(fallback, error); return response.status(error.statusCode || 500).json({ error: error.statusCode === 503 ? error.message : fallback }); };

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(currentDirectory, "public")));

app.post("/api/auth/register", handle(async (request, response) => {
  const { name, email, password } = request.body;
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || typeof password !== "string" || password.length < 8) return response.status(400).json({ error: "Name, valid email, and a password of at least 8 characters are required" });
  if (await prisma.users.findUnique({ where: { email: normalizedEmail } })) return response.status(409).json({ error: "An account already exists for this email" });
  const user = await prisma.users.create({ data: { name: name.trim(), email: normalizedEmail, password_hash: await bcrypt.hash(password, 12) } });
  return response.status(201).json(authResponse(user));
}));
app.post("/api/auth/login", handle(async (request, response) => {
  const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = request.body.password;
  if (!email || typeof password !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "A valid email and password are required" });
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user || typeof password !== "string" || !(await bcrypt.compare(password, user.password_hash))) return response.status(401).json({ error: "Incorrect email or password" });
  return response.json(authResponse(user));
}));
app.get("/api/health", (_request, response) => response.json({ message: "SRS AI API is running" }));

app.use("/api", requireAuth);
app.get("/api/me", handle(async (request, response) => response.json(publicUser(await prisma.users.findUniqueOrThrow({ where: { id: request.user.id } })))));
app.get("/api/usage", (_request, response) => {
  const limit = Number(process.env.GEMINI_TOKEN_LIMIT || 1000000);
  return response.json({ used: geminiTokensUsed, limit, remaining: Math.max(0, limit - geminiTokensUsed), model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });
});
app.patch("/api/me", handle(async (request, response) => {
  const { name, email } = request.body;
  if (typeof name !== "string" || name.trim().length < 2 || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return response.status(400).json({ error: "A valid name and email are required" });
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.users.findFirst({ where: { email: normalizedEmail, NOT: { id: request.user.id } }, select: { id: true } });
  if (existing) return response.status(409).json({ error: "That email is already in use" });
  const user = await prisma.users.update({ where: { id: request.user.id }, data: { name: name.trim(), email: normalizedEmail } });
  return response.json(publicUser(user));
}));
app.post("/api/me/password", handle(async (request, response) => {
  const { currentPassword, newPassword } = request.body;
  const user = await prisma.users.findUniqueOrThrow({ where: { id: request.user.id } });
  if (typeof newPassword !== "string" || newPassword.length < 8 || !(await bcrypt.compare(String(currentPassword || ""), user.password_hash))) return response.status(400).json({ error: "Current password is incorrect or new password is too short" });
  await prisma.users.update({ where: { id: user.id }, data: { password_hash: await bcrypt.hash(newPassword, 12) } });
  return response.json({ message: "Password changed" });
}));
app.delete("/api/me", handle(async (request, response) => {
  const projects = await prisma.projects.findMany({ where: { user_id: request.user.id }, select: { id: true } });
  const projectIds = projects.map(({ id }) => id);
  const documents = await prisma.srs_documents.findMany({ where: { project_id: { in: projectIds } }, select: { id: true } });
  await prisma.$transaction([prisma.document_exports.deleteMany({ where: { project_id: { in: projectIds } } }), prisma.clarification_questions.deleteMany({ where: { project_id: { in: projectIds } } }), prisma.srs_versions.deleteMany({ where: { srs_document_id: { in: documents.map(({ id }) => id) } } }), prisma.srs_documents.deleteMany({ where: { project_id: { in: projectIds } } }), prisma.projects.deleteMany({ where: { user_id: request.user.id } }), prisma.users.delete({ where: { id: request.user.id } })]);
  return response.status(204).end();
}));
app.get("/api/me/api-key", handle(async (request, response) => {
  const user = await prisma.users.findUniqueOrThrow({ where: { id: request.user.id }, select: { api_key_hash: true, api_key_created_at: true } });
  return response.json({ enabled: Boolean(user.api_key_hash), created_at: user.api_key_created_at });
}));
app.post("/api/me/api-key", handle(async (request, response) => {
  const key = `srs_${crypto.randomBytes(24).toString("hex")}`;
  await prisma.users.update({ where: { id: request.user.id }, data: { api_key_hash: crypto.createHash("sha256").update(key).digest("hex"), api_key_created_at: new Date() } });
  return response.status(201).json({ key });
}));

const projectSelect = { id: true, user_id: true, name: true, client_idea: true, status: true, created_at: true, updated_at: true };
app.get("/api/projects", handle(async (request, response) => {
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const status = typeof request.query.status === "string" && ["draft", "in_progress", "complete", "archived"].includes(request.query.status) ? request.query.status : undefined;
  const sort = request.query.sort === "name" ? { name: "asc" } : request.query.sort === "updated" ? { updated_at: "desc" } : { created_at: "desc" };
  return response.json(await prisma.projects.findMany({ where: { user_id: request.user.id, ...(status ? { status } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { client_idea: { contains: search, mode: "insensitive" } }] } : {}) }, orderBy: sort, select: projectSelect }));
}));
app.get("/api/users/:userId/projects", handle(async (request, response) => {
  const userId = parseId(request.params.userId);
  if (!userId || userId !== request.user.id) return response.status(403).json({ error: "You may only access your own projects" });
  return response.json(await prisma.projects.findMany({ where: { user_id: userId }, orderBy: { updated_at: "desc" }, select: projectSelect }));
}));
app.post("/api/projects", handle(async (request, response) => {
  const { name, clientIdea, template, status } = request.body;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 255 || typeof clientIdea !== "string" || !clientIdea.trim()) return response.status(400).json({ error: "Project name and software idea are required" });
  const project = await prisma.projects.create({ data: { user_id: request.user.id, name: name.trim(), client_idea: clientIdea.trim(), status: ["draft", "in_progress", "complete", "archived"].includes(status) ? status : "draft" }, select: projectSelect });
  if (template && typeof template === "object" && typeof template.content === "string") await prisma.srs_documents.create({ data: { project_id: project.id, title: template.title || "Software Requirements Specification", content: { text: template.content }, version: 1 } });
  return response.status(201).json(project);
}));
app.get("/api/projects/:projectId", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  if (!projectId) return response.status(400).json({ error: "Invalid project id" });
  const project = await prisma.projects.findFirst({ where: { id: projectId, user_id: request.user.id }, select: { ...projectSelect, clarification_questions: { select: { id: true, question: true, answer: true, created_at: true }, orderBy: { created_at: "asc" } }, srs_documents: { select: { id: true, title: true, content: true, version: true, created_at: true, updated_at: true }, orderBy: { version: "desc" } } } });
  return project ? response.json(project) : response.status(404).json({ error: "Project not found" });
}));
app.patch("/api/projects/:projectId", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" });
  const { name, clientIdea, status } = request.body;
  if (typeof name !== "string" || !name.trim() || typeof clientIdea !== "string" || !clientIdea.trim()) return response.status(400).json({ error: "Project name and software idea are required" });
  return response.json(await prisma.projects.update({ where: { id: projectId }, data: { name: name.trim(), client_idea: clientIdea.trim(), status: ["draft", "in_progress", "complete", "archived"].includes(status) ? status : undefined, updated_at: new Date() }, select: projectSelect }));
}));
app.post("/api/projects/:projectId/duplicate", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  const source = projectId && await prisma.projects.findFirst({ where: { id: projectId, user_id: request.user.id }, include: { clarification_questions: true, srs_documents: { orderBy: { version: "desc" }, take: 1 } } });
  if (!source) return response.status(404).json({ error: "Project not found" });
  const duplicate = await prisma.$transaction(async (tx) => { const copy = await tx.projects.create({ data: { user_id: request.user.id, name: `${source.name} (Copy)`, client_idea: source.client_idea, status: "draft" } }); if (source.clarification_questions.length) await tx.clarification_questions.createMany({ data: source.clarification_questions.map(({ question }) => ({ project_id: copy.id, question })) }); const doc = source.srs_documents[0]; if (doc) await tx.srs_documents.create({ data: { project_id: copy.id, title: doc.title, content: doc.content || {}, version: 1 } }); return copy; });
  return response.status(201).json(duplicate);
}));
app.delete("/api/projects/:projectId", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" });
  const documents = await prisma.srs_documents.findMany({ where: { project_id: projectId }, select: { id: true } });
  await prisma.$transaction([prisma.document_exports.deleteMany({ where: { project_id: projectId } }), prisma.clarification_questions.deleteMany({ where: { project_id: projectId } }), prisma.srs_versions.deleteMany({ where: { srs_document_id: { in: documents.map(({ id }) => id) } } }), prisma.srs_documents.deleteMany({ where: { project_id: projectId } }), prisma.projects.delete({ where: { id: projectId } })]);
  return response.status(204).end();
}));
app.get("/api/templates", (_request, response) => response.json([
  { id: "saas", name: "SaaS product", description: "A complete product requirements starter.", title: "SaaS Product Requirements", content: "# SaaS Product Requirements\n\n## Purpose\n\n## Users and roles\n\n## Functional requirements\n\n## Non-functional requirements\n\n## Acceptance criteria\n" },
  { id: "mobile", name: "Mobile application", description: "Mobile-first flows, permissions, and release criteria.", title: "Mobile Application SRS", content: "# Mobile Application SRS\n\n## Platform and device support\n\n## User journeys\n\n## Permissions\n\n## Functional requirements\n\n## Acceptance criteria\n" },
  { id: "internal", name: "Internal tool", description: "Operational workflows and admin requirements.", title: "Internal Tool SRS", content: "# Internal Tool SRS\n\n## Goals\n\n## Roles and permissions\n\n## Workflows\n\n## Reporting\n\n## Acceptance criteria\n" },
]));

const assertProject = async (request, response, projectId) => { if (!projectId || !(await ownedProject(request.user.id, projectId))) { response.status(404).json({ error: "Project not found" }); return false; } return true; };
app.get("/api/projects/:projectId/questions", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; response.json(await prisma.clarification_questions.findMany({ where: { project_id: id }, orderBy: { created_at: "asc" }, select: { id: true, project_id: true, question: true, answer: true, created_at: true } })); }));
app.post("/api/projects/:projectId/questions", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; if (typeof request.body.question !== "string" || !request.body.question.trim()) return response.status(400).json({ error: "question is required" }); response.status(201).json(await prisma.clarification_questions.create({ data: { project_id: id, question: request.body.question.trim() } })); }));
app.patch("/api/questions/:questionId", handle(async (request, response) => { const questionId = parseId(request.params.questionId); const question = questionId && await prisma.clarification_questions.findUnique({ where: { id: questionId } }); if (!question || !(await ownedProject(request.user.id, question.project_id))) return response.status(404).json({ error: "Clarification question not found" }); if (typeof request.body.answer !== "string" || !request.body.answer.trim()) return response.status(400).json({ error: "answer is required" }); response.json(await prisma.clarification_questions.update({ where: { id: questionId }, data: { answer: request.body.answer.trim() } })); }));

app.post("/api/projects/:projectId/ai/questions", handle(async (request, response) => {
  const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return;
  try { const project = await prisma.projects.findUniqueOrThrow({ where: { id }, include: { clarification_questions: { select: { question: true } } } }); const result = await geminiGenerate(`You are a senior business analyst. Generate 3 to 8 high-value clarification questions for a software project. Return only JSON in this exact shape: {"questions":["question 1","question 2"]}. Do not repeat existing questions.\n\nProject: ${project.name}\nIdea: ${project.client_idea}\nExisting questions:\n${project.clarification_questions.map(({ question }) => question).join("\n") || "None"}`, { jsonResponse: true }); const parsed = JSON.parse(result.text.replace(/^```json\s*|\s*```$/g, "").trim()); const questions = [...new Set((Array.isArray(parsed.questions) ? parsed.questions : []).filter((q) => typeof q === "string").map((q) => q.trim()).filter(Boolean))].slice(0, 8); return response.status(201).json(await prisma.$transaction(questions.map((question) => prisma.clarification_questions.create({ data: { project_id: id, question } })))); } catch (error) { return aiError(response, error, "Unable to generate AI clarification questions"); }
}));
app.post("/api/projects/:projectId/ai/srs", handle(async (request, response) => {
  const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return;
  try { const project = await prisma.projects.findUniqueOrThrow({ where: { id }, include: { clarification_questions: { orderBy: { created_at: "asc" } } } }); const result = await geminiGenerate(`You are a senior product manager, business analyst, solution architect, and delivery estimator. Write a simple, professional Software Requirements Specification in Markdown. Explain the product in plain language for the user, then give clear build instructions for developers. Include: goal, users, user features, developer notes, functional requirements, acceptance criteria, non-functional requirements, assumptions, out-of-scope items, delivery phases, estimated hours and weeks, and an estimated low/high project cost using a stated hourly-rate assumption. Label all time and cost values as estimates.\n\nProject: ${project.name}\nIdea: ${project.client_idea}\nClarification answers:\n${project.clarification_questions.map((q) => `Q: ${q.question}\nA: ${q.answer || "Not answered"}`).join("\n\n") || "None"}`); return response.status(201).json(await prisma.srs_documents.create({ data: { project_id: id, title: "Software Requirements Specification", content: { text: result.text, generatedBy: "Google Gemini", generatedAt: new Date().toISOString(), includesEstimate: true, tokens: result.tokens }, version: 1 } })); } catch (error) { return aiError(response, error, "Unable to generate AI SRS draft"); }
}));
app.post("/api/projects/:projectId/documents", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; if (typeof request.body.title !== "string" || !request.body.title.trim()) return response.status(400).json({ error: "title is required" }); return response.status(201).json(await prisma.srs_documents.create({ data: { project_id: id, title: request.body.title.trim(), content: request.body.content || {}, version: 1 } })); }));
app.patch("/api/documents/:documentId", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const existing = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId } }); if (!existing || !(await ownedProject(request.user.id, existing.project_id))) return response.status(404).json({ error: "SRS document not found" }); const version = (existing.version || 1) + 1; const document = await prisma.$transaction(async (tx) => { const updated = await tx.srs_documents.update({ where: { id: documentId }, data: { title: typeof request.body.title === "string" && request.body.title.trim() ? request.body.title.trim() : existing.title, content: request.body.content ?? existing.content, version, updated_at: new Date() } }); await tx.srs_versions.create({ data: { srs_document_id: documentId, content: updated.content || {}, version } }); return updated; }); return response.json(document); }));
app.get("/api/documents/:documentId/versions", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const doc = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId }, select: { project_id: true } }); if (!doc || !(await ownedProject(request.user.id, doc.project_id))) return response.status(404).json({ error: "SRS document not found" }); response.json(await prisma.srs_versions.findMany({ where: { srs_document_id: documentId }, orderBy: { version: "desc" } })); }));
app.post("/api/documents/:documentId/versions/:version/restore", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const version = parseId(request.params.version); const doc = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId } }); if (!doc || !(await ownedProject(request.user.id, doc.project_id))) return response.status(404).json({ error: "SRS document not found" }); const snapshot = version && await prisma.srs_versions.findFirst({ where: { srs_document_id: documentId, version } }); if (!snapshot) return response.status(404).json({ error: "Version not found" }); const nextVersion = (doc.version || 1) + 1; const restored = await prisma.$transaction(async (tx) => { const updated = await tx.srs_documents.update({ where: { id: documentId }, data: { content: snapshot.content, version: nextVersion, updated_at: new Date() } }); await tx.srs_versions.create({ data: { srs_document_id: documentId, content: snapshot.content, version: nextVersion } }); return updated; }); response.json(restored); }));

app.get("/api/projects/:projectId/exports", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; response.json(await prisma.document_exports.findMany({ where: { project_id: id }, orderBy: { created_at: "desc" } })); }));
app.get("/api/documents/:documentId/export", handle(async (request, response) => {
  const documentId = parseId(request.params.documentId); const format = String(request.query.format || "").toLowerCase(); if (!documentId || !["pdf", "docx"].includes(format)) return response.status(400).json({ error: "documentId and format (pdf or docx) are required" });
  const document = await prisma.srs_documents.findUnique({ where: { id: documentId }, include: { projects: true } }); if (!document || document.projects.user_id !== request.user.id) return response.status(404).json({ error: "SRS document not found" });
  const text = typeof document.content?.text === "string" ? document.content.text : "No SRS content available."; const filename = `${document.projects.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "srs"}-srs.${format}`; await prisma.document_exports.create({ data: { project_id: document.project_id, format, storage_url: `generated://${filename}` } }); response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (format === "pdf") { response.setHeader("Content-Type", "application/pdf"); const pdf = new PDFDocument({ margin: 54, info: { Title: document.title, Author: "SRS AI" } }); pdf.pipe(response); pdf.fontSize(20).fillColor("#192329").text(document.title); pdf.moveDown().fontSize(10).text(`Project: ${document.projects.name} | Version ${document.version || 1}`); pdf.moveDown().fontSize(10).text(text, { lineGap: 4 }); return pdf.end(); }
  const word = new Document({ sections: [{ children: [new Paragraph({ text: document.title, heading: HeadingLevel.TITLE }), new Paragraph({ text: `Project: ${document.projects.name} | Version ${document.version || 1}` }), ...text.split(/\r?\n/).map((line) => new Paragraph({ children: [new TextRun(line || " ")] }))] }] }); return response.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(await Packer.toBuffer(word));
}));

app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found" }));
app.use((error, _request, response, _next) => {
  if (error?.type === "entity.parse.failed") return response.status(400).json({ error: "Request body must contain valid JSON" });
  console.error("Unhandled server error:", error);
  return response.status(500).json({ error: "Unable to complete request" });
});

const server = app.listen(port, () => console.log(`SRS AI API running at http://localhost:${port}`));
const shutdown = async () => { await prisma.$disconnect(); server.close(() => process.exit(0)); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
