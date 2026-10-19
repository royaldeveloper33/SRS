import { useCallback, useEffect, useState } from "react";
import "./App.css";
import "./theme.css";

const token = () => sessionStorage.getItem("srs-token");
const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const api = async (path, options = {}) => {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(options.headers || {}) };
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : response.ok ? await response.blob() : await response.text();
  if (!response.ok) throw new Error(typeof body === "string" ? body || `Request failed (${response.status})` : body?.error || `Request failed (${response.status})`);
  return body;
};
const date = (value) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
const projectIconColors = ["#7863aa", "#526c9f", "#a15f91", "#4c827e", "#aa744c", "#687da8"];
const projectIconColor = (value) => {
  const key = String(value ?? "");
  const colorIndex = [...key].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) % projectIconColors.length,
    0
  );
  return projectIconColors[colorIndex];
};
const profileGradient = (value) => {
  const key = String(value ?? "");
  const colorIndex = [...key].reduce(
    (result, character) => (result * 31 + character.charCodeAt(0)) % projectIconColors.length,
    0
  );
  const nextColor = (colorIndex + 2) % projectIconColors.length;
  return `linear-gradient(135deg, ${projectIconColors[colorIndex]}, ${projectIconColors[nextColor]})`;
};
const Brand = () => <div className="brand" aria-label="SRS AI"><span className="brand-mark" title="SRS AI">S</span><span>SRS <i>AI</i></span></div>;
const GenerateLoader = ({ label = "Preparing your workspace", detail = "Putting everything together for you…", progress }) => <div className="generate-loader" role="status" aria-live="polite"><div className="loader-orbit"><i /><i /><i /></div><div className="loader-copy"><b>{label}</b><span>{detail}</span>{typeof progress === "number" && <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>}</div>{typeof progress === "number" ? <strong className="progress-value">{progress}%</strong> : <em className="loader-dots">•••</em>}</div>;
const InlineLoader = ({ children = "Working…" }) => <span className="inline-loader" role="status"><i />{children}</span>;
const questionChoices = (question) => { const match = question.match(/\[([^\]]+)\]/); if (match) return match[1].split("|").map((item) => item.trim()).filter(Boolean); return /^(do |is |are |will |can |should |does |has |have )/i.test(question.trim()) ? ["Yes", "No"] : []; };
function QuestionAnswer({ question, value, onChange, onSave, busy }) {
  const [editing, setEditing] = useState(false);
  const choices = Array.isArray(question.choices) && question.choices.length ? question.choices : questionChoices(question.question);
  const isYesNo = question.answer_type === "yes_no" || (choices.length === 2 && choices.includes("Yes") && choices.includes("No"));
  if (question.answer && !editing) return <div><p className="answer">{question.answer}</p><div className="answer-actions"><button className="text-btn" type="button" onClick={() => { onChange(question.answer); setEditing(true); }}>Edit answer</button><button className="text-btn" type="button" onClick={() => onSave("Skipped")}>Skip</button></div></div>;
  if (choices.length) return <div className={`choice-answer ${isYesNo ? "yes-no" : ""}`}>{choices.map((choice) => <button type="button" className={value === choice ? "selected" : ""} key={choice} onClick={() => { onChange(choice); onSave(choice, [choice]); }} disabled={Boolean(busy)}>{choice}</button>)}</div>;
  return <div className="answer-row"><input placeholder="Write the client answer…" value={value || ""} onChange={(event) => onChange(event.target.value)} /><button onClick={() => onSave(value)} disabled={Boolean(busy)}>{busy ? <InlineLoader>Saving…</InlineLoader> : "Save"}</button></div>;
}

function Auth({ onLogin }) {
  const [register, setRegister] = useState(false);const [loginProgress, setLoginProgress] = useState(0); const [googleProgress, setGoogleProgress] = useState(0); const [verification, setVerification] = useState(null); const [form, setForm] = useState({ name: "", email: "", password: "" }); const [code, setCode] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);const [srsProgress, setSrsProgress] = useState(0); const [showPassword, setShowPassword] = useState(false);
