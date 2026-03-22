// ── État global ───────────────────────────────────────────────────────────────
let token = localStorage.getItem("token") || null;
let currentUser = null;
let ws = null;
let wsReconnectTimer = null;

const API = "";   // même origine que l'app

// ── Utilitaires ───────────────────────────────────────────────────────────────

async function api(method, path, body = null, raw = false) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(API + path, opts);
  if (raw) return res;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
  return data;
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString();
}

function fileIcon(ext) {
  const map = { mp4: "🎬", mkv: "🎬", webm: "🎬", mp3: "🎵", m4a: "🎵", opus: "🎵", ts: "📺" };
  return map[ext] || "📄";
}

// ── Auth ───────────────────────────────────────────────────────────────────────

document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("auth-login").style.display = tab.dataset.tab === "login" ? "block" : "none";
    document.getElementById("auth-register").style.display = tab.dataset.tab === "register" ? "block" : "none";
  });
});

document.getElementById("btn-login").addEventListener("click", async () => {
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  if (!username || !password) return toast("Remplissez tous les champs", "error");

  const form = new URLSearchParams({ username, password });
  try {
    const res = await fetch(API + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail);
    token = data.access_token;
    localStorage.setItem("token", token);
    await startApp();
  } catch (e) {
    toast(e.message, "error");
  }
});

document.getElementById("btn-register").addEventListener("click", async () => {
  const username = document.getElementById("reg-user").value.trim();
  const password = document.getElementById("reg-pass").value;
  if (!username || !password) return toast("Remplissez tous les champs", "error");

  try {
    await api("POST", "/api/auth/register", { username, password });
    toast("Compte créé ! Connectez-vous.", "success");
    document.querySelector('[data-tab="login"]').click();
  } catch (e) {
    toast(e.message, "error");
  }
});

document.getElementById("btn-logout").addEventListener("click", () => {
  token = null;
  localStorage.removeItem("token");
  if (ws) ws.close();
  document.getElementById("app").style.display = "none";
  document.getElementById("auth-screen").style.display = "flex";
});

