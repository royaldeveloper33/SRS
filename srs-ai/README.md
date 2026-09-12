# SRS AI

SRS AI turns an early software idea into a structured Software Requirements
Specification while keeping project drafts, versions, and exports in one
workspace.

## Development

1. Copy `server/.env.example` to `server/.env` and configure `DATABASE_URL`,
   `GEMINI_API_KEY`, and a long random `JWT_SECRET`. Create a free Gemini key
   at [Google AI Studio](https://aistudio.google.com/apikey).
2. Install dependencies in `client` and `server`.
3. Run `npm run db:cloud-setup` from `server` for a new or existing PostgreSQL
   database. This is idempotent and adds the current project/status and
   API-key columns to an existing database. Then run `npm run prisma:generate`.
4. Start the API with `npm run dev` and the Vite client with `npm run dev`.

The client uses a bearer token stored in local storage only for the current
browser session. Every project, document, question, version, and export route
is scoped to the authenticated user on the server. Never commit `server/.env`.

## Open on another device

For testing on a phone or another computer connected to the same Wi-Fi:

1. Start the server from `server` with `npm run dev`.
2. Start the client from `client` with `npm run dev -- --host 0.0.0.0`.
3. Run `ipconfig` on Windows and copy the host computer's IPv4 address.
4. Open `http://YOUR_IPV4_ADDRESS:5173` on the other device.

For example, if the computer IPv4 address is `192.168.1.25`, open
`http://192.168.1.25:5173`. Both devices must be on the same non-guest
network. If Windows Firewall blocks the page, allow inbound TCP traffic for
port `5173`. `localhost` only works on the computer running the app.

For access from anywhere, deploy the `server` directory to a Node hosting
provider and the `client` directory to a static hosting provider. Configure
`DATABASE_URL`, `JWT_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `PORT`, and
`CORS_ORIGIN` only as backend environment variables. Set `CORS_ORIGIN` to the
exact public frontend URL, such as `https://srs-ai.vercel.app`. Set
`VITE_API_URL` in the frontend hosting settings to the public backend URL,
such as `https://srs-ai-api.onrender.com`. Run `npm run db:cloud-setup` and
`npm run prisma:generate` on the backend before starting it with `npm start`.
Use HTTPS on both services and never expose `server/.env` or any secret in
frontend code. After deployment, send your friend the frontend URL; they can
open it from college, mobile data, or any other network.

The simplest free-style deployment flow is:

1. Create a hosted PostgreSQL database, for example on Neon or Supabase.
2. Deploy `server` to Render, Railway, or another Node host with the backend
   environment variables above and start command `npm start`.
3. Run `npm run db:cloud-setup` and `npm run prisma:generate` in the backend
   service after adding `DATABASE_URL`.
4. Deploy `client` to Vercel or Netlify with `VITE_API_URL` set to the backend
   URL, then share the generated HTTPS frontend URL.

This repository includes a [Render blueprint](./render.yaml) and a
[Vercel SPA fallback](./client/vercel.json) for the recommended Render +
Vercel setup. To publish it:

1. Push this repository to GitHub and create a hosted PostgreSQL database on
   Neon or Supabase.
2. In Render, choose **New > Blueprint**, select the repository, and apply
   `render.yaml`. Add the database connection string and Gemini API key when
   prompted. After the service is created, run `npm run db:cloud-setup` once
   from the Render shell or a trusted local environment using the same
   `DATABASE_URL`.
3. Copy the Render API URL, for example
   `https://srs-ai-api.onrender.com`.
4. In Vercel, import the same repository, set the project root to `client`,
   and set `VITE_API_URL` to the Render API URL. Deploy the project.
5. Copy the Vercel URL, for example `https://srs-ai.vercel.app`, and set
   Render's `CORS_ORIGIN` to that exact URL. Redeploy the Render service.
6. Open the Vercel URL and register. That HTTPS URL is the one to share with
   your friend at college.

Do not commit database passwords, Gemini keys, or `server/.env`. The hosting
providers must store those values as private environment variables.

## Features

- JWT authentication with password hashing and protected ownership-scoped APIs.
- Search, status filtering, sorting, duplication, and empty/loading states for
  projects.
- Reusable project templates that prefill a new project and SRS draft.
- SRS version history; restoring a version always creates a new current version.
- PDF/DOCX export records and export history APIs.
- Profile editing, password changes, account deletion, and API-key status.
- Gemini-powered SRS generation with developer/user explanations, feature
  requirements, delivery phases, time estimates, and cost ranges based on an
  explicit hourly-rate assumption.

## How to use

1. Open the client URL and create an account, or sign in to an existing account.
2. From the dashboard, select **New project**, enter the project name, and
   describe what you want to build.
3. Open the project and select **Ask AI** to create clarification questions.
   Answer the questions and save each answer.
4. Select **Generate SRS** to create a document with user explanations,
   developer notes, features, acceptance criteria, delivery phases, time
   estimates, and estimated low/high costs.
5. Edit the SRS in the document editor and choose **Save version** when ready.
   Use **History** to review versions or restore an older version as a new
   current version.
6. Choose **Export PDF** or **Export DOCX** to download the document.
7. Use **Templates** to start from a prefilled project structure. The
   dashboard also supports searching, filtering, sorting, duplicating, and
   deleting projects. Deleting a project permanently removes its SRS versions,
   questions, and export history after confirmation.

Validation and user-facing errors are handled at both the API and form layers.
Use `npm run build` and `npm run lint` in `client` to validate the production
bundle and frontend source. Run `npm test` and `npm run prisma:generate` in
`server` for syntax and Prisma validation. The server test script is kept
dependency-free so it can run before a database is available; use
`npm run prisma:test` after configuring `DATABASE_URL` for a live database
check.