const submit = async (event) => {
  event.preventDefault();
  setBusy(true);
  setError("");

  if (!register) {
    setLoginProgress(10);

    const progressTimer = setInterval(() => {
      setLoginProgress((current) => {
        if (current >= 90) {
          clearInterval(progressTimer);
          return current;
        }

        return current + 10;
      });
    }, 200);
  }

  try {
    const result = await api(`/api/auth/${register ? "register" : "login"}`, {
      method: "POST",
      body: JSON.stringify(form)
    });

    if (!register) {
      setLoginProgress(100);
    }

    if (result.requiresVerification) {
      setVerification(result.email);
    } else {
      onLogin(result);
    }
  } catch (err) {
    setError(err.message);
    setLoginProgress(0);
  } finally {
    setBusy(false);
  }
};  
  const verify = async (event) => { event.preventDefault(); setBusy(true); setError(""); try { onLogin(await api("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ email: verification, code }) })); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const changeMode = () => { setRegister(!register); setVerification(null); setError(""); setCode(""); };
 const googleLogin = async (response) => {
  setBusy(true);
  setError("");
  setGoogleProgress(10);

  const progressTimer = setInterval(() => {
    setGoogleProgress((current) => {
      if (current >= 90) {
        clearInterval(progressTimer);
        return current;
      }

      return current + 10;
    });
  }, 200);

  try {
    const result = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({
        credential: response.credential
      })
    });

    setGoogleProgress(100);
await new Promise((resolve) => setTimeout(resolve, 800));
    onLogin(result);
  } catch (err) {
    setError(err.message);
    setGoogleProgress(0);
  } finally {
    clearInterval(progressTimer);
    setBusy(false);
  }
};
  return <main className="auth-page"><section className="brand-panel"><Brand /><div className="brand-content"><small>✦ AI-POWERED REQUIREMENTS</small><h1>Requirements,<br />made <em>clear.</em></h1><p>Turn early-stage software ideas into complete, structured requirements your whole team can understand.</p><b>✓ Ask the right clarification questions</b><b>✓ Generate a professional SRS in minutes</b><b>✓ Keep every version in one workspace</b></div><footer>© 2026 SRS AI · Build with confidence</footer></section><section className="form-panel"><div className="auth-card">{verification ? <><small>EMAIL VERIFICATION</small><h2>Check your inbox</h2><p>We sent a six-digit verification code to <b>{verification}</b>.</p><form onSubmit={verify} className="otp-form"><label>Verification code<input className="otp-input" required inputMode="numeric" autoComplete="one-time-code" maxLength="6" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>{error && <div className="message error">{error}</div>}<button className="primary-btn full" disabled={busy || code.length !== 6}>{busy ? <InlineLoader>Verifying…</InlineLoader> : "Verify email →"}</button></form><div className="switch"><button onClick={() => setVerification(null)}>← Use a different email</button></div></> : <><small>{register ? "START FOR FREE" : "WELCOME BACK"}</small><h2>{register ? "Create your account" : "Welcome back"}</h2><p>{register ? "We will verify your email before creating your workspace." : "Sign in to continue to your workspace."}</p><form onSubmit={submit}>{register && <label>Full name<input required minLength="2" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>}<label>Email address<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Password
  <div className="password-field">
    <input
      required
      minLength="8"
      type={showPassword ? "text" : "password"}

      value={form.password}
      onChange={(e) => setForm({ ...form, password: e.target.value })}
    />
    <button
      type="button"
      className="password-toggle"
      onClick={() => setShowPassword(!showPassword)}
      aria-label={showPassword ? "Hide password" : "Show password"}
    >
      {showPassword ? "🙈" : "👁"}
    </button>
  </div>
</label>{error && <div className="message error">{error}</div>}<button className="primary-btn full" disabled={busy}>
{busy && !register && googleProgress === 0 ? (
      <div className="login-progress">
      <span>Signing in... {loginProgress}%</span>

      <div className="login-progress-bar">
        <div
          className="login-progress-fill"
          style={{ width: `${loginProgress}%` }}
        ></div>
      </div>
    </div>
  ) : busy && register ? (
    <InlineLoader>Sending code…</InlineLoader>
  ) : (
    register ? "Create account →" : "Sign in →"
  )}
</button></form>


{!register && (
  <>
<div
  style={{
    display: "flex",
    alignItems: "center",
    width: "100%",
    gap: "12px",
    margin: "22px 0",
  }}
>
  <div
    style={{
      flex: 1,
      height: "1px",
      backgroundColor: "#e5eaeb",
    }}
  />

  <span
    style={{
      color: "#9aa5a8",
      fontSize: "9px",
      fontWeight: 700,
      letterSpacing: "1px",
    }}
  >
    OR
  </span>

  <div
    style={{
      flex: 1,
      height: "1px",
      backgroundColor: "#e5eaeb",
    }}
  />
  
</div>
<div className="google-login-wrapper">

  <div
    id="google-login-button"
    style={{
      display: googleProgress > 0 ? "none" : "block"
    }}
    ref={(element) => {
      if (element && window.google && !element.hasChildNodes()) {
        window.google.accounts.id.initialize({
          client_id: "550669966742-j4skr00ft24feoluajdn2jcu9fgl61jb.apps.googleusercontent.com",
          callback: googleLogin
        });

        window.google.accounts.id.renderButton(element, {
          theme: "outline",
          size: "large",
          width: "100%",
          text: "continue_with"
        });
      }
    }}
  ></div>

  {googleProgress > 0 && (
    <div className="google-progress">
      <span>Signing in with Google... {googleProgress}%</span>

      <div className="login-progress-bar">
        <div
          className="login-progress-fill"
          style={{ width: `${googleProgress}%` }}
        ></div>
      </div>
    </div>
  )}

</div>
  </>
)}

<div className="switch">{register ? "Already have an account?" : "New to SRS AI?"} <button onClick={changeMode}>{register ? "Sign in" : "Create account"}</button></div></>}</div></section></main>;
}

function Sidebar({ page, navigate }) {
  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: <svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z" /></svg> },
    { id: "projects", label: "Projects", icon: <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5" /></svg> },
    { id: "templates", label: "Templates", icon: <svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg> },
    { id: "settings", label: "Settings", icon: <svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /><path d="m19.4 15 .1.1 1.1.8-1.5 2.6-1.3-.5a8 8 0 0 1-1.4.8l-.2 1.4h-3l-.2-1.4a8 8 0 0 1-1.4-.8l-1.3.5-1.5-2.6 1.1-.8a7 7 0 0 1 0-1.6l-1.1-.8 1.5-2.6 1.3.5a8 8 0 0 1 1.4-.8l.2-1.4h3l.2 1.4a8 8 0 0 1 1.4.8l1.3-.5 1.5 2.6-1.1.8a7 7 0 0 1 0 1.6Z" /></svg> }
  ];
  const activePage = page === "project" ? "projects" : page;

  return <aside className="sidebar"><Brand /><small>WORKSPACE</small><nav aria-label="Workspace navigation">{navItems.map((item) => <button type="button" key={item.id} className={activePage === item.id ? "active" : ""} onClick={() => navigate(item.id)} aria-current={activePage === item.id ? "page" : undefined} title={item.label}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-label">{item.label}</span></button>)}</nav></aside>;
}

function MobileNav({ page, navigate }) { return <nav className="mobile-nav" aria-label="Main navigation"><button className={page === "dashboard" ? "active" : ""} onClick={() => navigate("dashboard")}><i>⌂</i><span>Dashboard</span></button><button className={page === "projects" || page === "project" ? "active" : ""} onClick={() => navigate("projects")}><i>▤</i><span>Projects</span></button><button className={page === "templates" ? "active" : ""} onClick={() => navigate("templates")}><i>▱</i><span>Templates</span></button><button className={page === "settings" ? "active" : ""} onClick={() => navigate("settings")}><i>⚙</i><span>Settings</span></button></nav>; }

function ProjectOverviewTools({ openProject }) {
  const [projects, setProjects] = useState([]); const [message, setMessage] = useState("");
  const load = useCallback(async () => { try { setProjects(await api("/api/projects?sort=updated")); } catch (error) { setMessage(error.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const action = async (project, actionName) => { try { const result = await api(`/api/projects/${project.id}/${actionName}`, { method: "POST" }); if (actionName === "duplicate") return openProject(result.id); setMessage(actionName === "favorite" ? (result.is_favorite ? "Project added to favorites." : "Project removed from favorites.") : "Project archived."); await load(); } catch (error) { setMessage(error.message); } };
  const deadlineLabel = (deadline) => { if (!deadline) return "No deadline"; const days = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000); return days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? "Due today" : `${days} days left`; };
  return <section className="project-overview-tools panel"><div className="section-head"><div><small>PROJECT OVERVIEW</small><h2>Quick project tools</h2><p>Keep important projects organised and on schedule.</p></div></div>{message && <div className="message notice">{message}</div>}{projects.length ? <div className="overview-list">{projects.slice(0, 4).map((project) => <article key={project.id} className="overview-item"><button className="overview-main" onClick={() => openProject(project.id)}><i style={{ background: project.color || projectIconColor(project.id) }}>{project.icon || project.name?.charAt(0).toUpperCase() || "P"}</i><span><b>{project.name}</b><small>{project.client_name || "No client added"} · {deadlineLabel(project.deadline)}</small></span></button><span className={`overview-status ${project.status}`}>{project.status.replace("_", " ")}</span><div className="overview-actions"><button title="Favorite" onClick={() => action(project, "favorite")}>{project.is_favorite ? "★" : "☆"}</button><button title="Duplicate" onClick={() => action(project, "duplicate")}>⧉</button><button title="Archive" onClick={() => action(project, "archive")}>⌑</button></div></article>)}</div> : <div className="empty"><b>No projects yet</b><span>Create your first project to use these tools.</span></div>}</section>;
}

function WorkspaceSettingsPanel() {
  const [saved, setSaved] = useState(false);
  const [preferences, setPreferences] = useState(() => JSON.parse(localStorage.getItem("srs-workspace-preferences") || '{"projectType":"Web application","reminders":true,"compact":false}'));
  const save = (event) => { event.preventDefault(); localStorage.setItem("srs-workspace-preferences", JSON.stringify(preferences)); setSaved(true); window.setTimeout(() => setSaved(false), 2500); };
  return <section className="content workspace-settings"><section className="panel padded"><div className="section-head"><div><small>WORKSPACE PREFERENCES</small><h2>Make SRS AI work your way</h2><p>These options are saved on this device and used when you plan new projects.</p></div></div><form onSubmit={save} className="settings-options"><label>Default project type<select value={preferences.projectType} onChange={(event) => setPreferences({ ...preferences, projectType: event.target.value })}><option>Web application</option><option>Mobile application</option><option>Business portal</option><option>E-commerce store</option><option>Internal tool</option></select></label><label>Default document language<select value={preferences.language || "English"} onChange={(event) => setPreferences({ ...preferences, language: event.target.value })}><option>English</option><option>Tamil</option><option>Hindi</option></select></label><label className="settings-check"><input type="checkbox" checked={preferences.reminders} onChange={(event) => setPreferences({ ...preferences, reminders: event.target.checked })} /> Show deadline reminders</label><label className="settings-check"><input type="checkbox" checked={preferences.compact} onChange={(event) => setPreferences({ ...preferences, compact: event.target.checked })} /> Use compact project cards</label><button className="primary-btn" type="submit">Save workspace preferences</button>{saved && <span className="save-success">Preferences saved</span>}</form></section></section>;
}

function Layout({ user, page, navigate, logout, children }) { return <div className={`app ${localStorage.getItem("srs-theme") || "light"}`}><Sidebar {...{ page, navigate }} /><main className="main"><header className="topbar"><Brand /><span className="topbar-date">{new Date().toLocaleDateString(undefined, { dateStyle: "full" })}</span><details className="topbar-profile"><summary aria-label={`Profile: ${user.name}`}><span className="topbar-avatar" style={{ backgroundImage: profileGradient(user.id ?? user.email ?? user.name) }}>{user.profile_image || user.profilePhoto ? <img src={user.profile_image || user.profilePhoto} alt="" /> : user.name?.trim().charAt(0).toUpperCase() || "U"}</span><span className="topbar-profile-name">{user.name}</span><span className="topbar-profile-caret" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg></span></summary><div className="topbar-profile-menu"><span>{user.email}</span><button type="button" onClick={() => navigate("settings")}>Settings</button><button type="button" onClick={logout}>Sign out</button></div></details></header>{page === "dashboard" && <div className="overview-shell"><ProjectOverviewTools openProject={(id) => navigate("project", id)} /></div>}{page === "settings" && <WorkspaceSettingsPanel />}{children}</main><MobileNav {...{ page, navigate }} /></div>; }

function Dashboard({ user, navigate, openProject, logout, page }) {const [loading, setLoading] = useState(true);
const [projectProgress, setProjectProgress] = useState(0);
  const [projects, setProjects] = useState([]); const [stats, setStats] = useState({ total: 0, draft: 0, completed: 0, exported: 0 }); const [search, setSearch] = useState(""); const [status, setStatus] = useState(""); const [sort, setSort] = useState("updated"); const [form, setForm] = useState({ name: "", clientIdea: "", client_name: "", deadline: "", notes: "", color: "#1aa67a", icon: "▤", projectType: "Web application", audience: "Business users", priority: "Fast MVP" }); const [showCreate, setShowCreate] = useState(false); const [error, setError] = useState("");  
const load = useCallback(async () => {
  setLoading(true);
  setProjectProgress(10);

  const progressTimer = window.setInterval(() => {
    setProjectProgress((value) => {
      if (value >= 90) return value;
      if (value < 40) return 40;
      if (value < 70) return 70;
      return 90;
    });
  }, 400);

  try {
    const [result, dashboardStats] = await Promise.all([api(`/api/projects?search=${encodeURIComponent(search)}&status=${status}&sort=${sort}`), api("/api/dashboard/stats")]);
    setProjects(result); setStats(dashboardStats);
    setProjectProgress(100);
  } catch (err) {
    setError(err.message);
  } finally {
    window.clearInterval(progressTimer);
    setLoading(false);
    setProjectProgress(0);
  }
}, [search, status, sort]);  useEffect(() => { const timer = setTimeout(load, 180); return () => clearTimeout(timer); }, [load]);
  const create = async (event) => { event.preventDefault(); try { const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ ...form, notes: [form.notes, `AI setup: ${form.projectType}; Audience: ${form.audience}; Priority: ${form.priority}`].filter(Boolean).join("\n") }) }); setShowCreate(false); setForm({ name: "", clientIdea: "", client_name: "", deadline: "", notes: "", color: "#1aa67a", icon: "▤", projectType: "Web application", audience: "Business users", priority: "Fast MVP" }); openProject(project.id); } catch (err) { setError(err.message); } };
  const remove = async (project) => { if (!window.confirm(`Delete ${project.name}? This permanently removes its SRS, versions, and exports.`)) return; try { await api(`/api/projects/${project.id}`, { method: "DELETE" }); await load(); } catch (err) { setError(err.message); } };
  const duplicate = async (project) => { try { const copy = await api(`/api/projects/${project.id}/duplicate`, { method: "POST" }); openProject(copy.id); } catch (err) { setError(err.message); } };
  const archive = async (project) => { try { await api(`/api/projects/${project.id}/archive`, { method: "POST" }); await load(); } catch (err) { setError(err.message); } };
  const favorite = async (project) => { try { await api(`/api/projects/${project.id}/favorite`, { method: "POST" }); await load(); } catch (err) { setError(err.message); } };
  return <Layout user={user} page={page} navigate={navigate} logout={logout}><section className="content"><div className="welcome"><div><small>YOUR WORKSPACE</small><h1>Good to see you, {user.name.split(" ")[0]}.</h1><p>Turn ideas into requirements your team can build with confidence.</p></div><button className="primary-btn" onClick={() => setShowCreate(true)}>＋ New project</button></div><div className="dashboard-stats" aria-label="Workspace statistics"><article><strong>{stats.total}</strong><span>Total projects</span></article><article><strong>{stats.draft}</strong><span>Draft projects</span></article><article><strong>{stats.completed}</strong><span>Completed</span></article><article><strong>{stats.exported}</strong><span>Documents exported</span></article></div>{error && <div className="message error">{error}</div>}<div className="toolbar"><input placeholder="Search projects…" value={search} onChange={(e) => setSearch(e.target.value)} /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="in_progress">In progress</option><option value="complete">Complete</option><option value="archived">Archived</option></select><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="updated">Recently updated</option><option value="name">Name</option></select></div><section className="panel">{loading ? <GenerateLoader
  label={`Opening your project... ${projectProgress}%`}
  detail="Loading your requirements workspace…"
  progress={projectProgress}
/> : projects.length === 0 ? <div className="empty"><b>{search || status ? "No matching projects" : "Your workspace is empty"}</b><span>{search || status ? "Try a different filter." : "Create your first project to get started."}</span></div> : <><div className="project-row header"><span>Project</span><span>Status</span><span>Updated</span><span /></div>{projects.map((project) => <div className="project-row" key={project.id}><button className="project-link" onClick={() => openProject(project.id)}><i style={{ backgroundColor: project.color || projectIconColor(project.id) }} aria-hidden="true">{project.icon || project.name?.trim().charAt(0).toUpperCase() || "P"}</i><span><b>{project.is_favorite ? "★ " : ""}{project.name}</b><small className="project-client">{project.client_name || "No client"}</small></span></button><span className="status">{project.status.replace("_", " ")}</span><span>{date(project.updated_at)}</span><button className="row-delete" title={`Delete ${project.name}`} onClick={() => remove(project)}>×</button></div>)}</>}</section></section>{showCreate && <Modal title="Create a project" onClose={() => setShowCreate(false)}><form onSubmit={create}><label>Project name<input required maxLength="255" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Client name <small>(optional)</small><input maxLength="150" placeholder="Client or company name" value={form.client_name} onChange={(e) => setForm({ ...form, client_name: e.target.value })} /></label><label>What are you building?<textarea required rows="5" value={form.clientIdea} onChange={(e) => setForm({ ...form, clientIdea: e.target.value })} /></label><button className="primary-btn full">Create project →</button></form></Modal>}</Layout>;
}

function DashboardV2({ user, navigate, openProject, logout, page }) {
  const welcomeKey = `srs-welcome-complete-${user.id || user.email}`;
  const [projects, setProjects] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(welcomeKey));
  const [form, setForm] = useState({ name: "", clientIdea: "", client_name: "", deadline: "", projectType: "Web application" });
  const load = useCallback(async () => { try { setProjects(await api("/api/projects?sort=deadline")); } catch (err) { setError(err.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const finishWelcome = () => { localStorage.setItem(welcomeKey, "true"); setShowWelcome(false); };
  const create = async (event) => { event.preventDefault(); try { const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ ...form, notes: `Project type: ${form.projectType}` }) }); finishWelcome(); openProject(project.id); } catch (err) { setError(err.message); } };
  const dueText = (deadline) => { if (!deadline) return "No target date"; const days = Math.ceil((new Date(deadline) - new Date()) / 86400000); return days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? "Due today" : `Due in ${days} days`; };
  const activeProjects = projects.filter((project) => !["complete", "archived"].includes(project.status)).length;
  const approvedProjects = projects.filter((project) => project.status === "complete").length;
  const urgentProjects = projects.filter((project) => { if (!project.deadline || project.status === "complete" || project.status === "archived") return false; const days = Math.ceil((new Date(project.deadline) - new Date()) / 86400000); return days <= 3; }).length;
  const upcomingDeadlines = projects.filter((project) => project.deadline && project.status !== "complete" && project.status !== "archived").sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).slice(0, 4);
  return <Layout user={user} page={page} navigate={navigate} logout={logout}>
    <section className="content dashboard-content">
      <div className="welcome dashboard-hero"><div><small>YOUR WORKSPACE</small><h1>Welcome back, {user.name.split(" ")[0]}.</h1><p>Organise your ideas, clarify the scope, and create SRS documents your team can confidently build from.</p></div><button className="primary-btn hero-cta" onClick={() => setShowCreate(true)}>＋ New project</button></div>
      {error && <div className="message error">{error}</div>}
      <section className="dashboard-card-grid" aria-label="Project summary"><article className="dashboard-card"><span className="dashboard-card-icon">▤</span><div><small>TOTAL PROJECTS</small><strong>{projects.length}</strong><p>All projects in your workspace</p></div></article><article className="dashboard-card"><span className="dashboard-card-icon active">↗</span><div><small>ACTIVE WORK</small><strong>{activeProjects}</strong><p>Projects currently in progress</p></div></article><article className="dashboard-card"><span className="dashboard-card-icon approved">✓</span><div><small>APPROVED</small><strong>{approvedProjects}</strong><p>Projects ready to deliver</p></div></article><article className={`dashboard-card ${urgentProjects ? "alert" : ""}`}><span className="dashboard-card-icon deadline">◷</span><div><small>DEADLINE ALERTS</small><strong>{urgentProjects}</strong><p>{urgentProjects ? "Due soon or overdue" : "Nothing urgent right now"}</p></div></article></section>
      <section className="panel deadline-calendar"><div className="section-head"><div><small>UPCOMING DEADLINES</small><h2>Delivery calendar</h2><p>Keep an eye on the next project milestones.</p></div><button className="text-btn" onClick={() => navigate("projects")}>View projects</button></div>{upcomingDeadlines.length ? <div className="deadline-list">{upcomingDeadlines.map((project) => <button key={project.id} onClick={() => openProject(project.id)}><i>{new Date(project.deadline).toLocaleDateString(undefined, { month: "short" }).toUpperCase()}<b>{new Date(project.deadline).getDate()}</b></i><span><b>{project.name}</b><small>{project.client_name || "No client added"} · {dueText(project.deadline)}</small></span><em>→</em></button>)}</div> : <div className="empty compact-empty"><b>No upcoming deadlines</b><span>Add a completion date to a project to see it here.</span></div>}</section>
      {showWelcome && <section className="welcome-launchpad" aria-label="Getting started"><div className="launchpad-grid"><div className="launchpad-copy"><div className="launchpad-title-row"><span className="launchpad-orb">✦</span><small>WELCOME TO SRS AI</small></div><h2>Turn your next big idea into a build-ready plan.</h2><p>Create a project, complete the guided discovery questions, and get a professional SRS ready for your client and development team.</p><div className="launchpad-buttons"><button className="primary-btn" onClick={() => setShowCreate(true)}>Create your first project <span>→</span></button><button className="welcome-dismiss" type="button" onClick={finishWelcome}>I’ll explore first</button></div></div><div className="launchpad-steps"><div className="launchpad-progress"><span>Getting started</span><b>3 simple steps</b></div><article><i>01</i><span><b>Capture the project</b><small>Add the client, completion date, and your software idea.</small></span><em>→</em></article><article><i>02</i><span><b>Answer with confidence</b><small>Use guided choices to clarify the project scope.</small></span><em>→</em></article><article><i>03</i><span><b>Deliver the SRS</b><small>Generate, review, and export a polished document.</small></span></article></div></div></section>}
      <section className="panel projects-panel"><div className="section-head"><div><small>ALL PROJECTS</small><h2>Your project workspace</h2></div>{projects.length > 0 && <span className="project-count">{projects.length} active</span>}</div>{projects.length ? <div className="overview-list">{projects.map((project, index) => <article key={project.id} className="overview-item animated-project" style={{ "--item-index": index }}><button className="overview-main" onClick={() => openProject(project.id)}><i style={{ background: project.color || projectIconColor(project.id) }}>{project.icon || project.name?.charAt(0).toUpperCase() || "P"}</i><span><b>{project.name}</b><small>{project.client_name || "No client"} · {dueText(project.deadline)}</small></span></button><span className={`overview-status ${project.status}`}>{project.status.replace("_", " ")}</span></article>)}</div> : <div className="empty compact-empty"><b>No projects yet</b><span>Create your first project to start organising requirements.</span></div>}</section>
    </section>
    {showCreate && <Modal title="Plan a new project" onClose={() => setShowCreate(false)}><form onSubmit={create}><label>Project name<input required maxLength="255" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Client name <small>(optional)</small><input maxLength="150" placeholder="Client or company" value={form.client_name} onChange={(event) => setForm({ ...form, client_name: event.target.value })} /></label><label>Target completion date <small>(optional)</small><input type="date" min={new Date().toISOString().slice(0, 10)} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} /></label><label>Project type<select value={form.projectType} onChange={(event) => setForm({ ...form, projectType: event.target.value })}><option>Web application</option><option>Mobile application</option><option>Business portal</option><option>E-commerce store</option><option>Internal tool</option></select></label><label>What are you building?<textarea required rows="5" value={form.clientIdea} onChange={(event) => setForm({ ...form, clientIdea: event.target.value })} /></label><p className="form-hint">After creation, we add starter questions about users, access, goals, and sensitive data.</p><button className="primary-btn full">Create project →</button></form></Modal>}
  </Layout>;
}