// ── Navigation ─────────────────────────────────────────────────────────────────

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    const target = item.dataset.page;
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`page-${target}`).classList.add("active");
    if (target === "files") loadFiles();
    if (target === "admin") loadUsers();
  });
});

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connectWS() {
  if (!token) return;
  const host = location.host;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener("open", () => {
    document.getElementById("ws-dot").classList.add("connected");
  });

  ws.addEventListener("close", () => {
    document.getElementById("ws-dot").classList.remove("connected");
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener("message", e => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  });
}

function handleWsMessage(msg) {
  if (msg.type === "progress") {
    updateJobProgress(msg.job_id, msg.progress, msg.speed, msg.eta);
  } else if (msg.type === "status") {
    updateJobStatus(msg.job_id, msg.status, msg.filename, msg.error);
    if (msg.status === "done") toast(`✅ Téléchargement terminé`, "success");
    if (msg.status === "error") toast(`❌ Erreur : ${msg.error}`, "error");
  } else if (msg.type === "new_job") {
    prependJobCard(msg);
  }
}

// ── Jobs ───────────────────────────────────────────────────────────────────────

async function loadDownloads() {
  try {
    const jobs = await api("GET", "/api/downloads");
    const list = document.getElementById("job-list");
    list.innerHTML = "";
    if (!jobs.length) {
      list.innerHTML = '<div class="empty-state">Aucun téléchargement</div>';
      return;
    }
    jobs.forEach(job => list.appendChild(buildJobCard(job)));
    document.getElementById("job-count").textContent = jobs.length;
  } catch (e) {
    toast(e.message, "error");
  }
}

function buildJobCard(job) {
  const card = document.createElement("div");
  card.className = "job-card";
  card.id = `job-${job.id}`;
  card.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.2rem">
        <span class="status-badge status-${job.status}" id="badge-${job.id}">${job.status}</span>
        ${currentUser?.role === "admin" ? `<span class="badge">${job.username}</span>` : ""}
      </div>
      <div class="job-url">${job.url}</div>
      <div class="job-meta">
        <span class="tag">${job.downloader === "ytdlp" ? "yt-dlp" : "ani-cli"}</span>
        <span class="tag">${job.quality}</span>
        ${job.filename ? `<span class="tag">📄 ${job.filename}</span>` : ""}
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar ${job.status === "done" ? "done" : job.status === "error" ? "error" : ""}"
             id="bar-${job.id}" style="width:${job.progress}%"></div>
      </div>
      <div class="speed-info" id="speed-${job.id}">
        ${job.status === "downloading" ? `${job.progress.toFixed(1)}% ${job.speed || ""} ${job.eta ? "· ETA " + job.eta : ""}` : ""}
        ${job.status === "error" ? `<span style="color:var(--error)">${job.error || ""}</span>` : ""}
      </div>
    </div>
    <div class="job-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteJob('${job.id}')">✕</button>
    </div>
  `;
  return card;
}

function prependJobCard(job) {
  const list = document.getElementById("job-list");
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();
  const card = buildJobCard(job);
  list.prepend(card);
  const count = document.getElementById("job-count");
  count.textContent = parseInt(count.textContent || "0") + 1;
}

function updateJobProgress(jobId, pct, speed, eta) {
  const bar = document.getElementById(`bar-${jobId}`);
  const info = document.getElementById(`speed-${jobId}`);
  if (bar) bar.style.width = pct + "%";
  if (info) info.textContent = `${pct.toFixed(1)}% ${speed || ""} ${eta ? "· ETA " + eta : ""}`;
}

function updateJobStatus(jobId, status, filename, error) {
  const badge = document.getElementById(`badge-${jobId}`);
  const bar = document.getElementById(`bar-${jobId}`);
  const info = document.getElementById(`speed-${jobId}`);
  if (badge) { badge.className = `status-badge status-${status}`; badge.textContent = status; }
  if (bar) {
    bar.className = `progress-bar ${status === "done" ? "done" : status === "error" ? "error" : ""}`;
    if (status === "done") bar.style.width = "100%";
  }
  if (info) {
    if (status === "done") info.textContent = filename ? `📄 ${filename}` : "";
    if (status === "error") info.innerHTML = `<span style="color:var(--error)">${error || ""}</span>`;
  }
}

async function deleteJob(jobId) {
  try {
    await api("DELETE", `/api/downloads/${jobId}`, null, true);
    document.getElementById(`job-${jobId}`)?.remove();
    toast("Job supprimé", "info");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Formulaire d'ajout ─────────────────────────────────────────────────────────

document.getElementById("btn-add-download").addEventListener("click", async () => {
  const url = document.getElementById("dl-url").value.trim();
  const downloader = document.getElementById("dl-downloader").value;
  const quality = document.getElementById("dl-quality").value;
  if (!url) return toast("Entrez une URL", "error");

  const btn = document.getElementById("btn-add-download");
  btn.disabled = true;
  try {
    await api("POST", "/api/downloads", { url, downloader, quality });
    document.getElementById("dl-url").value = "";
    toast("Ajouté à la file !", "success");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Fichiers ───────────────────────────────────────────────────────────────────

async function loadFiles() {
  try {
    const files = await api("GET", "/api/files");
    const grid = document.getElementById("file-grid");
    grid.innerHTML = "";
    if (!files.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Aucun fichier</div>';
      return;
    }
    files.forEach(f => {
      const card = document.createElement("div");
      card.className = "file-card";
      card.innerHTML = `
        <div class="file-icon">${fileIcon(f.ext)}</div>
        <div class="file-name">${f.name}</div>
        <div class="file-size">${formatSize(f.size)}</div>
        <div class="file-size">${formatDate(f.modified)}</div>
        <div class="file-actions">
          <a href="/api/files/${encodeURIComponent(f.name)}"
             download="${f.name}"
             class="btn btn-primary btn-sm">⬇ Télécharger</a>
          ${currentUser?.role === "admin"
            ? `<button class="btn btn-danger btn-sm" onclick="deleteFile('${f.name}')">✕</button>`
            : ""}
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteFile(name) {
  if (!confirm(`Supprimer "${name}" ?`)) return;
  try {
    await api("DELETE", `/api/files/${encodeURIComponent(name)}`, null, true);
    toast("Fichier supprimé", "info");
    loadFiles();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Admin ──────────────────────────────────────────────────────────────────────

async function loadUsers() {
  if (currentUser?.role !== "admin") return;
  try {
    const users = await api("GET", "/api/admin/users");
    const tbody = document.getElementById("user-tbody");
    tbody.innerHTML = "";
    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${u.username}</td>
        <td class="role-${u.role}">${u.role}</td>
        <td>${new Date(u.created_at).toLocaleString()}</td>
        <td>
          ${u.role !== "admin"
            ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Supprimer</button>`
            : "—"}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteUser(userId) {
  if (!confirm("Supprimer cet utilisateur ?")) return;
  try {
    await api("DELETE", `/api/admin/users/${userId}`, null, true);
    toast("Utilisateur supprimé", "info");
    loadUsers();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Démarrage ──────────────────────────────────────────────────────────────────

async function startApp() {
  try {
    currentUser = await api("GET", "/api/auth/me");
  } catch {
    token = null;
    localStorage.removeItem("token");
    return;
  }

  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("username-display").textContent = currentUser.username;
  document.getElementById("role-display").textContent = currentUser.role;

  // Affiche nav admin seulement pour les admins
  if (currentUser.role === "admin") {
    document.getElementById("nav-admin").style.display = "flex";
  }

  await loadDownloads();
  connectWS();
}

// Démarrage automatique si token en localStorage
if (token) startApp();
