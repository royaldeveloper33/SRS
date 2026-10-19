import "dotenv/config";
import express from "express";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
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
const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  created_at: user.created_at,
  last_login_at: user.last_login_at,
  profile_image: user.profile_image || ""
});const authResponse = (user) => ({ user: publicUser(user), token: signToken({ sub: user.id, email: user.email }) });
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
const configuredModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const models = [...new Set([configuredModel, "gemini-3.6-flash"])];
  let response;
  let payload;
  for (const model of models) {
response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {      method: "POST",
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
const sendOtpEmail = async (email, code) => {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) { const error = new Error("Email verification is not configured. Add RESEND_API_KEY and EMAIL_FROM to server/.env."); error.statusCode = 503; throw error; }
  const sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: "Your SRS AI verification code", html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px"><h1 style="color:#192329">Verify your email</h1><p>Use this code to finish creating your SRS AI account:</p><div style="margin:24px 0;padding:18px;background:#e5f7ef;color:#087859;font-size:28px;font-weight:700;letter-spacing:8px;text-align:center">${code}</div><p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p></div>` }) });
  if (!sent.ok) { const detail = await sent.json().catch(() => ({})); const error = new Error(detail.message || "Unable to send verification email"); error.statusCode = 502; throw error; }
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(currentDirectory, "public")));

app.post("/api/auth/register", handle(async (request, response) => {
  const { name, email, password } = request.body; const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || typeof password !== "string" || password.length < 8) return response.status(400).json({ error: "Name, valid email, and a password of at least 8 characters are required" });
  if (await prisma.users.findUnique({ where: { email: normalizedEmail } })) return response.status(409).json({ error: "An account already exists for this email" });
  const code = String(crypto.randomInt(100000, 1000000)); const user = await prisma.users.create({ data: { name: name.trim(), email: normalizedEmail, password_hash: await bcrypt.hash(password, 12), email_verified: false, email_otp_hash: crypto.createHash("sha256").update(code).digest("hex"), email_otp_expires_at: new Date(Date.now() + 10 * 60 * 1000) } });
  try { await sendOtpEmail(user.email, code); } catch (error) { await prisma.users.delete({ where: { id: user.id } }); throw error; }
  return response.status(201).json({ requiresVerification: true, email: user.email });
}));
app.post("/api/auth/verify-email", handle(async (request, response) => {
  const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : ""; const code = String(request.body.code || ""); const user = await prisma.users.findUnique({ where: { email } });
  if (!user || user.email_verified || !user.email_otp_expires_at || user.email_otp_expires_at < new Date() || crypto.createHash("sha256").update(code).digest("hex") !== user.email_otp_hash) return response.status(400).json({ error: "Invalid or expired verification code" });
  const verified = await prisma.users.update({ where: { id: user.id }, data: { email_verified: true, email_otp_hash: null, email_otp_expires_at: null, last_login_at: new Date() } }); return response.json(authResponse(verified));
}));
app.post("/api/auth/login", handle(async (request, response) => {
  const email = typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = request.body.password;
if (!email || typeof password !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: "A valid email and password are required" });  const user = await prisma.users.findUnique({ where: { email } });
  if (!user || typeof password !== "string" || !(await bcrypt.compare(password, user.password_hash))) return response.status(401).json({ error: "Incorrect email or password" });
  if (!user.email_verified) return response.status(403).json({ error: "Verify your email before signing in" });
  return response.json(authResponse(await prisma.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } })));
}));
app.post("/api/auth/google", handle(async (request, response) => {
  const { credential } = request.body;

  if (typeof credential !== "string" || !credential) {
    return response.status(400).json({
      error: "Google credential is required"
    });
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID
  });

  const payload = ticket.getPayload();

  if (!payload?.sub || !payload?.email || !payload.email_verified) {
    return response.status(401).json({
      error: "Invalid Google account"
    });
  }

  const googleId = payload.sub;
  const email = payload.email.trim().toLowerCase();
  const name = payload.name || email.split("@")[0];

  let user = await prisma.users.findUnique({
    where: { google_id: googleId }
  });

  if (!user) {
    user = await prisma.users.findUnique({
      where: { email }
    });
  }

  if (user) {
    user = await prisma.users.update({
      where: { id: user.id },
      data: {
        google_id: googleId,
        email_verified: true,
        last_login_at: new Date()
      }
    });
  } else {
    const randomPassword = crypto.randomBytes(32).toString("hex");

    user = await prisma.users.create({
      data: {
        name,
        email,
        password_hash: await bcrypt.hash(randomPassword, 12),
        google_id: googleId,
        email_verified: true,
        last_login_at: new Date()
      }
    });
  }

  return response.json(authResponse(user));
}));
app.get("/api/health", (_request, response) => response.json({ message: "SRS AI API is running" }));