function DocumentDeliveryTools({ document, project }) {
  const [message, setMessage] = useState(""); const [versions, setVersions] = useState([]); const [showVersions, setShowVersions] = useState(false);
  const content = document?.content?.text || ""; const words = content.trim().split(/\s+/).filter(Boolean).length;
  const share = async () => { if (!document) return setMessage("Save an SRS before creating a review link."); try { const result = await api(`/api/documents/${document.id}/share`, { method: "POST" }); await navigator.clipboard.writeText(result.url); setMessage("Read-only review link copied to clipboard."); } catch (error) { setMessage(error.message); } };
  const history = async () => { if (!document) return; if (showVersions) return setShowVersions(false); try { setVersions(await api(`/api/documents/${document.id}/versions`)); setShowVersions(true); } catch (error) { setMessage(error.message); } };
  return <section className="panel padded document-delivery"><div className="section-head"><div><small>DOCUMENT DELIVERY</small><h2>Cover, contents and review</h2><p>Prepare your SRS for a client-ready handoff.</p></div></div><div className="delivery-grid"><div><b>Cover page details</b><span>{project.name} · {project.client_name || "Client not added"}</span><span>Version {document?.version || 1} · {date(document?.updated_at || project.updated_at)}</span></div><div><b>Table of contents</b><span>Overview · Requirements · Acceptance criteria</span><span>Risks · Assumptions · Exclusions</span></div><div><b>Document insight</b><span>{words.toLocaleString()} words · {words ? Math.max(1, Math.ceil(words / 200)) : 0} min read</span><span>{document ? "Ready for export" : "Draft not created"}</span></div></div><div className="actions"><button className="outline" onClick={share}>Share read-only link</button><button className="outline" onClick={history} disabled={!document}>{showVersions ? "Hide comparison" : "Compare versions"}</button><button className="outline" onClick={() => window.print()}>Print SRS</button></div>{message && <div className="message notice">{message}</div>}{showVersions && <div className="version-compare"><b>Version comparison</b>{versions.length ? versions.map((version, index) => <div key={version.id}><span>Version {version.version} · {date(version.created_at)}</span><small>{index === 0 ? "Current saved version" : "Earlier saved version"}</small></div>) : <span>No previous versions to compare yet.</span>}</div>}</section>;
}

