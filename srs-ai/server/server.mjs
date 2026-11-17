import cron from "node-cron";
import "dotenv/config";
import express from "express";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { Readable } from "node:stream";

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  Footer,
  Header,
  PageNumber,
  TableOfContents,
  PageBreak,
  ShadingType,
  WidthType
} from "docx";import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const googleOAuthClient = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar.events"
];
const TOKEN_ENCRYPTION_KEY = Buffer.from(
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "",
  "hex"
);

if (TOKEN_ENCRYPTION_KEY.length !== 32) {
  throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key");
}
const encryptGoogleToken = (token) => {
  if (!token) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    TOKEN_ENCRYPTION_KEY,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
};

const decryptGoogleToken = (encryptedToken) => {
  if (!encryptedToken) return null;

  const [ivHex, authTagHex, encryptedHex] = encryptedToken.split(":");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    TOKEN_ENCRYPTION_KEY,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
};
const createGoogleOAuthState = (userId) => {
  const payload = Buffer.from(JSON.stringify({
    userId,
    nonce: crypto.randomBytes(16).toString("hex"),
    expiresAt: Date.now() + 10 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", TOKEN_ENCRYPTION_KEY)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
};

const verifyGoogleOAuthState = (state) => {
  try {
    const [payload, signature] = state.split(".");

    if (!payload || !signature) return null;

    const expectedSignature = crypto
      .createHmac("sha256", TOKEN_ENCRYPTION_KEY)
      .update(payload)
      .digest();

    const receivedSignature = Buffer.from(signature, "base64url");

    if (
      receivedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      return null;
    }

    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!Number.isInteger(data.userId) || data.expiresAt < Date.now()) {
      return null;
    }

    return data.userId;
  } catch {
    return null;
  }
};
const getGoogleDriveClient = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      google_access_token: true,
      google_refresh_token: true,
      google_token_expiry: true
    }
  });

  if (!user?.google_access_token) {
    throw new Error("Google account is not connected");
  }

  if (!user.google_refresh_token) {
    throw new Error("Google refresh token is missing. Reconnect your Google account.");
  }

  const oauthClient = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauthClient.setCredentials({
    access_token: decryptGoogleToken(user.google_access_token),
    refresh_token: decryptGoogleToken(user.google_refresh_token),
    expiry_date: user.google_token_expiry
      ? new Date(user.google_token_expiry).getTime()
      : 0
  });

  await oauthClient.getAccessToken();

  const refreshedTokens = oauthClient.credentials;

  if (refreshedTokens.access_token) {
    await prisma.users.update({
      where: { id: userId },
      data: {
        google_access_token: encryptGoogleToken(refreshedTokens.access_token),
        google_token_expiry: refreshedTokens.expiry_date
          ? new Date(refreshedTokens.expiry_date)
          : user.google_token_expiry
      }
    });
  }

  return google.drive({
    version: "v3",
    auth: oauthClient
  });
};
const getGoogleCalendarClient = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      google_access_token: true,
      google_refresh_token: true,
      google_token_expiry: true
    }
  });

  if (!user?.google_access_token) {
    throw new Error("Google account is not connected");
  }

  if (!user.google_refresh_token) {
    throw new Error("Google refresh token is missing. Reconnect your Google account.");
  }

  const oauthClient = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauthClient.setCredentials({
    access_token: decryptGoogleToken(user.google_access_token),
    refresh_token: decryptGoogleToken(user.google_refresh_token),
    expiry_date: user.google_token_expiry
      ? new Date(user.google_token_expiry).getTime()
      : 0
  });

  await oauthClient.getAccessToken();

  const refreshedTokens = oauthClient.credentials;

  if (refreshedTokens.access_token) {
    await prisma.users.update({
      where: { id: userId },
      data: {
        google_access_token: encryptGoogleToken(refreshedTokens.access_token),
        google_token_expiry: refreshedTokens.expiry_date
          ? new Date(refreshedTokens.expiry_date)
          : user.google_token_expiry
      }
    });
  }

  return google.calendar({
    version: "v3",
    auth: oauthClient
  });
};
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
};const publicUser = (user) => ({
  id: user.id,

  name: user.name,
  email: user.email,
  created_at: user.created_at,
  last_login_at: user.last_login_at,
  profile_image: user.profile_image || "",
  google_email: user.google_email || "",
  google_connected: Boolean(user.google_email)
});
const authResponse = (user) => ({ user: publicUser(user), token: signToken({ sub: user.id, email: user.email }) });
const parseId = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const ownedProject = (userId, projectId) => prisma.projects.findFirst({ where: { id: projectId, user_id: userId }, select: { id: true } });
const requireAuth = async (request, response, next) => {
  let payload;

  try {
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";

    payload = verifyToken(token);
  } catch {
    return response.status(401).json({
      error: "Authentication required"
    });
  }

  const user = await prisma.users.findUnique({
    where: { id: Number(payload.sub) },
    select: {
      id: true,
      email: true,
      is_active: true
    }
  });

  if (!user) {
    return response.status(401).json({
      error: "Authentication required"
    });
  }

  if (!user.is_active) {
    return response.status(403).json({
      error: "Your account has been deactivated."
    });
  }

  request.user = {
    id: user.id,
    email: user.email
  };

  return next();
};
  const requireAdmin = (request, response, next) => {
  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const userEmail = String(request.user.email || "").trim().toLowerCase();

  if (!adminEmail || userEmail !== adminEmail) {
    return response.status(403).json({ error: "Admin access required" });
  }

  return next();
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

app.use(express.json({ limit: "5mb" }));
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
  if (!user || typeof password !== "string" || !(await bcrypt.compare(password, user.password_hash))) return r
  if (!user.is_active) {
  return response.status(403).json({
    error: "Your account has been deactivated. Please contact support."
  });
}
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
app.get("/api/google/callback", handle(async (request, response) => {
  const { code, state, error } = request.query;

  if (error) {
    return response.status(400).json({
      error: `Google authorization failed: ${error}`
    });
  }

  if (typeof code !== "string" || typeof state !== "string") {
    return response.status(400).json({
      error: "Missing Google authorization code or state"
    });
  }

  // Verify signed OAuth state
  const userId = verifyGoogleOAuthState(state);

  if (!userId) {
    return response.status(401).json({
      error: "Invalid or expired Google authorization state"
    });
  }

  // Confirm the SRS AI user exists
  const user = await prisma.users.findUnique({
    where: { id: userId }
  });

  if (!user) {
    return response.status(404).json({
      error: "SRS AI user not found"
    });
  }

  // Exchange authorization code for Google tokens
  const { tokens } = await googleOAuthClient.getToken(code);

  if (!tokens.access_token) {
    return response.status(400).json({
      error: "Google access token was not received"
    });
  }

  googleOAuthClient.setCredentials(tokens);

  // Retrieve connected Google account email
  const oauth2 = google.oauth2({
    version: "v2",
    auth: googleOAuthClient
  });

  const profile = await oauth2.userinfo.get();

  const googleEmail = profile.data.email;

  if (!googleEmail) {
    return response.status(400).json({
      error: "Unable to retrieve Google account email"
    });
  }

  // Preserve an existing refresh token if Google does not return a new one
  const encryptedRefreshToken = tokens.refresh_token
    ? encryptGoogleToken(tokens.refresh_token)
    : user.google_refresh_token;

  // Store encrypted tokens
  await prisma.users.update({
    where: { id: userId },
    data: {
      google_access_token: encryptGoogleToken(tokens.access_token),
      google_refresh_token: encryptedRefreshToken,
      google_token_expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null,
      google_email: googleEmail
    }
  });

  return response.redirect(
  "http://localhost:5173/?google_connected=true"
);
}));

app.use("/api", requireAuth);
// Google OAuth callback — must be before requireAuth middleware
app.get("/api/google/connect", (request, response) => {
  const state = createGoogleOAuthState(request.user.id);

  const authorizationUrl = googleOAuthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state
  });

  return response.json({ authorizationUrl });
});
app.post("/api/google/disconnect", handle(async (request, response) => {
  const user = await prisma.users.findUnique({
    where: { id: request.user.id },
    select: {
      google_access_token: true,
      google_refresh_token: true
    }
  });

  if (!user) {
    return response.status(404).json({ error: "User not found" });
  }

  // Revoke the Google refresh token if available.
  if (user.google_refresh_token) {
    try {
      const refreshToken = decryptGoogleToken(user.google_refresh_token);

      await googleOAuthClient.revokeToken(refreshToken);
    } catch (error) {
      console.error("Google token revocation failed:", error.message);
    }
  }

  // Clear the stored Google connection.
  await prisma.users.update({
    where: { id: request.user.id },
    data: {
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
      google_email: null
    }
  });

  return response.json({
    success: true,
    message: "Google account disconnected successfully"
  });
}));
// Help & Support API routes
app.post("/api/support/tickets", handle(async (request, response) => {
 const { subject, category, priority, description } = request.body;

  if (
    typeof subject !== "string" ||
    subject.trim().length < 3 ||
    subject.trim().length > 255
  ) {
    return response.status(400).json({
      error: "Subject must be between 3 and 255 characters"
    });
  }

  if (
    typeof category !== "string" ||
    category.trim().length < 2 ||
    category.trim().length > 100
  ) {
    return response.status(400).json({
      error: "Please provide a valid category"
    });
  }
    if (
    typeof category !== "string" ||
    category.trim().length < 2 ||
    category.trim().length > 100
  ) {
    return response.status(400).json({
      error: "Please provide a valid category"
    });
  }

  // ADD HERE
  if (!["Low", "Medium", "High", "Urgent"].includes(priority)) {
    return response.status(400).json({
      error: "Please provide a valid priority"
    });
  }

  if (
    typeof description !== "string" ||
    description.trim().length < 10 ||
    description.trim().length > 5000
  ) {
    return response.status(400).json({
      error: "Description must be between 10 and 5,000 characters"
    });
  }

  const ticket = await prisma.support_tickets.create({
   data: {
  user_id: request.user.id,
  subject: subject.trim(),
  category: category.trim(),
  priority,
  description: description.trim()
}
  });

  return response.status(201).json({
    message: "Support ticket created successfully",
    ticket
  });
}));
app.get("/api/support/tickets", handle(async (request, response) => {
  const tickets = await prisma.support_tickets.findMany({
    where: {
      user_id: request.user.id
    },
    orderBy: {
      created_at: "desc"
    }
  });

  return response.json({ tickets });
}));
app.get("/api/support/tickets/:id", handle(async (request, response) => {
  const ticketId = parseId(request.params.id);

  if (!ticketId) {
    return response.status(400).json({ error: "Invalid ticket ID" });
  }

  const ticket = await prisma.support_tickets.findFirst({
    where: {
      id: ticketId,
      user_id: request.user.id
    },
    include: {
      replies: {
        orderBy: {
          created_at: "asc"
        }
      }
    }
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found" });
  }

  return response.json({ ticket });
}));
app.post("/api/support/tickets/:id/replies", handle(async (request, response) => {
  const ticketId = parseId(request.params.id);
  const message = typeof request.body.message === "string"
    ? request.body.message.trim()
    : "";

  if (!ticketId) {
    return response.status(400).json({ error: "Invalid ticket ID" });
  }

  if (message.length < 2 || message.length > 5000) {
    return response.status(400).json({
      error: "Reply must be between 2 and 5,000 characters"
    });
  }

  const ticket = await prisma.support_tickets.findFirst({
    where: {
      id: ticketId,
      user_id: request.user.id
    }
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found" });
  }

  const reply = await prisma.support_replies.create({
    data: {
      ticket_id: ticketId,
      user_id: request.user.id,
      sender_type: "user",
      message
    }
  });

  await prisma.support_tickets.update({
    where: { id: ticketId },
    data: { updated_at: new Date() }
  });

  return response.status(201).json({
    message: "Reply submitted successfully",
    reply
  });
}));
app.get("/api/admin/support/tickets", requireAdmin, handle(async (request, response) => {
  const tickets = await prisma.support_tickets.findMany({
    include: {
      users: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    },
    orderBy: {
      created_at: "desc"
    }
  });

  return response.json({ tickets });
}));
app.get("/api/admin/support/tickets/:id", requireAdmin, handle(async (request, response) => {
  const ticketId = parseId(request.params.id);

  if (!ticketId) {
    return response.status(400).json({ error: "Invalid ticket ID" });
  }

  const ticket = await prisma.support_tickets.findUnique({
    where: { id: ticketId },
    include: {
      users: {
        select: {
          id: true,
          name: true,
          email: true
        }
      },
      replies: {
        orderBy: {
          created_at: "asc"
        }
      }
    }
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found" });
  }

  return response.json({ ticket });
}));
app.post("/api/admin/support/tickets/:id/replies", requireAdmin, handle(async (request, response) => {
  const ticketId = parseId(request.params.id);
  const message = typeof request.body.message === "string"
    ? request.body.message.trim()
    : "";

  if (!ticketId) {
    return response.status(400).json({ error: "Invalid ticket ID" });
  }

  if (message.length < 2 || message.length > 5000) {
    return response.status(400).json({
      error: "Reply must be between 2 and 5,000 characters"
    });
  }

  const ticket = await prisma.support_tickets.findUnique({
    where: { id: ticketId }
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found" });
  }

  const reply = await prisma.support_replies.create({
    data: {
      ticket_id: ticketId,
      user_id: request.user.id,
      sender_type: "admin",
      message
    }
  });

  await prisma.support_tickets.update({
    where: { id: ticketId },
    data: { updated_at: new Date() }
  });

  return response.status(201).json({
    message: "Admin reply submitted successfully",
    reply
  });
}));
app.get("/api/admin/dashboard/stats",requireAdmin, handle(async (request, response) => {
  const [
    totalUsers,
    totalProjects,
    totalDocuments,
    totalTickets,
    openTickets
  ] = await Promise.all([
    prisma.users.count(),
    prisma.projects.count(),
    prisma.srs_documents.count(),
    prisma.support_tickets.count(),
    prisma.support_tickets.count({
      where: {
        status: {
          in: ["Pending", "In Progress"]
        }
      }
    })
  ]);

  return response.json({
    totalUsers,
    totalProjects,
    totalDocuments,
    totalTickets,
    openTickets
  });
}));
app.get("/api/admin/users", requireAdmin, handle(async (request, response) => {
  const users = await prisma.users.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      created_at: true,
      last_login_at: true,
      is_active: true
    },
    orderBy: {
      created_at: "desc"
    }
  });

  return response.json({ users });
}));
app.get("/api/admin/projects", requireAdmin, handle(async (request, response) => {
  const projects = await prisma.projects.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      progress: true,
      deadline: true,
      created_at: true,
      updated_at: true,
      project_type: true,
      users: {
        select: {
          id: true,
          name: true,
          email: true
        }
      },
      _count: {
        select: {
          srs_documents: true
        }
      }
    },
    orderBy: {
      created_at: "desc"
    }
  });

  return response.json({ projects });
}));
app.get("/api/admin/projects/:projectId", requireAdmin, handle(async (request, response) => {
  const projectId = Number(request.params.projectId);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    return response.status(400).json({
      error: "Invalid project ID"
    });
  }

  const project = await prisma.projects.findUnique({
    where: {
      id: projectId
    },
    select: {
      id: true,
      name: true,
      client_idea: true,
      client_name: true,
      project_type: true,
      target_users: true,
      technologies: true,
      notes: true,
      status: true,
      progress: true,
      deadline: true,
      created_at: true,
      updated_at: true,
      users: {
        select: {
          name: true,
          email: true
        }
      },
      srs_documents: {
        select: {
          id: true,
          title: true,
          version: true,
          created_at: true
        }
      }
    }
  });

  if (!project) {
    return response.status(404).json({
      error: "Project not found"
    });
  }

  return response.json({ project });
}));
app.get("/api/admin/documents", requireAdmin, handle(async (request, response) => {
  const documents = await prisma.srs_documents.findMany({
    select: {
      id: true,
      title: true,
      version: true,
      created_at: true,
      updated_at: true,
      projects: {
        select: {
          id: true,
          name: true,
          users: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      }
    },
    orderBy: {
      created_at: "desc"
    }
  });

  return response.json({ documents });
}));
app.get("/api/admin/documents/:documentId", requireAdmin, handle(async (request, response) => {
  const documentId = Number(request.params.documentId);

  if (!Number.isInteger(documentId) || documentId <= 0) {
    return response.status(400).json({ error: "Invalid document ID" });
  }

  const document = await prisma.srs_documents.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      content: true,
      version: true,
      created_at: true,
      updated_at: true,
      projects: {
        select: {
          id: true,
          name: true,
          users: {
            select: {
              name: true,
              email: true
            }
          }
        }
      }
    }
  });

  if (!document) {
    return response.status(404).json({ error: "Document not found" });
  }

  return response.json({ document });
}));
app.get("/api/admin/users/:userId", requireAdmin, handle(async (request, response) => {
  const userId = Number(request.params.userId);

  if (!Number.isInteger(userId) || userId <= 0) {
    return response.status(400).json({ error: "Invalid user ID" });
  }

  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      created_at: true,
      last_login_at: true,
      is_active: true,
      projects: {
        select: {
          id: true,
          name: true,
          status: true,
          created_at: true,
          srs_documents: {
            select: {
              id: true,
              title: true,
              created_at: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    return response.status(404).json({ error: "User not found" });
  }

  const totalDocuments = user.projects.reduce(
    (total, project) => total + project.srs_documents.length,
    0
  );

  return response.json({
    user: {
      ...user,
      totalProjects: user.projects.length,
      totalDocuments
    }
  });
}));
app.patch("/api/admin/users/:userId/status", requireAdmin, handle(async (request, response) => {
  const userId = Number(request.params.userId);
  const isActive = request.body.is_active;

  if (!Number.isInteger(userId) || userId <= 0) {
    return response.status(400).json({ error: "Invalid user ID" });
  }

  if (typeof isActive !== "boolean") {
    return response.status(400).json({ error: "Valid account status is required" });
  }

  if (userId === request.user.id && !isActive) {
    return response.status(400).json({ error: "You cannot deactivate your own account" });
  }

  const user = await prisma.users.update({
    where: { id: userId },
    data: { is_active: isActive },
    select: {
      id: true,
      name: true,
      email: true,
      is_active: true
    }
  });

  return response.json({ user });
}));
app.patch("/api/admin/support/tickets/:id", requireAdmin, handle(async (request, response) => {
  const ticketId = parseId(request.params.id);
  const { status, priority } = request.body;

  if (!ticketId) {
    return response.status(400).json({ error: "Invalid ticket ID" });
  }

const allowedStatuses = ["Pending", "In Progress", "Resolved", "Closed"];
const allowedPriorities = ["Low", "Medium", "High", "Urgent"];

  if (status !== undefined && !allowedStatuses.includes(status)) {
    return response.status(400).json({ error: "Invalid ticket status" });
  }

  if (priority !== undefined && !allowedPriorities.includes(priority)) {
    return response.status(400).json({ error: "Invalid ticket priority" });
  }

  if (status === undefined && priority === undefined) {
    return response.status(400).json({
      error: "Provide a status or priority to update"
    });
  }

  const ticket = await prisma.support_tickets.findUnique({
    where: { id: ticketId }
  });

  if (!ticket) {
    return response.status(404).json({ error: "Ticket not found" });
  }

  const updatedTicket = await prisma.support_tickets.update({
    where: { id: ticketId },
    data: {
      ...(status !== undefined && { status }),
      ...(priority !== undefined && { priority }),
      updated_at: new Date()
    }
  });

  return response.json({
    message: "Ticket updated successfully",
    ticket: updatedTicket
  });
}));
// Notifications API
app.get("/api/notifications", handle(async (request, response) => {
  const notifications = await prisma.notifications.findMany({
    where: {
      user_id: request.user.id
    },
    orderBy: {
      created_at: "desc"
    },
    take: 100
  });

  const unreadCount = await prisma.notifications.count({
    where: {
      user_id: request.user.id,
      is_read: false
    }
  });

  return response.json({
    notifications,
    unreadCount
  });
}));
// Mark a notification as read
app.patch("/api/notifications/:id/read", handle(async (request, response) => {
  const notificationId = Number(request.params.id);

  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return response.status(400).json({
      error: "Invalid notification ID"
    });
  }

  const result = await prisma.notifications.updateMany({
    where: {
      id: notificationId,
      user_id: request.user.id
    },
    data: {
      is_read: true
    }
  });

  if (result.count === 0) {
    return response.status(404).json({
      error: "Notification not found"
    });
  }

  return response.json({
    message: "Notification marked as read"
  });
}));
// Mark all notifications as read
app.patch("/api/notifications/read-all", handle(async (request, response) => {
  const result = await prisma.notifications.updateMany({
    where: {
      user_id: request.user.id,
      is_read: false
    },
    data: {
      is_read: true
    }
  });

  return response.json({
    message: "All notifications marked as read",
    updatedCount: result.count
  });
}));
// Delete a notification
app.delete("/api/notifications/:id", handle(async (request, response) => {
  const notificationId = Number(request.params.id);

  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return response.status(400).json({
      error: "Invalid notification ID"
    });
  }

  const result = await prisma.notifications.deleteMany({
    where: {
      id: notificationId,
      user_id: request.user.id
    }
  });

  if (result.count === 0) {
    return response.status(404).json({
      error: "Notification not found"
    });
  }

  return response.json({
    message: "Notification deleted successfully"
  });
}));
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
  client_name: true,
  status: true,
  deadline: true,
  notes: true,
  color: true,
  icon: true,
  is_favorite: true,
  google_calendar_event_id: true,
  created_at: true,
  updated_at: true,
};const projectActivity = (projectId, action, detail) => prisma.project_activities.create({ data: { project_id: projectId, action, detail } });
app.get("/api/projects", handle(async (request, response) => {
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const status = typeof request.query.status === "string" && ["draft", "in_progress", "complete", "archived"].includes(request.query.status) ? request.query.status : undefined;
const sort = request.query.sort === "name"
  ? { name: "asc" }
  : request.query.sort === "updated"
    ? { updated_at: "desc" }
    : { created_at: "desc" };  return response.json(await prisma.projects.findMany({ where: { user_id: request.user.id, ...(status ? { status } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { client_idea: { contains: search, mode: "insensitive" } }] } : {}) }, orderBy: sort, select: projectSelect }));
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
  await prisma.notifications.create({
  data: {
    user_id: request.user.id,
    title: "New project created",
    message: `Your project "${project.name}" has been created successfully.`,
    type: "project_created"
  }
});
  await prisma.clarification_questions.createMany({ data: [
    { project_id: project.id, question: "Who are the main users of this system?", answer_type: "multiple_choice", choices: ["Customers", "Internal team", "Administrators", "All of these"] },
    { project_id: project.id, question: "Does the application need login and role-based access?", answer_type: "yes_no", choices: ["Yes", "No"] },
    { project_id: project.id, question: "What is the most important outcome for the first release?", answer_type: "text" },
    { project_id: project.id, question: "Will this project handle personal, payment, or other sensitive data?", answer_type: "yes_no", choices: ["Yes", "No"] }
  ] });
  await projectActivity(project.id, "questions_created", "Starter discovery questions added");
if (template && typeof template === "object" && typeof template.content === "string") {
  await prisma.srs_documents.create({
    data: {
      project_id: project.id,
      title: template.title || "Software Requirements Specification",
      content: { text: template.content },
      version: 1
    }
  });

  await prisma.notifications.create({
    data: {
      user_id: request.user.id,
      title: "SRS document generated",
      message: `Your SRS document for "${project.name}" has been generated successfully.`,
      type: "srs_generated"
    }
  });
}
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
  const previousProject = await prisma.projects.findUnique({
  where: { id: projectId },
  select: { status: true }
});
  const { name, clientIdea, status, client_name, deadline, notes, color, icon, is_favorite } = request.body;
  console.log("Project update received:", request.body);
  if (typeof name !== "string" || !name.trim() || typeof clientIdea !== "string" || !clientIdea.trim()) return response.status(400).json({ error: "Project name and software idea are required" });
  const project = await prisma.projects.update({ where: { id: projectId }, data: { name: name.trim(), client_idea: clientIdea.trim(), status: ["draft", "in_progress", "complete", "archived"].includes(status) ? status : undefined, client_name: typeof client_name === "string" ? client_name.trim().slice(0, 150) || null : undefined, deadline: deadline === null || deadline === "" 
  ? null 
  : typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? new Date(`${deadline}T00:00:00.000Z`)
    : undefined, notes: typeof notes === "string" ? notes.trim() || null : undefined, color: typeof color === "string" ? color.slice(0, 20) : undefined, icon: typeof icon === "string" ? icon.slice(0, 10) : undefined, is_favorite: typeof is_favorite === "boolean" ? is_favorite : undefined, updated_at: new Date() }, select: projectSelect });
  await projectActivity(projectId, "updated", "Project details updated");
  console.log("Project saved:", {
  name: project.name,
  status: project.status,
  client_name: project.client_name,
  deadline: project.deadline
});
  const isCompleted =
  previousProject.status !== "complete" && project.status === "complete";

await prisma.notifications.create({
  data: {
    user_id: request.user.id,
    title: isCompleted ? "Project completed" : "Project updated",
    message: isCompleted
      ? `Your project "${project.name}" has been completed.`
      : `Your project "${project.name}" has been updated.`,
    type: isCompleted ? "project_completed" : "project_updated"
  }
});
  return response.json(project);
}));
app.post("/api/projects/:projectId/calendar", handle(async (request, response) => {
  const projectId = parseId(request.params.projectId);

  const project = await prisma.projects.findFirst({
    where: {
      id: projectId,
      user_id: request.user.id
    }
  });

  if (!project) {
    return response.status(404).json({
      error: "Project not found"
    });
  }

  if (!project.deadline) {
    return response.status(400).json({
      error: "Add a project deadline before syncing with Google Calendar."
    });
  }

  const calendar = await getGoogleCalendarClient(request.user.id);

  const startDate = new Date(project.deadline)
    .toISOString()
    .slice(0, 10);

  const endDate = new Date(`${startDate}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);

  const eventData = {
    summary: `Project Deadline: ${project.name}`,
    description: project.notes || project.client_idea,
    start: { date: startDate },
    end: { date: endDate.toISOString().slice(0, 10) }
  };

  let event;

  if (project.google_calendar_event_id) {
    event = await calendar.events.update({
      calendarId: "primary",
      eventId: project.google_calendar_event_id,
      requestBody: eventData
    });
  } else {
    event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: eventData
    });

    await prisma.projects.update({
      where: { id: projectId },
      data: {
        google_calendar_event_id: event.data.id
      }
    });
  }

 console.log("Google Calendar event created:", {
  id: event.data.id,
  htmlLink: event.data.htmlLink
});

return response.json({
  success: true,
  message: "Project deadline synced with Google Calendar.",
  event: {
    id: event.data.id,
    htmlLink: event.data.htmlLink
  }
});
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
  try { const project = await prisma.projects.findUniqueOrThrow({ where: { id }, include: { clarification_questions: { orderBy: { created_at: "asc" } } } }); const result = await geminiGenerate(`You are a senior product manager, business analyst, solution architect, and delivery estimator. Write a simple, professional Software Requirements Specification in Markdown. Explain the product in plain language for the user, then give clear build instructions for developers. Include: goal, users, user features, developer notes, functional requirements, acceptance criteria, non-functional requirements, assumptions, out-of-scope items, delivery phases, estimated hours and weeks, and an estimated low/high project cost using a stated hourly-rate assumption. Label all time and cost values as estimates.\n\nProject: ${project.name}\nIdea: ${project.client_idea}\nClarification answers:\n${project.clarification_questions.map((q) => `Q: ${q.question}\nA: ${q.answer || "Not answered"}`).join("\n\n") || "None"}`); const document = await prisma.srs_documents.create({
  data: {
    project_id: id,
    title: "Software Requirements Specification",
    content: {
      text: result.text,
      generatedBy: "Google Gemini",
      generatedAt: new Date().toISOString(),
      includesEstimate: true,
      tokens: result.tokens
    },
    version: 1
  }
});

await prisma.notifications.create({
  data: {
    user_id: request.user.id,
    title: "SRS document generated",
    message: `Your SRS document for "${project.name}" has been generated successfully.`,
    type: "srs_generated"
  }
});

return response.status(201).json(document); } catch (error) { return aiError(response, error, "Unable to generate AI SRS draft"); }
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

const pdfChunks = [];

pdf.on("data", (chunk) => {
  pdfChunks.push(chunk);
});

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

const pdfBuffer = await new Promise((resolve, reject) => {
  pdf.on("end", () => resolve(Buffer.concat(pdfChunks)));
  pdf.on("error", reject);
  pdf.end();
});
if (request.query.destination === "drive") {
  const drive = await getGoogleDriveClient(request.user.id);

  const uploadedFile = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: "application/pdf"
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer)
    },
    fields: "id, name, webViewLink"
  });

  return response.json({
    success: true,
    message: "PDF exported to Google Drive successfully",
    file: uploadedFile.data
  });
}

return response
  .type("application/pdf")
  .send(pdfBuffer);
}
const NAVY = "17142F";
const PURPLE = "39256F";
const LIGHT_PURPLE = "EEEAFB";
const TEXT = "28263D";
const MUTED = "77758D";
const BORDER = "DED7EB";
const WHITE = "FFFFFF";

const projectName = document.projects.name || "SRS Project";
const version = document.version || 1;
const date = new Date().toLocaleDateString("en-GB");

// Split the SRS content into sections.
const lines = String(text || "").replace(/\r/g, "").split("\n");

const sections = [];
let currentSection = {
  title: "Introduction",
  lines: []
};

for (const rawLine of lines) {
  const line = rawLine.trim();

  if (/^#\s+/.test(line)) {
    if (currentSection.lines.length) {
      sections.push(currentSection);
    }

    currentSection = {
      title: line.replace(/^#\s+/, ""),
      lines: []
    };
  } else {
    currentSection.lines.push(rawLine);
  }
}

if (currentSection.lines.length || sections.length === 0) {
  sections.push(currentSection);
}

// Markdown cleanup.
const cleanMarkdown = (value = "") =>
  String(value)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.*?)~~/g, "$1");

// Header.
const header = new Header({
  children: [
    new Paragraph({
      children: [
        new TextRun({
          text: "SRS AI  /  SOFTWARE REQUIREMENTS",
          bold: true,
          color: PURPLE,
          size: 18
        })
      ],
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 4,
          color: BORDER
        }
      },
      spacing: { after: 150 }
    })
  ]
});

// Footer.
const footer = new Footer({
  children: [
    new Paragraph({
      alignment: AlignmentType.BOTH,
      border: {
        top: {
          style: BorderStyle.SINGLE,
          size: 4,
          color: BORDER
        }
      },
      children: [
        new TextRun({
          text: "SRS AI  •  SOFTWARE REQUIREMENTS",
          color: MUTED,
          size: 16
        }),
        new TextRun({
          text: "\tPage ",
          color: PURPLE,
          bold: true,
          size: 16
        }),
        new TextRun({
          children: [PageNumber.CURRENT],
          color: PURPLE,
          bold: true,
          size: 16
        }),
        new TextRun({
          text: " of ",
          color: PURPLE,
          size: 16
        }),
        new TextRun({
          children: [PageNumber.TOTAL_PAGES],
          color: PURPLE,
          size: 16
        })
      ],
      tabStops: [
        {
          type: "right",
          position: 9000
        }
      ]
    })
  ]
});

// Cover page.
const children = [
  new Paragraph({
    spacing: { before: 1800, after: 250 },
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: "SRS AI",
        bold: true,
        color: PURPLE,
        size: 48
      })
    ]
  }),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 500 },
    children: [
      new TextRun({
        text: "SOFTWARE REQUIREMENTS SPECIFICATION",
        bold: true,
        color: MUTED,
        size: 20
      })
    ]
  }),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 700, after: 300 },
    children: [
      new TextRun({
        text: document.title,
        bold: true,
        color: NAVY,
        size: 36
      })
    ]
  }),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 500 },
    children: [
      new TextRun({
        text: projectName,
        color: PURPLE,
        bold: true,
        size: 25
      })
    ]
  }),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 150 },
    children: [
      new TextRun({
        text: `VERSION ${version}`,
        bold: true,
        color: MUTED,
        size: 20
      })
    ]
  }),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: `Generated: ${date}`,
        color: MUTED,
        size: 18
      })
    ]
  }),

  new Paragraph({
    children: [new PageBreak()]
  }),

  // Table of Contents.
  new Paragraph({
    spacing: { after: 200 },
    children: [
      new TextRun({
        text: "SRS AI  /  DOCUMENTATION",
        bold: true,
        color: PURPLE,
        size: 18
      })
    ]
  }),

  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 150 },
    children: [
      new TextRun({
        text: "Table of Contents",
        bold: true,
        color: NAVY,
        size: 34
      })
    ]
  }),

  new Paragraph({
    spacing: { after: 300 },
    children: [
      new TextRun({
        text: "Document structure and sections",
        color: MUTED,
        size: 18
      })
    ]
  }),

  new TableOfContents("Table of Contents", {
    hyperlink: true,
    headingStyleRange: "1-2"
  }),

  new Paragraph({
    children: [new PageBreak()]
  })
];

// Content pages.
sections.forEach((section, sectionIndex) => {
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: {
        before: 250,
        after: 250
      },
      shading: {
        type: ShadingType.CLEAR,
        fill: LIGHT_PURPLE
      },
      children: [
        new TextRun({
          text: `${sectionIndex + 1}.  ${cleanMarkdown(section.title)}`,
          bold: true,
          color: NAVY,
          size: 30
        })
      ]
    })
  );

  for (const rawLine of section.lines) {
    const trimmed = rawLine.trim();

    if (!trimmed || /^---+$/.test(trimmed)) {
      continue;
    }

    // Subheadings.
    if (/^#{2,6}\s+/.test(trimmed)) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: {
            before: 250,
            after: 120
          },
          children: [
            new TextRun({
              text: cleanMarkdown(trimmed),
              bold: true,
              color: PURPLE,
              size: 25
            })
          ]
        })
      );

      continue;
    }

    // Quotes.
    if (/^>\s?/.test(trimmed)) {
      children.push(
        new Paragraph({
          indent: {
            left: 300,
            right: 200
          },
          spacing: {
            before: 120,
            after: 180
          },
          shading: {
            type: ShadingType.CLEAR,
            fill: LIGHT_PURPLE
          },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: 18,
              color: PURPLE
            }
          },
          children: [
            new TextRun({
              text: cleanMarkdown(trimmed.replace(/^>\s?/, "")),
              color: TEXT,
              size: 20
            })
          ]
        })
      );

      continue;
    }

    // Bullets and numbered lists.
    const bulletMatch = trimmed.match(/^([-*+]|\d+\.)\s+/);
    const paragraphText = cleanMarkdown(
      trimmed.replace(/^([-*+]|\d+\.)\s+/, "")
    );

    children.push(
      new Paragraph({
        bullet: bulletMatch ? { level: 0 } : undefined,
        spacing: {
          after: 130,
          line: 300
        },
        children: [
          new TextRun({
            text: paragraphText,
            color: TEXT,
            size: 20
          })
        ]
      })
    );
  }
});

// Create Word document.
const word = new Document({
  creator: "SRS AI",
  title: document.title,
  description: "Software Requirements Specification",
  features: {
    updateFields: true
  },
  styles: {
    default: {
      document: {
        run: {
          font: "Arial",
          size: 20,
          color: TEXT
        },
        paragraph: {
          spacing: {
            after: 120,
            line: 300
          }
        }
      }
    }
  },
  sections: [
    {
      properties: {
        page: {
          size: {
            width: 11906,
            height: 16838
          },
          margin: {
            top: 1100,
            bottom: 1100,
            left: 1050,
            right: 1050
          }
        }
      },
      headers: {
        default: header
      },
      footers: {
        default: footer
      },
      children
    }
  ]
});

const wordBuffer = await Packer.toBuffer(word);

return response
  .type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  .send(wordBuffer);
}));
app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found" }));
app.use((error, _request, response, _next) => {
  if (error?.type === "entity.parse.failed") return response.status(400).json({ error: "Request body must contain valid JSON" });
  console.error("Unhandled server error:", error);
  return response.status(500).json({ error: "Unable to complete request" });
});
// Automatic project deadline reminders
cron.schedule("0 9 * * *", async () => {  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const threeDaysLater = new Date(today);
    threeDaysLater.setUTCDate(threeDaysLater.getUTCDate() + 3);

    const projects = await prisma.projects.findMany({
      where: {
        deadline: {
          gte: today,
          lte: threeDaysLater
        },
        status: {
          notIn: ["complete", "archived"]
        }
      },
      select: {
        id: true,
        user_id: true,
        name: true,
        deadline: true
      }
    });
    console.log("Checking deadline range:", today, "to", threeDaysLater);
console.log("Matching projects:", projects.length);
const allProjects = await prisma.projects.findMany({
  select: {
    id: true,
    name: true,
    status: true,
    deadline: true
  }
});

console.log("All projects in database:", allProjects);
projects.forEach((project) => {
  console.log("Project:", project.name, "Deadline:", project.deadline);
});
    for (const project of projects) {
      const deadline = project.deadline.toISOString().slice(0, 10);

      const message = `Your project "${project.name}" is due on ${deadline}.`;

      const existing = await prisma.notifications.findFirst({
        where: {
          user_id: project.user_id,
          type: "deadline_reminder",
          message,
          created_at: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      });

      if (!existing) {
        await prisma.notifications.create({
          data: {
            user_id: project.user_id,
            title: "Upcoming project deadline",
            message,
            type: "deadline_reminder"
          }
        });
      }
    }

    console.log("Deadline reminder check completed.");
  } catch (error) {
    console.error("Deadline reminder error:", error);
  }
}, {
  timezone: "Asia/Kolkata"
});
const server = app.listen(port, () => console.log(`SRS AI API running at http://localhost:${port}`));
const shutdown = async () => { await prisma.$disconnect(); server.close(() => process.exit(0)); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