app.use("/api", requireAuth);
app.get("/api/me", handle(async (request, response) => response.json(publicUser(await prisma.users.findUniqueOrThrow({ where: { id: request.user.id } })))));
app.get("/api/dashboard/stats", handle(async (request, response) => {
  const [statuses, exported] = await Promise.all([
    prisma.projects.groupBy({ by: ["status"], where: { user_id: request.user.id }, _count: { _all: true } }),
    prisma.document_exports.count({ where: { projects: { user_id: request.user.id } } })
  ]);
  const count = (status) => statuses.find((item) => item.status === status)?._count._all || 0;
  response.json({ total: statuses.reduce((sum, item) => sum + item._count._all, 0), draft: count("draft"), completed: count("complete"), exported });
}));
app.get("/api/usage", (_request, response) => {
  const limit = Number(process.env.GEMINI_TOKEN_LIMIT || 1000000);
  return response.json({ used: geminiTokensUsed, limit, remaining: Math.max(0, limit - geminiTokensUsed), model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });
});
app.patch("/api/me", handle(async (request, response) => {
const { name, email, profile_image } = request.body;
  if (typeof name !== "string" || name.trim().length < 2 || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return response.status(400).json({ error: "A valid name and email are required" });
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.users.findFirst({ where: { email: normalizedEmail, NOT: { id: request.user.id } }, select: { id: true } });
  if (existing) return response.status(409).json({ error: "That email is already in use" });
  const user = await prisma.users.update({ where: { id: request.user.id }, data: {
  name: name.trim(),
  email: normalizedEmail,
  profile_image: typeof profile_image === "string" ? profile_image : undefined
} });
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
app.post("/api/feedback", handle(async (request, response) => { const message = typeof request.body.message === "string" ? request.body.message.trim() : ""; if (message.length < 5 || message.length > 2000) return response.status(400).json({ error: "Feedback must be between 5 and 2,000 characters" }); await prisma.feedback.create({ data: { user_id: request.user.id, message } }); response.status(201).json({ message: "Thank you for your feedback." }); }));

const projectSelect = {
  id: true,
  user_id: true,
  name: true,
  client_idea: true,
  status: true,
  created_at: true,
  updated_at: true,
<<<<<<< HEAD
};const projectActivity = (projectId, action, detail) => prisma.project_activities.create({ data: { project_id: projectId, action, detail } });
app.get("/api/projects", handle(async (request, response) => {
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const status = typeof request.query.status === "string" && ["draft", "in_progress", "complete", "archived"].includes(request.query.status) ? request.query.status : undefined;
const sort = request.query.sort === "name"
  ? { name: "asc" }
  : request.query.sort === "updated"
    ? { updated_at: "desc" }
    : { created_at: "desc" };  return response.json(await prisma.projects.findMany({ where: { user_id: request.user.id, ...(status ? { status } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { client_idea: { contains: search, mode: "insensitive" } }] } : {}) }, orderBy: sort, select: projectSelect }));
=======
};
const projectActivity = (projectId, action, detail) => prisma.project_activities.create({ data: { project_id: projectId, action, detail } });
app.get("/api/projects", handle(async (request, response) => {
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const status = typeof request.query.status === "string" && ["draft", "in_progress", "complete", "archived"].includes(request.query.status) ? request.query.status : undefined;
  const allowedSortFields = [
  "name",
  "created_at",
  "updated_at",
  "status",
  "progress"
];

const requestedSort = request.query.sort;

const sort = allowedSortFields.includes(requestedSort)
  ? { [requestedSort]: "asc" }
  : { created_at: "desc" };
  return response.json(await prisma.projects.findMany({ where: { user_id: request.user.id, ...(status ? { status } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { client_idea: { contains: search, mode: "insensitive" } }] } : {}) }, orderBy: sort, select: projectSelect }));
>>>>>>> 2ef5ad7bdd63dec7aac632e14190c4e109350a8a
}));
app.get("/api/users/:userId/projects", handle(async (request, response) => {
  const userId = parseId(request.params.userId);
  if (!userId || userId !== request.user.id) return response.status(403).json({ error: "You may only access your own projects" });
  return response.json(await prisma.projects.findMany({ where: { user_id: userId }, orderBy: { updated_at: "desc" }, select: projectSelect }));
}));
app.post("/api/projects", handle(async (request, response) => {
  const { name, clientIdea, template, status, client_name, deadline, notes, color, icon } = request.body;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 255 || typeof clientIdea !== "string" || !clientIdea.trim()) return response.status(400).json({ error: "Project name and software idea are required" });
  const project = await prisma.projects.create({ data: { user_id: request.user.id, name: name.trim(), client_idea: clientIdea.trim(), status: ["draft", "in_progress", "complete", "archived"].includes(status) ? status : "draft", client_name: typeof client_name === "string" ? client_name.trim().slice(0, 150) || null : null, deadline: typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? new Date(`${deadline}T00:00:00.000Z`) : null, notes: typeof notes === "string" ? notes.trim() || null : null, color: typeof color === "string" ? color.slice(0, 20) : null, icon: typeof icon === "string" ? icon.slice(0, 10) : null }, select: projectSelect });
  await projectActivity(project.id, "created", "Project created");
  await prisma.clarification_questions.createMany({ data: [
    { project_id: project.id, question: "Who are the main users of this system?", answer_type: "multiple_choice", choices: ["Customers", "Internal team", "Administrators", "All of these"] },
    { project_id: project.id, question: "Does the application need login and role-based access?", answer_type: "yes_no", choices: ["Yes", "No"] },
    { project_id: project.id, question: "What is the most important outcome for the first release?", answer_type: "text" },
    { project_id: project.id, question: "Will this project handle personal, payment, or other sensitive data?", answer_type: "yes_no", choices: ["Yes", "No"] }
  ] });
  await projectActivity(project.id, "questions_created", "Starter discovery questions added");
  if (template && typeof template === "object" && typeof template.content === "string") await prisma.srs_documents.create({ data: { project_id: project.id, title: template.title || "Software Requirements Specification", content: { text: template.content }, version: 1 } });
  return response.status(201).json(project);
}));
app.get("/api/projects/:projectId", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  if (!projectId) return response.status(400).json({ error: "Invalid project id" });
  const project = await prisma.projects.findFirst({ where: { id: projectId, user_id: request.user.id }, select: { ...projectSelect, clarification_questions: { select: { id: true, question: true, answer: true, answer_type: true, choices: true, selected_choices: true, created_at: true }, orderBy: { created_at: "asc" } }, project_requirements: { select: { id: true, code: true, title: true, description: true, type: true, priority: true, status: true, acceptance_criteria: true, created_at: true, updated_at: true }, orderBy: { created_at: "asc" } }, srs_documents: { select: { id: true, title: true, content: true, version: true, created_at: true, updated_at: true }, orderBy: { version: "desc" } } } });
  return project ? response.json(project) : response.status(404).json({ error: "Project not found" });
}));
app.patch("/api/projects/:projectId", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" });
  const { name, clientIdea, status, client_name, deadline, notes, color, icon, is_favorite } = request.body;
  if (typeof name !== "string" || !name.trim() || typeof clientIdea !== "string" || !clientIdea.trim()) return response.status(400).json({ error: "Project name and software idea are required" });
  const project = await prisma.projects.update({ where: { id: projectId }, data: { name: name.trim(), client_idea: clientIdea.trim(), status: ["draft", "in_progress", "complete", "archived"].includes(status) ? status : undefined, client_name: typeof client_name === "string" ? client_name.trim().slice(0, 150) || null : undefined, deadline: typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? new Date(`${deadline}T00:00:00.000Z`) : deadline === null ? null : undefined, notes: typeof notes === "string" ? notes.trim() || null : undefined, color: typeof color === "string" ? color.slice(0, 20) : undefined, icon: typeof icon === "string" ? icon.slice(0, 10) : undefined, is_favorite: typeof is_favorite === "boolean" ? is_favorite : undefined, updated_at: new Date() }, select: projectSelect });
  await projectActivity(projectId, "updated", "Project details updated");
  return response.json(project);
}));
app.post("/api/projects/:projectId/archive", handle(async (request, response) => { const projectId = parseId(request.params.projectId); if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" }); const project = await prisma.projects.update({ where: { id: projectId }, data: { status: "archived", updated_at: new Date() }, select: projectSelect }); await projectActivity(projectId, "archived", "Project archived"); response.json(project); }));
app.post("/api/projects/:projectId/favorite", handle(async (request, response) => { const projectId = parseId(request.params.projectId); if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" }); const current = await prisma.projects.findUniqueOrThrow({ where: { id: projectId }, select: { is_favorite: true } }); const project = await prisma.projects.update({ where: { id: projectId }, data: { is_favorite: !current.is_favorite, updated_at: new Date() }, select: projectSelect }); await projectActivity(projectId, project.is_favorite ? "favorited" : "unfavorited", project.is_favorite ? "Project pinned as favorite" : "Project removed from favorites"); response.json(project); }));
app.get("/api/projects/:projectId/activity", handle(async (request, response) => { const projectId = parseId(request.params.projectId); if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" }); response.json(await prisma.project_activities.findMany({ where: { project_id: projectId }, orderBy: { created_at: "desc" }, take: 15 })); }));
app.post("/api/projects/:projectId/duplicate", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);
  const source = projectId && await prisma.projects.findFirst({ where: { id: projectId, user_id: request.user.id }, include: { clarification_questions: true, srs_documents: { orderBy: { version: "desc" }, take: 1 } } });
  if (!source) return response.status(404).json({ error: "Project not found" });
  const duplicate = await prisma.$transaction(async (tx) => { const copy = await tx.projects.create({ data: { user_id: request.user.id, name: `${source.name} (Copy)`, client_idea: source.client_idea, status: "draft" } }); if (source.clarification_questions.length) await tx.clarification_questions.createMany({ data: source.clarification_questions.map(({ question }) => ({ project_id: copy.id, question })) }); const doc = source.srs_documents[0]; if (doc) await tx.srs_documents.create({ data: { project_id: copy.id, title: doc.title, content: doc.content || {}, version: 1 } }); return copy; });
  return response.status(201).json(duplicate);
}));
app.get("/api/projects/:projectId/requirements", handle(async (request, response) => { const projectId = parseId(request.params.projectId); if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" }); response.json(await prisma.project_requirements.findMany({ where: { project_id: projectId }, orderBy: { created_at: "asc" } })); }));
app.post("/api/projects/:projectId/requirements", handle(async (request, response) => { const projectId = parseId(request.params.projectId); if (!projectId || !(await ownedProject(request.user.id, projectId))) return response.status(404).json({ error: "Project not found" }); const { title, description, type, priority, status, acceptance_criteria } = request.body; if (typeof title !== "string" || !title.trim()) return response.status(400).json({ error: "Requirement title is required" }); const count = await prisma.project_requirements.count({ where: { project_id: projectId, type: type === "Non-functional" ? "Non-functional" : "Functional" } }); const requirementType = type === "Non-functional" ? "Non-functional" : "Functional"; const code = `${requirementType === "Non-functional" ? "NFR" : "FR"}-${String(count + 1).padStart(3, "0")}`; const requirement = await prisma.project_requirements.create({ data: { project_id: projectId, code, title: title.trim(), description: typeof description === "string" ? description.trim() || null : null, type: requirementType, priority: ["Low", "Medium", "High", "Critical"].includes(priority) ? priority : "Medium", status: ["Planned", "In progress", "Completed"].includes(status) ? status : "Planned", acceptance_criteria: typeof acceptance_criteria === "string" ? acceptance_criteria.trim() || null : null } }); await projectActivity(projectId, "requirement_added", `Added ${requirement.code}: ${requirement.title}`); response.status(201).json(requirement); }));
app.patch("/api/requirements/:requirementId", handle(async (request, response) => { const requirementId = parseId(request.params.requirementId); const existing = requirementId && await prisma.project_requirements.findUnique({ where: { id: requirementId } }); if (!existing || !(await ownedProject(request.user.id, existing.project_id))) return response.status(404).json({ error: "Requirement not found" }); const { title, description, priority, status, acceptance_criteria } = request.body; const requirement = await prisma.project_requirements.update({ where: { id: requirementId }, data: { title: typeof title === "string" && title.trim() ? title.trim() : undefined, description: typeof description === "string" ? description.trim() || null : undefined, priority: ["Low", "Medium", "High", "Critical"].includes(priority) ? priority : undefined, status: ["Planned", "In progress", "Completed"].includes(status) ? status : undefined, acceptance_criteria: typeof acceptance_criteria === "string" ? acceptance_criteria.trim() || null : undefined, updated_at: new Date() } }); await projectActivity(existing.project_id, "requirement_updated", `Updated ${requirement.code}`); response.json(requirement); }));
app.delete("/api/requirements/:requirementId", handle(async (request, response) => { const requirementId = parseId(request.params.requirementId); const existing = requirementId && await prisma.project_requirements.findUnique({ where: { id: requirementId } }); if (!existing || !(await ownedProject(request.user.id, existing.project_id))) return response.status(404).json({ error: "Requirement not found" }); await prisma.project_requirements.delete({ where: { id: requirementId } }); await projectActivity(existing.project_id, "requirement_deleted", `Removed ${existing.code}`); response.status(204).end(); }));
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
app.get("/api/projects/:projectId/questions", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; response.json(await prisma.clarification_questions.findMany({ where: { project_id: id }, orderBy: { created_at: "asc" }, select: { id: true, project_id: true, question: true, answer: true, answer_type: true, choices: true, selected_choices: true, created_at: true } })); }));
app.post("/api/projects/:projectId/questions", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; const { question, answer_type, choices } = request.body; if (typeof question !== "string" || !question.trim()) return response.status(400).json({ error: "question is required" }); const type = ["text", "yes_no", "multiple_choice"].includes(answer_type) ? answer_type : "text"; const cleanChoices = Array.isArray(choices) ? choices.filter((choice) => typeof choice === "string").map((choice) => choice.trim()).filter(Boolean).slice(0, 8) : []; response.status(201).json(await prisma.clarification_questions.create({ data: { project_id: id, question: question.trim(), answer_type: type, choices: cleanChoices.length ? cleanChoices : undefined } })); }));
app.patch("/api/questions/:questionId", handle(async (request, response) => { const questionId = parseId(request.params.questionId); const question = questionId && await prisma.clarification_questions.findUnique({ where: { id: questionId } }); if (!question || !(await ownedProject(request.user.id, question.project_id))) return response.status(404).json({ error: "Clarification question not found" }); const selected = Array.isArray(request.body.selected_choices) ? request.body.selected_choices.filter((choice) => typeof choice === "string").map((choice) => choice.trim()).filter(Boolean).slice(0, 8) : []; const answer = typeof request.body.answer === "string" ? request.body.answer.trim() : selected.join(", "); if (!answer) return response.status(400).json({ error: "answer is required" }); response.json(await prisma.clarification_questions.update({ where: { id: questionId }, data: { answer, selected_choices: selected.length ? selected : undefined } })); }));

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
app.post("/api/documents/:documentId/share", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const document = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId }, include: { projects: true } }); if (!document || document.projects.user_id !== request.user.id) return response.status(404).json({ error: "SRS document not found" }); const shareToken = crypto.randomBytes(18).toString("hex"); const content = { ...(document.content || {}), shareToken, sharedAt: new Date().toISOString() }; await prisma.srs_documents.update({ where: { id: documentId }, data: { content, updated_at: new Date() } }); response.json({ token: shareToken, url: `${request.protocol}://${request.get("host")}/api/shared/${shareToken}` }); }));
app.get("/api/shared/:token", handle(async (request, response) => { const token = String(request.params.token || ""); const document = await prisma.srs_documents.findFirst({ where: { content: { path: ["shareToken"], equals: token } }, include: { projects: true } }); if (!document) return response.status(404).type("text/html").send("<h1>Shared SRS not found</h1>"); const clean = (value) => String(value || "").replace(/[<>&\"]/g, ""); const title = clean(document.title); const body = clean(document.content?.text || "No document content."); response.type("text/html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f5faf7;color:#192329;font:16px system-ui;line-height:1.65}main{max-width:880px;margin:48px auto;padding:40px;background:#fff;border-radius:18px;box-shadow:0 12px 45px #1232}header{border-bottom:1px solid #dcebe4;padding-bottom:20px;margin-bottom:28px}small{color:#087859;font-weight:700;letter-spacing:1px}h1{margin:8px 0;font-size:32px}pre{white-space:pre-wrap;font:inherit}</style></head><body><main><header><small>SHARED SOFTWARE REQUIREMENTS</small><h1>${title}</h1><div>Project: ${clean(document.projects.name)} · Version ${document.version || 1}</div></header><pre>${body}</pre></main></body></html>`); }));
app.get("/api/documents/:documentId/versions", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const doc = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId }, select: { project_id: true } }); if (!doc || !(await ownedProject(request.user.id, doc.project_id))) return response.status(404).json({ error: "SRS document not found" }); response.json(await prisma.srs_versions.findMany({ where: { srs_document_id: documentId }, orderBy: { version: "desc" } })); }));
app.post("/api/documents/:documentId/versions/:version/restore", handle(async (request, response) => { const documentId = parseId(request.params.documentId); const version = parseId(request.params.version); const doc = documentId && await prisma.srs_documents.findUnique({ where: { id: documentId } }); if (!doc || !(await ownedProject(request.user.id, doc.project_id))) return response.status(404).json({ error: "SRS document not found" }); const snapshot = version && await prisma.srs_versions.findFirst({ where: { srs_document_id: documentId, version } }); if (!snapshot) return response.status(404).json({ error: "Version not found" }); const nextVersion = (doc.version || 1) + 1; const restored = await prisma.$transaction(async (tx) => { const updated = await tx.srs_documents.update({ where: { id: documentId }, data: { content: snapshot.content, version: nextVersion, updated_at: new Date() } }); await tx.srs_versions.create({ data: { srs_document_id: documentId, content: snapshot.content, version: nextVersion } }); return updated; }); response.json(restored); }));