const emptyProjectPlan = () => ({ risks: [], assumptions: "", exclusions: "", approvalStatus: "draft", reviewerName: "", approvalNote: "", approvedAt: "" });

function ProjectGovernancePanel({ plan, onChange, onSave, busy }) {
  const [risk, setRisk] = useState({ title: "", impact: "Medium", probability: "Medium", mitigation: "" });
  const [showRiskForm, setShowRiskForm] = useState(false);
  const addRisk = (event) => { event.preventDefault(); if (!risk.title.trim()) return; onChange({ ...plan, risks: [...(plan.risks || []), { ...risk, id: `${Date.now()}` }] }); setRisk({ title: "", impact: "Medium", probability: "Medium", mitigation: "" }); setShowRiskForm(false); };
  const removeRisk = (riskId) => onChange({ ...plan, risks: (plan.risks || []).filter((item) => item.id !== riskId) });
  const setApproval = (approvalStatus) => onChange({ ...plan, approvalStatus, approvedAt: approvalStatus === "approved" ? new Date().toISOString() : "" });
  const approvalLabel = { draft: "Draft", waiting: "Waiting for client", changes_requested: "Changes requested", approved: "Approved" }[plan.approvalStatus] || "Draft";
  return <section className="project-governance"><div className="governance-grid"><section className="panel padded risk-register"><div className="section-head"><div><small>PROJECT SAFEGUARDS</small><h2>Risks, assumptions & exclusions</h2><p>Capture decisions that protect the scope before development begins.</p></div><button className="outline" onClick={() => setShowRiskForm(!showRiskForm)}>{showRiskForm ? "Close" : "＋ Add risk"}</button></div>{showRiskForm && <form className="risk-form" onSubmit={addRisk}><label>Risk title<input required value={risk.title} placeholder="For example: Payment gateway approval delay" onChange={(event) => setRisk({ ...risk, title: event.target.value })} /></label><label>Impact<select value={risk.impact} onChange={(event) => setRisk({ ...risk, impact: event.target.value })}><option>Low</option><option>Medium</option><option>High</option></select></label><label>Probability<select value={risk.probability} onChange={(event) => setRisk({ ...risk, probability: event.target.value })}><option>Low</option><option>Medium</option><option>High</option></select></label><label className="wide">Mitigation plan<textarea rows="2" value={risk.mitigation} placeholder="How will the team reduce this risk?" onChange={(event) => setRisk({ ...risk, mitigation: event.target.value })} /></label><button className="primary-btn">Add risk</button></form>}{plan.risks?.length ? <div className="risk-list">{plan.risks.map((item) => <article key={item.id}><div><b>{item.title}</b><small><span className={`risk-tag ${item.impact.toLowerCase()}`}>{item.impact} impact</span> · {item.probability} probability</small>{item.mitigation && <p>Mitigation: {item.mitigation}</p>}</div><button className="text-btn" onClick={() => removeRisk(item.id)}>Remove</button></article>)}</div> : <div className="empty compact-empty">No risks recorded yet. Add risks early to prevent scope surprises.</div>}<label className="governance-field">Assumptions<textarea rows="3" value={plan.assumptions} placeholder="What must be true for this project to succeed?" onChange={(event) => onChange({ ...plan, assumptions: event.target.value })} /></label><label className="governance-field">Exclusions / out of scope<textarea rows="3" value={plan.exclusions} placeholder="What is intentionally not included in this project?" onChange={(event) => onChange({ ...plan, exclusions: event.target.value })} /></label></section><section className="panel padded approval-card"><small>CLIENT APPROVAL</small><h2>{approvalLabel}</h2><p>Record the client’s review outcome and keep a clear decision trail.</p><label>Client / reviewer name<input value={plan.reviewerName} placeholder="Name of reviewer" onChange={(event) => onChange({ ...plan, reviewerName: event.target.value })} /></label><label>Review note<textarea rows="4" value={plan.approvalNote} placeholder="Optional note, feedback, or approval reference" onChange={(event) => onChange({ ...plan, approvalNote: event.target.value })} /></label><div className="approval-actions"><button className="outline" onClick={() => setApproval("waiting")}>Request review</button><button className="outline" onClick={() => setApproval("changes_requested")}>Changes requested</button><button className="primary-btn" onClick={() => setApproval("approved")}>✓ Mark approved</button></div>{plan.approvedAt && <small className="approval-date">Approved {date(plan.approvedAt)}</small>}<button className="primary-btn full governance-save" onClick={() => onSave(plan)} disabled={Boolean(busy)}>{busy === "plan" ? "Saving…" : "Save governance details"}</button></section></div></section>;
}

function ProjectManagementPanel(props) {
  const latest = props.project.srs_documents?.[0];
  const [plan, setPlan] = useState(latest?.content?.projectPlan || emptyProjectPlan());
  useEffect(() => setPlan(props.project.srs_documents?.[0]?.content?.projectPlan || emptyProjectPlan()), [props.project.id, latest?.id]);
  const savePlan = async (nextPlan) => {
    try {
      const content = { ...(latest?.content || {}), text: latest?.content?.text || "", projectPlan: nextPlan };
      await (latest ? api(`/api/documents/${latest.id}`, { method: "PATCH", body: JSON.stringify({ content }) }) : api(`/api/projects/${props.project.id}/documents`, { method: "POST", body: JSON.stringify({ title: "Software Requirements Specification", content }) }));
      if (nextPlan.approvalStatus === "approved" && props.project.status !== "complete") await api(`/api/projects/${props.project.id}`, { method: "PATCH", body: JSON.stringify({ name: props.project.name, clientIdea: props.project.client_idea, status: "complete" }) });
      window.location.reload();
    } catch (error) { window.alert(error.message); }
  };
  return <><DocumentDeliveryTools document={latest} project={props.project} /><ProjectManagementContent {...props} /><ProjectGovernancePanel plan={plan} onChange={setPlan} onSave={savePlan} busy={props.busy} /></>;
}