app.get("/api/projects/:projectId/exports", handle(async (request, response) => { const id = parseId(request.params.projectId); if (!(await assertProject(request, response, id))) return; response.json(await prisma.document_exports.findMany({ where: { project_id: id }, orderBy: { created_at: "desc" } })); }));
app.get("/api/documents/:documentId/export", handle(async (request, response) => {
  const documentId = parseId(request.params.documentId); const format = String(request.query.format || "").toLowerCase(); if (!documentId || !["pdf", "docx"].includes(format)) return response.status(400).json({ error: "documentId and format (pdf or docx) are required" });
  const document = await prisma.srs_documents.findUnique({ where: { id: documentId }, include: { projects: true } }); if (!document || document.projects.user_id !== request.user.id) return response.status(404).json({ error: "SRS document not found" });
  const text = typeof document.content?.text === "string" ? document.content.text : "No SRS content available."; const filename = `${document.projects.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "srs"}-srs.${format}`; await prisma.document_exports.create({ data: { project_id: document.project_id, format, storage_url: `generated://${filename}` } }); response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
if (format === "pdf") {
  response.setHeader("Content-Type", "application/pdf");

  const pdf = new PDFDocument({
  size: "A4",
  margins: {
    top: 68,
    bottom: 62,
    left: 54,
    right: 54
  },
  bufferPages: true,
  autoFirstPage: true,
  info: {
    Title: document.title,
    Author: "SRS AI",
    Subject: "Software Requirements Specification"
  }
});

  pdf.pipe(response);

  const NAVY = "#17142F";
const PURPLE = "#39256F";
const LIGHT_PURPLE = "#EEEAFB";
const TEXT = "#28263D";
const MUTED = "#77758D";
const BORDER = "#DED7EB";

const ACCENT = "#8B5CF6";
const WHITE = "#FFFFFF";
const SOFT_BACKGROUND = "#F8F7FC";
const CARD_BACKGROUND = "#F1EDFA";

  const pageWidth = pdf.page.width;
  const pageHeight = pdf.page.height;
  const left = 54;
  const right = pageWidth - 54;
  const width = right - left;

  const projectName = document.projects.name || "SRS Project";
  const version = document.version || 1;
  const date = new Date().toLocaleDateString("en-GB");

  // Basic Markdown cleanup for headings, bold text and lists.
  function cleanMarkdown(value = "") {
    return String(value)
      .replace(/\r/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/__(.*?)__/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/_(.*?)_/g, "$1")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/^\s*\d+\.\s+/gm, "• ")
      .replace(/^---+\s*$/gm, "");
  }

  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n");

  const sections = [];
  let currentSection = { title: "Introduction", lines: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^#\s+/.test(line)) {
      if (
        currentSection.lines.length ||
        currentSection.title !== "Introduction"
      ) {
        sections.push(currentSection);
      }

      currentSection = {
        title: cleanMarkdown(line.replace(/^#\s+/, "")),
        lines: []
      };
    } else {
      currentSection.lines.push(rawLine);
    }
  }

  if (currentSection.lines.length || sections.length === 0) {
    sections.push(currentSection);
  }

  // COVER PAGE
  pdf.rect(0, 0, pageWidth, pageHeight).fill(NAVY);

  pdf.circle(pageWidth - 45, 90, 160).fill("#30245C");
  pdf.circle(35, pageHeight - 50, 170).fill("#241A49");

  pdf.roundedRect(left, 55, 44, 44, 10).fill(LIGHT_PURPLE);
  pdf.fillColor(PURPLE).font("Helvetica-Bold").fontSize(23)
    .text("S", left, 64, { width: 44, align: "center" });

  pdf.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(19)
    .text("SRS AI", left + 58, 57);

  pdf.fillColor("#CFC6EB").font("Helvetica").fontSize(9)
    .text("SOFTWARE REQUIREMENTS DOCUMENTATION", left + 58, 82);

  pdf.fillColor("#C6B5FF").font("Helvetica-Bold").fontSize(10)
    .text("SOFTWARE DOCUMENTATION", left, 220);

  pdf.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(30)
    .text("Software Requirements", left, 255, {
      width,
      lineGap: 7
    });

  pdf.fillColor("#C6B5FF").font("Helvetica-Bold").fontSize(30)
    .text("Specification (SRS)", left, 300, {
      width,
      lineGap: 7
    });

  pdf.fillColor("#DDD8EF").font("Helvetica").fontSize(12)
    .text(projectName, left, 365, { width });

  pdf.moveTo(left, 430).lineTo(right, 430)
    .strokeColor("#65558D").lineWidth(1).stroke();

  const metadata = [
    ["PROJECT", projectName],
    ["DOCUMENT VERSION", `Version ${version}`],
    ["GENERATED", date]
  ];

  let metaY = 455;

  for (const [label, value] of metadata) {
    pdf.fillColor("#BDB1DF").font("Helvetica-Bold").fontSize(8)
      .text(label, left, metaY);

    pdf.fillColor("#FFFFFF").font("Helvetica").fontSize(11)
      .text(value, left, metaY + 15, { width });

    metaY += 48;
  }

  pdf.fillColor("#CFC6EB").font("Helvetica").fontSize(8)
    .text("SRS AI  •  SOFTWARE REQUIREMENTS", left, pageHeight - 55);

  // TABLE OF CONTENTS
  pdf.addPage({ size: "A4", margins: { top: 58, bottom: 55, left: 54, right: 54 } });

  pdf.fillColor(PURPLE).font("Helvetica-Bold").fontSize(10)
    .text("SRS AI  /  DOCUMENTATION", left, 35);

  pdf.fillColor(NAVY).font("Helvetica-Bold").fontSize(25)
    .text("Table of Contents", left, 78);

  pdf.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text("Document structure and sections", left, 115);

  let tocY = 160;
  const tocItems = [];

  sections.forEach((section, index) => {
    const title = section.title || `Section ${index + 1}`;

    if (tocY > pageHeight - 85) {
      pdf.addPage();
      tocY = 65;
    }

    pdf.circle(left + 13, tocY + 10, 12).fill(PURPLE);

    pdf.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9)
      .text(String(index + 1), left + 5, tocY + 5, {
        width: 16,
        align: "center"
      });

    pdf.fillColor(NAVY).font("Helvetica-Bold").fontSize(10)
      .text(title, left + 38, tocY + 4, {
        width: width - 45,
        ellipsis: true
      });

    const titleWidth = pdf.widthOfString(title);
    const dotsStart = Math.min(left + 40 + titleWidth, right - 100);

    pdf.save();
    pdf.strokeColor(BORDER).lineWidth(0.5);
    for (let x = dotsStart; x < right - 55; x += 5) {
      pdf.circle(x, tocY + 12, 0.7).fill(BORDER);
    }
    pdf.restore();

    tocItems.push({
  index,
  title,
  page: null,
  tocPage: pdf.bufferedPageRange().start +
    pdf.bufferedPageRange().count - 1,
  tocY
});

    tocY += 35;
  });

 // CONTENT PAGES

for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {

  const section = sections[sectionIndex];

  // Record the physical page number where this section begins.
  const pageRangeBefore = pdf.bufferedPageRange();
  tocItems[sectionIndex].page =
    pageRangeBefore.start + pageRangeBefore.count + 1;

  pdf.addPage({
      size: "A4",
      margins: { top: 68, bottom: 58, left: 54, right: 54 }
    });

   let y = 65;

pdf.rect(0, 0, pageWidth, pageHeight)
  .fill(SOFT_BACKGROUND);

pdf.rect(0, 0, pageWidth, 7)
  .fill(PURPLE);

  function ensureSpace(height = 35) {
  if (y + height > pageHeight - 60) {
    pdf.addPage();
    pdf.rect(0, 0, pageWidth, pageHeight)
      .fill(SOFT_BACKGROUND);

    pdf.rect(0, 0, pageWidth, 7)
      .fill(PURPLE);

    y = 65;

    pdf.fillColor(PURPLE)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("SRS AI  /  SOFTWARE REQUIREMENTS", left, 35);
  }
}

    pdf.fillColor(PURPLE).font("Helvetica-Bold").fontSize(9)
      .text("SRS AI  /  SOFTWARE REQUIREMENTS", left, 35);

    pdf.circle(left + 15, y + 12, 14).fill(PURPLE);

    pdf.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(10)
      .text(String(sectionIndex + 1), left + 7, y + 7, {
        width: 16,
        align: "center"
      });

    pdf.fillColor(NAVY).font("Helvetica-Bold").fontSize(19)
      .text(section.title || `Section ${sectionIndex + 1}`, left + 40, y + 2, {
        width: width - 40
      });

    y += 48;

    for (const rawLine of section.lines) {
      const trimmed = rawLine.trim();

      if (!trimmed || /^---+$/.test(trimmed)) {
        y += 7;
        continue;
      }

      if (/^#{2,6}\s+/.test(trimmed)) {
        const heading = cleanMarkdown(trimmed);

        ensureSpace(48);

       pdf.fillColor(PURPLE)
  .font("Helvetica-Bold")
  .fontSize(14)
  .text(heading, left, y, {
    width,
    lineGap: 4
  });

y = pdf.y + 10;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quote = cleanMarkdown(trimmed.replace(/^>\s?/, ""));

        const quoteHeight = pdf.heightOfString(quote, {
          width: width - 30,
          font: "Helvetica",
          fontSize: 10
        }) + 18;

        ensureSpace(quoteHeight + 8);

        pdf.roundedRect(left, y, width, quoteHeight, 5)
          .fill(LIGHT_PURPLE);

        pdf.rect(left, y, 4, quoteHeight).fill(PURPLE);

        pdf.fillColor(TEXT).font("Helvetica").fontSize(10)
          .text(quote, left + 15, y + 9, {
            width: width - 30,
            lineGap: 3
          });

        y += quoteHeight + 10;
        continue;
      }

      const bullet = /^\s*([-*+]|\d+\.)\s+/.test(trimmed);
      const paragraph = cleanMarkdown(trimmed);

      const fontSize = 10;
      const paragraphX = bullet ? left + 18 : left;
      const paragraphWidth = bullet ? width - 18 : width;

      const paragraphHeight = pdf.heightOfString(paragraph, {
        width: paragraphWidth,
        font: "Helvetica",
        fontSize,
        lineGap: 3
      });

      ensureSpace(paragraphHeight + 12);

      if (bullet) {
        pdf.circle(left + 5, y + 6, 2).fill(PURPLE);
      }

      pdf.fillColor(TEXT).font("Helvetica").fontSize(fontSize)
        .text(paragraph, paragraphX, y, {
          width: paragraphWidth,
          lineGap: 3
        });

      y = pdf.y + 9;
    }
  }
// Fill in the actual starting page numbers in the Table of Contents.
for (const item of tocItems) {
  if (item.page === null) continue;

  pdf.switchToPage(item.tocPage);

  pdf.fillColor(SOFT_BACKGROUND)
    .rect(right - 42, item.tocY + 1, 35, 20)
    .fill();

  pdf.fillColor(PURPLE)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(String(item.page), right - 42, item.tocY + 5, {
      width: 30,
      align: "right"
    });
}

// Return to the last page before adding footers.
pdf.switchToPage(pdf.bufferedPageRange().count - 1);
  // Add consistent footers and page numbers to every page except the cover.
  const pageRange = pdf.bufferedPageRange();

  for (let i = 1; i < pageRange.count; i++) {
    pdf.switchToPage(i);

    pdf.moveTo(left, pageHeight - 42)
      .lineTo(right, pageHeight - 42)
      .strokeColor(BORDER).lineWidth(0.5).stroke();

    pdf.fillColor(MUTED).font("Helvetica").fontSize(8)
      .text("SRS AI  •  SOFTWARE REQUIREMENTS", left, pageHeight - 30);

    pdf.fillColor(PURPLE).font("Helvetica-Bold").fontSize(8)
      .text(`Page ${i + 1} of ${pageRange.count}`, left, pageHeight - 30, {
        width,
        align: "right"
      });
  }

  return pdf.end();
}  const paragraphs = text.split(/\r?\n/).map((line) => /^#{1,3}\s+/.test(line) ? new Paragraph({ text: line.replace(/^#+\s*/, ""), heading: line.startsWith("# ") ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2 }) : new Paragraph({ children: [new TextRun({ text: line || " ", size: 21 })] })); const word = new Document({ sections: [{ children: [new Paragraph({ text: document.title, heading: HeadingLevel.TITLE }), new Paragraph({ children: [new TextRun({ text: `Project: ${document.projects.name} | Version ${document.version || 1}`, color: "087859", bold: true, size: 20 })] }), new Paragraph(" "), ...paragraphs] }] }); return response.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(await Packer.toBuffer(word));
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