function ProjectManagementContent({ project, document, onEdit, onApprove, onFavorite, onDuplicate, onArchive, onActivity, onAddQuestion, activity, busy }) {
  const deadline = project.deadline ? new Date(project.deadline).toLocaleDateString(undefined, { dateStyle: "medium" }) : "Not set";
  const requirements = project.project_requirements || [];
  const [showRequirements, setShowRequirements] = useState(false); const [localRequirements, setLocalRequirements] = useState(requirements); const [requirement, setRequirement] = useState({ title: "", description: "", type: "Functional", priority: "Medium", status: "Planned", acceptance_criteria: "" }); const [addingRequirement, setAddingRequirement] = useState(false); const [feedback, setFeedback] = useState("");
  useEffect(() => setLocalRequirements(requirements), [project.id, requirements.length]);
  const answered = (project.clarification_questions || []).filter((question) => question.answer).length;
  const checks = [{ label: "Client added", complete: Boolean(project.client_name) }, { label: "Deadline set", complete: Boolean(project.deadline) }, { label: "Questions answered", complete: answered > 0 }, { label: "SRS created", complete: Boolean(project.srs_documents?.length) }, { label: "Approved", complete: project.status === "complete" }];
  const score = checks.filter((check) => check.complete).length * 20;
  const days = project.deadline ? Math.ceil((new Date(project.deadline).getTime() - Date.now()) / 86400000) : null;
  const deadlineWarning = days === null ? "Set a target date to keep the project on track." : days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` : days === 0 ? "Due today" : days <= 3 ? `${days} day${days === 1 ? "" : "s"} remaining` : `Due in ${days} days`;
  const addRequirement = async (event) => { event.preventDefault(); setAddingRequirement(true); try { const saved = await api(`/api/projects/${project.id}/requirements`, { method: "POST", body: JSON.stringify(requirement) }); setLocalRequirements([...localRequirements, saved]); setRequirement({ title: "", description: "", type: "Functional", priority: "Medium", status: "Planned", acceptance_criteria: "" }); setFeedback(`${saved.code} added to requirements.`); } catch (error) { setFeedback(error.message); } finally { setAddingRequirement(false); } };
  const copySrs = async () => { const text = project.srs_documents?.[0]?.content?.text || ""; if (!text) return setFeedback("Create or save an SRS before copying it."); try { await navigator.clipboard.writeText(text); setFeedback("SRS copied to your clipboard."); } catch { setFeedback("Copy failed. Please select the SRS text manually."); } };
  const wordCount = (project.srs_documents?.[0]?.content?.text || "").trim().split(/\s+/).filter(Boolean).length;
  return <><section className="project-intelligence"><article className="panel health-card"><div className="health-score"><strong>{score}</strong><span>/100</span></div><div><small>PROJECT HEALTH</small><h2>{score === 100 ? "Ready to deliver" : score >= 60 ? "Nearly ready" : "Needs more detail"}</h2><p>Complete the remaining items to strengthen the project plan.</p></div><div className="health-checks">{checks.map((check) => <span className={check.complete ? "done" : ""} key={check.label}>{check.complete ? "✓" : "○"} {check.label}</span>)}</div></article><article className={`panel deadline-card ${days !== null && days <= 3 ? "urgent" : ""}`}><small>DELIVERY DATE</small><h2>{deadline}</h2><p>{deadlineWarning}</p><button className="text-btn" onClick={onEdit}>Change deadline</button></article><article className="panel document-tools"><small>DOCUMENT TOOLS</small><h2>{wordCount.toLocaleString()} words</h2><p>{wordCount ? `${Math.max(1, Math.ceil(wordCount / 200))} min read` : "Start your SRS draft"}</p><div><button className="text-btn" onClick={copySrs}>Copy SRS</button><button className="text-btn" onClick={() => window.print()}>Print</button></div></article></section>{feedback && <div className="message notice">{feedback}</div>}<section className="panel project-management"><div className="project-management-main"><div><small>PROJECT CONTROL CENTER</small><h2>Manage project details</h2><p>Client: <b>{project.client_name || "Not added"}</b> · Deadline: <b>{deadline}</b></p></div><div className="project-meta"><span><b>Created</b>{date(project.created_at)}</span><span><b>Last updated</b>{date(project.updated_at)}</span><span><b>Status</b>{project.status === "complete" ? "Approved" : project.status.replace("_", " ")}</span></div></div><div className="project-control-actions"><button className="outline" onClick={onEdit} disabled={Boolean(busy)}>Edit details</button><button className="outline" onClick={onFavorite} disabled={Boolean(busy)}>{project.is_favorite ? "★ Favorited" : "☆ Favorite"}</button><button className="outline" onClick={onDuplicate} disabled={Boolean(busy)}>Duplicate</button><button className="outline" onClick={onActivity} disabled={Boolean(busy)}>Activity</button>{project.status !== "complete" && <button className="primary-btn" onClick={onApprove} disabled={Boolean(busy)}>✓ Mark approved</button>}<button className="text-btn archive-btn" onClick={onArchive} disabled={Boolean(busy)}>Archive project</button></div></section><section className="panel padded requirements-panel"><div className="section-head"><div><small>REQUIREMENTS REGISTER</small><h2>Manual requirements</h2><p>Add feature requirements without using AI.</p></div><button className="outline" onClick={() => setShowRequirements(!showRequirements)}>{showRequirements ? "Close" : "＋ Add requirement"}</button></div>{showRequirements && <form className="requirement-form" onSubmit={addRequirement}><label>Requirement title<input required value={requirement.title} placeholder="For example: Users can reset their password" onChange={(event) => setRequirement({ ...requirement, title: event.target.value })} /></label><label>Type<select value={requirement.type} onChange={(event) => setRequirement({ ...requirement, type: event.target.value })}><option>Functional</option><option>Non-functional</option></select></label><label>Priority<select value={requirement.priority} onChange={(event) => setRequirement({ ...requirement, priority: event.target.value })}><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select></label><label>Status<select value={requirement.status} onChange={(event) => setRequirement({ ...requirement, status: event.target.value })}><option>Planned</option><option>In progress</option><option>Completed</option></select></label><label className="wide">Description<textarea rows="2" value={requirement.description} onChange={(event) => setRequirement({ ...requirement, description: event.target.value })} /></label><label className="wide">Acceptance criteria<textarea rows="2" placeholder="How do we know this feature works?" value={requirement.acceptance_criteria} onChange={(event) => setRequirement({ ...requirement, acceptance_criteria: event.target.value })} /></label><button className="primary-btn" disabled={addingRequirement}>{addingRequirement ? "Adding…" : "Add requirement"}</button></form>}{localRequirements.length ? <div className="requirements-list">{localRequirements.map((item) => <article key={item.id}><span className="requirement-code">{item.code}</span><div><b>{item.title}</b><small>{item.type} · {item.priority} priority · {item.status}</small>{item.acceptance_criteria && <p>Acceptance: {item.acceptance_criteria}</p>}</div></article>)}</div> : <div className="empty">No manual requirements yet. Add one to build a clear feature list.</div>}</section>{activity && <section className="panel padded activity-panel"><div className="section-head"><div><small>RECENT ACTIVITY</small><h2>Project timeline</h2></div><button className="text-btn" onClick={onActivity}>Hide</button></div>{activity.length ? <div className="activity-list">{activity.map((item) => <div key={item.id}><i>•</i><span><b>{item.detail || item.action}</b><small>{date(item.created_at)}</small></span></div>)}</div> : <div className="empty">No project activity recorded yet.</div>}</section>}</>;
}

function Project({ user, id, navigate, logout }) {
  const [project, setProject] = useState(null); const [draft, setDraft] = useState(""); const [answers, setAnswers] = useState({}); const [versions, setVersions] = useState([]); const [exports, setExports] = useState([]); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [srsProgress, setSrsProgress] = useState(0); const [projectProgress, setProjectProgress] = useState(0); const [deleteProgress, setDeleteProgress] = useState(0); const [showManage, setShowManage] = useState(false); const [activity, setActivity] = useState(null); const [manageForm, setManageForm] = useState({}); const [plan, setPlan] = useState(emptyProjectPlan());
  const load = useCallback(async () => {
  setProjectProgress(10);

  const progressTimer = window.setInterval(() => {
    setProjectProgress((value) => {
      if (value >= 90) return value;
      if (value < 40) return 40;
      if (value < 70) return 70;
      return 90;
    });
  }, 400);

  try {
    const value = await api(`/api/projects/${id}`);

    setProjectProgress(70);

    const projectExports = await api(`/api/projects/${id}/exports`);

    setProjectProgress(100);

    await new Promise((resolve) => window.setTimeout(resolve, 400));

    setProject(value);
    setDraft(value.srs_documents?.[0]?.content?.text || "");
    setPlan(value.srs_documents?.[0]?.content?.projectPlan || emptyProjectPlan());
    setExports(projectExports);
  } finally {
    window.clearInterval(progressTimer);
  }
}, [id]);
  useEffect(() => { load().catch((err) => setNote(err.message)); }, [load]);
  if (!project) return <Layout user={user} page="project" navigate={navigate} logout={logout}><div className="content"><GenerateLoader
  label={`Opening your project... ${projectProgress}%`}
  detail="Loading your requirements workspace…"
  progress={projectProgress}
/></div></Layout>;
  const latest = project.srs_documents?.[0];
  const save = async () => { setBusy("save"); try { await (latest ? api(`/api/documents/${latest.id}`, { method: "PATCH", body: JSON.stringify({ content: { ...(latest.content || {}), text: draft, projectPlan: plan } }) }) : api(`/api/projects/${id}/documents`, { method: "POST", body: JSON.stringify({ title: "Software Requirements Specification", content: { text: draft, projectPlan: plan } }) })); setNote("SRS draft saved."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const saveProjectPlan = async (nextPlan) => { setBusy("plan"); try { const savedContent = { ...(latest?.content || {}), text: draft, projectPlan: nextPlan }; await (latest ? api(`/api/documents/${latest.id}`, { method: "PATCH", body: JSON.stringify({ content: savedContent }) }) : api(`/api/projects/${id}/documents`, { method: "POST", body: JSON.stringify({ title: "Software Requirements Specification", content: savedContent }) })); if (nextPlan.approvalStatus === "approved" && project.status !== "complete") await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name: project.name, clientIdea: project.client_idea, status: "complete" }) }); setNote("Governance details saved."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const saveAnswer = async (questionId, answer = answers[questionId], selectedChoices) => { setBusy(`answer-${questionId}`); try { await api(`/api/questions/${questionId}`, { method: "PATCH", body: JSON.stringify({ answer, ...(selectedChoices ? { selected_choices: selectedChoices } : {}) }) }); setNote("Answer saved."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
const generate = async (kind) => {
  setBusy(kind);

  if (kind === "srs") {
    setSrsProgress(10);

    const progressTimer = window.setInterval(() => {
      setSrsProgress((value) => {
        if (value >= 90) return value;
        if (value < 40) return 40;
        if (value < 70) return 70;
        return 90;
      });
    }, 1200);

    try {
    const generated = await api(`/api/projects/${id}/ai/${kind}`, {
  method: "POST"
});
      setSrsProgress(100);

      setNote(
        "Simple SRS generated with user features, developer notes, time, and cost estimates."
      );

      await load();
      setDraft(generated.content?.text || "");
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    } catch (err) {
      setNote(err.message);
    } finally {
      window.clearInterval(progressTimer);
      setBusy(false);
      setSrsProgress(0);
    }

    return;
  }

  try {
    await api(`/api/projects/${id}/ai/${kind}`, {
      method: "POST"
    });

    setNote(
      "Questions generated. Answer them before generating the final SRS."
    );

    await load();
  } catch (err) {
    setNote(err.message);
  } finally {
    setBusy(false);
  }
};  const showVersions = async () => { if (!latest) return; setBusy("history"); try { setVersions(await api(`/api/documents/${latest.id}/versions`)); } finally { setBusy(false); } };
  const restore = async (version) => { setBusy(`restore-${version}`); try { await api(`/api/documents/${latest.id}/versions/${version}/restore`, { method: "POST" }); setVersions([]); setNote(`Version ${version} restored as a new current version.`); await load(); } finally { setBusy(false); } };
  const download = async (format) => { if (!latest) return setNote("Save an SRS before exporting."); setBusy(`export-${format}`); try { const blob = await api(`/api/documents/${latest.id}/export?format=${format}`); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${project.name}-srs.${format}`; link.click(); URL.revokeObjectURL(link.href); setNote(`${format.toUpperCase()} download started.`); setExports(await api(`/api/projects/${id}/exports`)); } finally { setBusy(false); } };
  const removeProject = async () => { if (!window.confirm(`Delete "${project.name}" and all of its SRS history permanently?`)) return; setBusy("delete"); setDeleteProgress(8); const timer = window.setInterval(() => setDeleteProgress((value) => Math.min(value + Math.ceil((92 - value) / 5), 92)), 180); try { await api(`/api/projects/${id}`, { method: "DELETE" }); setDeleteProgress(100); await new Promise((resolve) => window.setTimeout(resolve, 450)); navigate("dashboard"); } catch (err) { setNote(err.message); } finally { window.clearInterval(timer); setBusy(false); setDeleteProgress(0); } };
  const openManage = () => { setManageForm({ name: project.name, clientIdea: project.client_idea, client_name: project.client_name || "", deadline: project.deadline ? new Date(project.deadline).toISOString().slice(0, 10) : "", notes: project.notes || "", status: project.status, color: project.color || "", icon: project.icon || "" }); setShowManage(true); };
  const updateProject = async (event) => { event.preventDefault(); setBusy("project-update"); try { await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ ...manageForm, deadline: manageForm.deadline || null }) }); setShowManage(false); setNote("Project details updated."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const approveProject = async () => { setBusy("approve"); try { await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name: project.name, clientIdea: project.client_idea, status: "complete" }) }); setNote("Project marked as approved."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const favoriteProject = async () => { setBusy("favorite"); try { const updated = await api(`/api/projects/${id}/favorite`, { method: "POST" }); setNote(updated.is_favorite ? "Project added to favorites." : "Project removed from favorites."); await load(); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const duplicateProject = async () => { setBusy("duplicate"); try { const copy = await api(`/api/projects/${id}/duplicate`, { method: "POST" }); navigate("project", copy.id); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const archiveProject = async () => { if (!window.confirm("Archive this project? You can keep its documents without showing it in active work.")) return; setBusy("archive"); try { await api(`/api/projects/${id}/archive`, { method: "POST" }); navigate("dashboard"); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  const toggleActivity = async () => { if (activity) return setActivity(null); setBusy("activity"); try { setActivity(await api(`/api/projects/${id}/activity`)); } catch (err) { setNote(err.message); } finally { setBusy(false); } };
  return <Layout user={user} page="project" navigate={navigate} logout={logout}><section className="content"><div className="breadcrumb"><button onClick={() => navigate("dashboard")}>Projects</button> / <b>{project.name}</b></div><div className="welcome"><div><small>ACTIVE PROJECT</small><h1>{project.name}</h1><p>{project.client_idea}</p></div><div className="actions"><button className="outline" onClick={() => generate("questions")} disabled={Boolean(busy)}>✦ Ask AI</button><button className="primary-btn" onClick={() => generate("srs")} disabled={Boolean(busy)}>{busy === "srs" ? `Generating SRS... ${srsProgress}%` : "✦ Generate SRS"}</button><button className="outline" onClick={() => navigate("dashboard")} disabled={Boolean(busy)}>← Back</button><button className="delete-btn" onClick={removeProject} disabled={Boolean(busy)}>{busy === "delete" ? <InlineLoader>Deleting…</InlineLoader> : "Delete project"}</button></div></div>{note && <div className="message notice">{note}</div>}{busy === "questions" && <GenerateLoader label="Creating clarification questions" detail="Finding the details that matter most…" />}{busy === "delete" && <GenerateLoader label="Deleting your project" detail="Removing the project, SRS versions, and exports safely…" progress={deleteProgress} />}<ProjectManagementPanel project={project} onEdit={openManage} onApprove={approveProject} onFavorite={favoriteProject} onDuplicate={duplicateProject} onArchive={archiveProject} onActivity={toggleActivity} activity={activity} busy={busy} /><div className="project-grid"><section className="panel padded"><div className="section-head"><div><h2>Clarification questions</h2><p>Answer these to improve the SRS.</p></div></div>{project.clarification_questions?.length ? project.clarification_questions.map((q, index) => <article className="question" key={q.id}><i>{index + 1}</i><div><b>{q.question}</b><QuestionAnswer question={q} value={answers[q.id] || ""} onChange={(answer) => setAnswers({ ...answers, [q.id]: answer })} onSave={(answer, selectedChoices) => saveAnswer(q.id, answer, selectedChoices)} busy={busy === `answer-${q.id}`} /></div></article>) : <div className="empty">No clarification questions yet. Use Ask AI to generate them.</div>}</section><section className="panel padded"><div className="section-head"><div><h2>Current SRS {latest && <small>v{latest.version}</small>}</h2><p>Simple explanation for users, clear instructions for developers, plus time and cost estimates.</p></div><button className="outline" onClick={showVersions} disabled={!latest || Boolean(busy)}>{busy === "history" ? <InlineLoader>Loading…</InlineLoader> : "History"}</button></div><textarea className="srs-editor" rows="18" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Generate or write your SRS here…" /><div className="actions"><button className="primary-btn" onClick={save} disabled={Boolean(busy)}>{busy === "save" ? <InlineLoader>Saving…</InlineLoader> : "Save version"}</button><button className="outline" onClick={() => download("pdf")} disabled={!latest || Boolean(busy)}>{busy === "export-pdf" ? <InlineLoader>Exporting…</InlineLoader> : "Export PDF"}</button><button className="outline" onClick={() => download("docx")} disabled={!latest || Boolean(busy)}>{busy === "export-docx" ? <InlineLoader>Exporting…</InlineLoader> : "Export DOCX"}</button></div>{versions.length > 0 && <div className="version-list"><b>Version history</b>{versions.map((version) => <div key={version.id}><span>Version {version.version} · {date(version.created_at)}</span><button className="text-btn" onClick={() => restore(version.version)} disabled={Boolean(busy)}>{busy === `restore-${version.version}` ? <InlineLoader>Restoring…</InlineLoader> : "Restore"}</button></div>)}</div>}{exports.length > 0 && <div className="version-list"><b>Export history</b>{exports.map((item) => <div key={item.id}><span>{item.format.toUpperCase()} · {date(item.created_at)}</span><span>Downloaded</span></div>)}</div>}</section></div></section>{showManage && <Modal title="Edit project details" onClose={() => setShowManage(false)}><form onSubmit={updateProject}><label>Project name<input required maxLength="255" value={manageForm.name || ""} onChange={(event) => setManageForm({ ...manageForm, name: event.target.value })} /></label><label>Client name<input maxLength="150" value={manageForm.client_name || ""} onChange={(event) => setManageForm({ ...manageForm, client_name: event.target.value })} /></label><label>Completion date<input type="date" value={manageForm.deadline || ""} onChange={(event) => setManageForm({ ...manageForm, deadline: event.target.value })} /></label><label>Project status<select value={manageForm.status || "draft"} onChange={(event) => setManageForm({ ...manageForm, status: event.target.value })}><option value="draft">Draft</option><option value="in_progress">In progress</option><option value="complete">Approved / complete</option></select></label><label>Project description<textarea required rows="4" value={manageForm.clientIdea || ""} onChange={(event) => setManageForm({ ...manageForm, clientIdea: event.target.value })} /></label><label>Private project notes <small>(optional)</small><textarea rows="3" value={manageForm.notes || ""} onChange={(event) => setManageForm({ ...manageForm, notes: event.target.value })} /></label><button className="primary-btn full" disabled={Boolean(busy)}>{busy === "project-update" ? "Saving project…" : "Save project changes"}</button></form></Modal>}</Layout>;
}

function Templates({ user, navigate, logout }) {
  const [templates, setTemplates] = useState([]); const [error, setError] = useState(""); useEffect(() => { api("/api/templates").then(setTemplates).catch((err) => setError(err.message)); }, []);
  const createFromTemplate = async (template) => { try { const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: template.name, clientIdea: template.description, template }) }); navigate("project", project.id); } catch (err) { setError(err.message); } };
  return <Layout user={user} page="templates" navigate={navigate} logout={logout}><section className="content"><div className="welcome"><div><small>START FASTER</small><h1>Templates</h1><p>Use a proven structure, then make it yours.</p></div></div>{error && <div className="message error">{error}</div>}<div className="template-grid">{templates.map((template) => <article className="panel padded template-card" key={template.id}><i>✦</i><h2>{template.name}</h2><p>{template.description}</p><button className="primary-btn" onClick={() => createFromTemplate(template)}>Use template →</button></article>)}</div></section></Layout>;
}

function Settings({ user, setUser, navigate, logout }) {
  const [profile, setProfile] = useState({
  name: user.name,
  email: user.email
});
const [theme, setTheme] = useState(
  localStorage.getItem("srs-theme") || "light"
);
const changeTheme = (nextTheme) => {
  setTheme(nextTheme);
  localStorage.setItem("srs-theme", nextTheme);
  document.documentElement.setAttribute("data-theme", nextTheme);
};
const changePassword = async (event) => {
  event.preventDefault();

  try {
    await api("/api/me/password", {
      method: "POST",
      body: JSON.stringify(password)
    });

    setPassword({
      currentPassword: "",
      newPassword: ""
    });

    setNote("Password changed successfully.");
  } catch (err) {
    setNote(err.message);
  }
};
const [profilePhoto, setProfilePhoto] = useState(
  user.profile_image || user.profilePhoto || ""
); const [password, setPassword] = useState({ currentPassword: "", newPassword: "" }); const [note, setNote] = useState("");
{
}; 
const saveProfile = async (event) => {
  event.preventDefault();

  try {
    const next = await api("/api/me", {
      method: "PATCH",
      body: JSON.stringify({
        ...profile,
        profile_image: profilePhoto
      })
    });

    const updated = {
      ...user,
      ...next,
      profilePhoto: next.profile_image || profilePhoto
    };

    sessionStorage.setItem("srs-session", JSON.stringify(updated));
    setUser(updated);
    setNote("Profile updated.");
  } catch (err) {
    setNote(err.message);
  }
};  const remove = async () => { if (window.confirm("Delete your account and all projects permanently?")) { await api("/api/me", { method: "DELETE" }); logout(); } };
  return <Layout user={{ ...user, ...profile }} page="settings" navigate={navigate} logout={logout}><section className="content settings"><div className="welcome"><div><small>ACCOUNT</small><h1>Settings</h1><p>Manage your profile and workspace access.</p></div></div>{note && <div className="message notice">{note}</div>}<div className="settings-grid">

  <section className="panel padded">
  <div className="section-head">
    <div>
      <h2>Appearance</h2>
      <p>Choose how SRS AI looks on your device.</p>
    </div>
  </div>

  <div className="theme-options">
    <button
      type="button"
      className={`theme-option ${theme === "light" ? "selected" : ""}`}
      onClick={() => changeTheme("light")}
    >
      <div className="theme-icon">☀</div>

      <div className="theme-option-text">
        <strong>Light</strong>
        <span>Clean & bright</span>
      </div>

      {theme === "light" && <b className="theme-check">✓</b>}
    </button>

    <button
      type="button"
      className={`theme-option ${theme === "dark" ? "selected" : ""}`}
      onClick={() => changeTheme("dark")}
    >
      <div className="theme-icon">◐</div>

      <div className="theme-option-text">
        <strong>Dark</strong>
        <span>Easy on the eyes</span>
      </div>

      {theme === "dark" && <b className="theme-check">✓</b>}
    </button>
  </div>
</section>

  <section className="panel padded">
  <h2>Profile</h2>

  <div className="profile-photo-section">
    <div className="profile-photo" style={{ backgroundImage: profileGradient(user.id ?? user.email ?? profile.name) }}>
      {profilePhoto ? (
        <img src={profilePhoto} alt="Profile" />
      ) : (
        <span>{profile.name?.charAt(0).toUpperCase()}</span>
      )}
    </div>

    <div>
     <label className="photo-btn">
    <svg
  className="photo-camera-icon"
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <path
    d="M4 7h3l1.5-2h7L17 7h3v11H4V7Z"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinejoin="round"
  />
  <circle
    cx="12"
    cy="12.5"
    r="3"
    stroke="currentColor"
    strokeWidth="2"
  />
</svg>
    Change photo
        <input
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (!file) return;

            if (file.size > 2 * 1024 * 1024) {
              setNote("Profile picture must be smaller than 2MB.");
              return;
            }

const reader = new FileReader();

reader.onload = () => {
  setProfilePhoto(reader.result);
};

reader.readAsDataURL(file);          }}
        />
      </label>

      <small>JPG or PNG · Max 2MB</small>
    </div>
  </div>
  <form onSubmit={saveProfile}><label>Name<input required value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label><label>Email<input required type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label><button className="primary-btn full">Save profile</button></form></section><section className="panel padded security-card"><h2>Account security</h2><p>Protect your workspace and keep your account up to date.</p><div className="security-status"><span>●</span><div><b>Last signed in</b><small>{user.last_login_at ? date(user.last_login_at) : "Your first sign-in will appear here"}</small></div></div><div className="security-status"><span>✓</span><div><b>Email verification</b><small>Your account email is verified</small></div></div></section><section className="panel padded"><h2>Change password</h2><form onSubmit={changePassword}><label>Current password<input required type="password" value={password.currentPassword} onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })} /></label><label>New password<input required minLength="8" type="password" value={password.newPassword} onChange={(e) => setPassword({ ...password, newPassword: e.target.value })} /></label><button className="primary-btn full">Change password</button></form></section><section className="panel padded danger-panel"><h2>Danger zone</h2><p className="muted">Permanently delete your account, projects, and exports.</p><button className="delete-btn" onClick={remove}>Delete account</button></section></div></section></Layout>;
}

function Modal({ title, onClose, children }) { return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="section-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose}>×</button></div>{children}</div></div>; }

export default function App() {
  const [session, setSession] = useState(() => { const saved = sessionStorage.getItem("srs-session"); return saved ? JSON.parse(saved) : null; }); const [page, setPage] = useState("dashboard"); const [projectId, setProjectId] = useState(null);
  const login = (value) => { sessionStorage.setItem("srs-token", value.token); sessionStorage.setItem("srs-session", JSON.stringify(value.user)); setSession(value.user); };
  const logout = () => { if (!window.confirm("Log out of SRS AI? You can sign back in any time.")) return; sessionStorage.removeItem("srs-token"); sessionStorage.removeItem("srs-session"); setSession(null); };
  const navigate = (next, id = null) => { setPage(next); setProjectId(id); };
  if (!session) return <Auth onLogin={login} />;
  if (page === "project" && projectId) return <Project user={session} id={projectId} navigate={navigate} logout={logout} />;
  if (page === "templates") return <Templates user={session} navigate={navigate} logout={logout} />;
  if (page === "settings") return <Settings user={session} setUser={setSession} navigate={navigate} logout={logout} />;
  return <DashboardV2 user={session} navigate={navigate} logout={logout} openProject={(id) => navigate("project", id)} page={page === "projects" ? "projects" : "dashboard"} />;
}
