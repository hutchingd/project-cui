const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Server } = require('ws');
const pty = require('node-pty');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3300;

// ---------- Security: sandbox root ----------
const ROOT = process.env.IDEROOT || path.resolve(__dirname, '../..');
try {
  fs.mkdirSync(ROOT, { recursive: true });
} catch (e) {}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ---------- Config (multiplayer + registered users), stored in ../database.json ----------
const DB_PATH = path.join(ROOT, 'database.json');
const DEFAULT_DB = {
  users: {},
  multiplayer: { enabled: true, requireApproval: true, maxPlayers: 8, stun: 'stun:stun.l.google.com:19302' }
};
let DB = loadDB();
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
      return {
        ...DEFAULT_DB,
        ...loaded,
        users: (loaded.users && typeof loaded.users === 'object') ? loaded.users : {},
        multiplayer: { ...DEFAULT_DB.multiplayer, ...(loaded.multiplayer || {}) },
      };
    }
  } catch (e) {
    console.log('database.json invalid, using defaults:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}
function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2)); } catch (e) { console.log('save database.json failed:', e.message); }
}

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30d (persisted sessions survive restarts)
const tokens = new Map(); // token -> { username, color, folder, expires }
function saveTokenRec(token, rec) {
  tokens.set(token, rec);
  DB.sessions = DB.sessions || {};
  DB.sessions[token] = rec;
  saveDB();
}
function dropToken(token) {
  tokens.delete(token);
  if (DB.sessions && DB.sessions[token]) { delete DB.sessions[token]; saveDB(); }
}
function issueToken(username, color, folder) {
  const token = crypto.randomBytes(24).toString('hex');
  saveTokenRec(token, { username, color: color || defaultColorFor(username), folder: folder || '.', expires: Date.now() + TOKEN_TTL });
  return token;
}
function restoreSessions() {
  const now = Date.now();
  if (DB.sessions && typeof DB.sessions === 'object') {
    for (const [tok, rec] of Object.entries(DB.sessions)) {
      if (!rec || !rec.username) continue;
      if (rec.expires > now) tokens.set(tok, rec);
      else delete DB.sessions[tok];
    }
    saveDB();
  }
}
const COLOR_PALETTE = ['#e74c3c', '#2ecc71', '#3498db', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#e84393', '#00cec9', '#6c5ce7'];
function randomColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}
function defaultColorFor(username) {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}
function userByToken(token) {
  if (!token) return null;
  const t = tokens.get(token);
  if (!t) return null;
  if (t.expires < Date.now()) { dropToken(token); return null; }
  return t;
}

restoreSessions();

// Every registered user has their own folder (named after them) as their
// sandbox root. In a multiplayer room that root is replaced by the HOST's
// folder so everyone edits the same files the host invited them into.
function userRootOf(user) {
  return path.resolve(ROOT, user && user.folder ? user.folder : '.');
}
const roomFolders = new Map(); // token -> absolute folder path of the room host
function effectiveRoot(user, token) {
  const rf = roomFolders.get(token);
  return rf || userRootOf(user);
}
// Token from Bearer header, else the httpOnly session cookie (so the user is
// recognized even if localStorage was cleared / blocked).
function tokenFromReq(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const c = req.headers.cookie || '';
  const m = c.split(/;\s*/).find((kv) => kv.startsWith('pc_session='));
  return m ? decodeURIComponent(m.slice('pc_session='.length)) : null;
}
function setSessionCookie(res, token) {
  try { res.cookie('pc_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_TTL }); } catch (e) {}
}
function clearSessionCookie(res) {
  try { res.clearCookie('pc_session', { path: '/' }); } catch (e) {}
}
function resolveUser(req) {
  return userByToken(tokenFromReq(req));
}

// ---------- Path safety ----------
function safePath(root, rel) {
  const target = path.resolve(root || ROOT, rel || '.');
  const rootResolved = path.resolve(root || ROOT);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return target;
}

let wss;

// ---------- Persistent terminal sessions (survive client reloads) ----------
const termSessions = new Map(); // id -> { proc, buf: [], title }
const TERM_BUF_MAX = 200000;    // max buffered chars replayed on reattach

function pushBuf(session, data) {
  session.buf.push(data);
  let total = 0;
  for (const s of session.buf) total += s.length;
  while (total > TERM_BUF_MAX && session.buf.length > 1) {
    total -= session.buf[0].length;
    session.buf.shift();
  }
}

function broadcast(obj) {
  if (!wss) return;
  wss.clients.forEach((c) => { if (c.readyState === c.OPEN) send(c, obj); });
}

// ---------- Google Drive backup (optional) ----------
// Requires GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars (an OAuth "Desktop"
// client). The OOB redirect works with the copy-paste code flow in the UI.
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GDRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const GDRIVE_API = 'https://www.googleapis.com/drive/v3';
const GDRIVE_FOLDER = 'Project CUI';

function gdConfig() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret, redirect: process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob:auto' };
}

// Per-user Drive state lives in database.json. Do not ever log tokens.
function driveRecOf(user) {
  DB.gdrive = DB.gdrive || {};
  const rec = DB.gdrive[user.username] || (DB.gdrive[user.username] = { files: {} });
  return rec;
}

async function gdRefresh(rec) {
  if (rec.expiresAt && Date.now() < rec.expiresAt - 60000 && rec.accessToken) return rec.accessToken;
  const cfg = gdConfig();
  if (!cfg) throw new Error('Google Drive is not configured on the server');
  const r = await fetch(GDRIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.id, client_secret: cfg.secret,
      refresh_token: rec.refreshToken, grant_type: 'refresh_token',
    }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || 'Google Drive re-auth failed');
  rec.accessToken = d.access_token;
  rec.expiresAt = Date.now() + (d.expires_in || 3600) * 1000;
  saveDB();
  return rec.accessToken;
}

async function gdFolderId(rec) {
  if (rec.folderId) return rec.folderId;
  const tok = rec.accessToken;
  const q = encodeURIComponent(`name='${GDRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const list = await fetch(`${GDRIVE_API}/files?q=${q}&fields=files(id)`, { headers: { Authorization: `Bearer ${tok}` } })
    .then((r) => r.json()).catch(() => ({}));
  if (list.files && list.files.length) {
    rec.folderId = list.files[0].id;
  } else {
    const created = await fetch(`${GDRIVE_API}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: GDRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!created.id) throw new Error('Could not create the Google Drive folder for this project');
    rec.folderId = created.id;
  }
  saveDB();
  return rec.folderId;
}

function gdMultipart(boundary, metadata, content) {
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return Buffer.concat([Buffer.from(head), Buffer.from(content ?? '', 'utf8'), Buffer.from(tail)]);
}

async function gdUpload(rec, rel, content) {
  const tok = rec.accessToken;
  const folderId = await gdFolderId(rec);
  const boundary = 'pcui_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const existing = rec.files[rel];
  const url = existing ? `${GDRIVE_UPLOAD}/${existing}?uploadType=multipart` : `${GDRIVE_UPLOAD}?uploadType=multipart`;
  const r = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: gdMultipart(boundary, { name: rel, parents: [folderId] }, content),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(d.error || 'Upload to Google Drive failed');
  rec.files[rel] = d.id;
  saveDB();
  return d;
}

async function gdDelete(rec, rel) {
  const id = rec.files[rel];
  if (!id) return false;
  const tok = rec.accessToken;
  await fetch(`${GDRIVE_API}/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  delete rec.files[rel];
  saveDB();
  return true;
}

// ---------- HTTP API ----------
app.use(express.json({ limit: '10mb' }));

// ---------- Auth ----------
// Username-only access: type a name → the system creates your own private
// folder named after you. A taken name is rejected.
app.post('/api/register', (req, res) => {
  const name = String((req.body || {}).name || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '')
    .trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Enter a username' });
  if (!/^[\w.\- ]+$/.test(name)) return res.status(400).json({ error: 'Username has invalid characters' });
  if (DB.users[name]) {
    const live = [...tokens.values()].some((t) => t.username === name);
    if (live) return res.status(409).json({ error: 'This user already exists' });
    // Name exists but has no active session (e.g. after a server restart):
    // re-attach the user to their own folder instead of permanently locking them out.
    const rec = DB.users[name];
    const token = issueToken(name, rec.color, rec.folder);
    setSessionCookie(res, token);
    return res.json({ token, username: name, color: rec.color, folder: rec.folder });
  }

  const dir = path.resolve(ROOT, name);
  const rootResolved = path.resolve(ROOT);
  if (dir !== rootResolved && !dir.startsWith(rootResolved + path.sep)) {
    return res.status(400).json({ error: 'Invalid username' });
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return res.status(500).json({ error: 'Could not create folder' }); }

  const color = randomColor();
  DB.users[name] = { color, folder: name, createdAt: Date.now() };
  saveDB();
  const token = issueToken(name, color, name);
  setSessionCookie(res, token);
  res.json({ token, username: name, color, folder: name });
});

app.get('/api/status', (req, res) => {
  res.json({
    auth: true,
    multiplayer: {
      enabled: !!DB.multiplayer.enabled,
      maxPlayers: DB.multiplayer.maxPlayers || 8,
      requireApproval: !!DB.multiplayer.requireApproval,
      stun: DB.multiplayer.stun || 'stun:stun.l.google.com:19302',
    },
  });
});

app.use('/api', (req, res, next) => {
  const token = tokenFromReq(req);
  const user = userByToken(token);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Joiners awaiting host approval must not access any file.
  if (user.pending) return res.status(403).json({ error: 'Pending host approval' });
  req.user = user;
  req.token = token;
  next();
});

// List directory (recursive tree with sizes)
app.get('/api/fs/tree', (req, res) => {
  try {
    const root = effectiveRoot(req.user, req.token);
    const tree = buildTree(root, root, 0, 4);
    res.json(tree);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildTree(root, dir, depth, maxDepth) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
  const nodes = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let stat;
    try { stat = fs.statSync(full); } catch (err) { continue; }
    if (e.isDirectory()) {
      const children = depth < maxDepth ? buildTree(root, full, depth + 1, maxDepth) : [];
      nodes.push({
        name: e.name,
        type: 'directory',
        path: path.relative(root, full).split(path.sep).join('/'),
        size: children.reduce((a, c) => a + (c.size || 0), 0),
        children
      });
    } else {
      nodes.push({
        name: e.name,
        type: 'file',
        path: path.relative(root, full).split(path.sep).join('/'),
        size: stat.size,
        ext: path.extname(e.name).slice(1).toLowerCase()
      });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

// Never cache the SPA shell or the JSX entry, so users always get the latest build.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || /\.jsx$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  }
  next();
});

// Serve app.jsx pre-transpiled → no in-browser Babel, much faster first load
// and it can't blow the Monaco fallback timer.
let appJsBundle = null;
app.get('/app.jsx', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  if (appJsBundle) return res.send(appJsBundle);
  try {
    const src = fs.readFileSync(path.join(__dirname, '../public/app.jsx'), 'utf8');
    appJsBundle = require('@babel/core').transformSync(src, {
      presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
    }).code;
  } catch (err) {
    console.error('app.jsx compile error:', err.message);
    return res.status(500).send('// app.jsx failed to compile');
  }
  res.send(appJsBundle);
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/fs/read*', (req, res) => {
  try {
    const root = effectiveRoot(req.user, req.token);
    const rel = req.query.path || '';
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    if (path.extname?.(target) !== '.png' && fs.statSync(target).isFile() && fs.statSync(target).size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'File too large to open in editor' });
    }
    const buf = fs.readFileSync(target);
    const ext = path.extname(target).slice(1);
    const isBinary = /(png|jpg|jpeg|gif|ico|pdf|zip|gz|tar|mp4|mp3|woff|woff2|ttf|eot)/i.test(ext);
    if (isBinary) {
      res.json({ binary: true, data: buf.toString('base64'), ext });
    } else {
      res.json({ binary: false, content: buf.toString('utf8'), ext });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fs/download', (req, res) => {
  try {
    const root = effectiveRoot(req.user, req.token);
    const rel = req.query.path || '';
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    const st = fs.statSync(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.download(target, path.basename(target));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const MEDIA_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4',
};
app.get('/api/fs/media', (req, res) => {
  try {
    const root = effectiveRoot(req.user, req.token);
    const rel = req.query.path || '';
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    const st = fs.statSync(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    const ext = path.extname(target).slice(1).toLowerCase();
    res.setHeader('Content-Type', MEDIA_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(target))}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(target).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/upload', (req, res) => {
  try {
    const root = effectiveRoot(req.user, req.token);
    const dir = String(req.query.path || '').replace(/\/+$/, '');
    let name = '';
    try { if (req.get('X-Filename')) name = decodeURIComponent(req.get('X-Filename')); } catch (e) {}
    const base = path.basename(name || 'upload.bin');
    const rel = dir ? `${dir}/${base}` : base;
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(target);
    const fail = () => { try { out.destroy(); } catch (e) {} };
    req.on('aborted', fail);
    req.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      broadcastRefresh();
      res.json({ ok: true });
    });
    out.on('error', (err) => res.status(500).json({ error: err.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/write', (req, res) => {
  try {
    const { path: rel, content } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'Missing path' });
    const root = effectiveRoot(req.user, req.token);
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content ?? '');
    broadcastRefresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/create', (req, res) => {
  try {
    const { path: rel, type } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'Missing path' });
    const root = effectiveRoot(req.user, req.token);
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    if (type === 'directory') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
    broadcastRefresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/rename', (req, res) => {
  try {
    const { path: rel, newName } = req.body || {};
    if (!rel || !newName) return res.status(400).json({ error: 'Missing params' });
    const root = effectiveRoot(req.user, req.token);
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    const newTarget = safePath(root, path.relative(root, path.join(path.dirname(target), path.basename(String(newName)))));
    if (!newTarget) return res.status(400).json({ error: 'Invalid name' });
    fs.renameSync(target, newTarget);
    broadcastRefresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fs/delete', (req, res) => {
  try {
    const { path: rel } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'Missing path' });
    const root = effectiveRoot(req.user, req.token);
    const target = safePath(root, rel);
    if (!target) return res.status(400).json({ error: 'Invalid path' });
    fs.rmSync(target, { recursive: true, force: true });
    broadcastRefresh();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Google Drive routes ----------
app.get('/api/gdrive/status', (req, res) => {
  const cfg = gdConfig();
  const rec = driveRecOf(req.user);
  res.json({
    configured: !!cfg,
    connected: !!(rec && rec.refreshToken),
    email: (rec && rec.email) || null,
  });
});

app.get('/api/gdrive/auth-url', (req, res) => {
  const cfg = gdConfig();
  if (!cfg) return res.json({ configured: false });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg.id,
    scope: GDRIVE_SCOPE,
    redirect_uri: cfg.redirect,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    state: crypto.randomBytes(12).toString('hex'),
  }).toString();
  res.json({ configured: true, url });
});

app.post('/api/gdrive/token', async (req, res) => {
  const cfg = gdConfig();
  if (!cfg) return res.status(400).json({ error: 'Google Drive is not configured on the server' });
  const code = String(((req.body || {}).code || '').trim());
  if (!code) return res.status(400).json({ error: 'Enter the code shown by Google' });
  try {
    const r = await fetch(GDRIVE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.id, client_secret: cfg.secret,
        code, redirect_uri: cfg.redirect, grant_type: 'authorization_code',
      }).toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.refresh_token) return res.status(400).json({ error: d.error_description || d.error || 'Google rejected that code' });
    const rec = driveRecOf(req.user);
    rec.accessToken = d.access_token;
    rec.refreshToken = d.refresh_token;
    rec.expiresAt = Date.now() + (d.expires_in || 3600) * 1000;
    rec.email = null;
    saveDB();
    try {
      const about = await fetch(`${GDRIVE_API}/about?fields=user`, { headers: { Authorization: `Bearer ${d.access_token}` } })
        .then((r) => r.json()).catch(() => ({}));
      if (about.user && about.user.emailAddress) { rec.email = about.user.emailAddress; saveDB(); }
    } catch (_) {}
    res.json({ connected: true, email: rec.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gdrive/sync', async (req, res) => {
  try {
    const rec = driveRecOf(req.user);
    if (!rec.refreshToken) return res.status(400).json({ error: 'Google Drive is not connected' });
    const { action, path: rel, newPath } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'Missing path' });
    rec.accessToken = await gdRefresh(rec);
    if (action === 'write') {
      const root = effectiveRoot(req.user, req.token);
      const t = safePath(root, rel);
      let content = req.body.content;
      if (content == null) {
        content = (t && fs.existsSync(t) && fs.statSync(t).isFile()) ? fs.readFileSync(t, 'utf8') : '';
      }
      await gdUpload(rec, rel, content);
    } else if (action === 'delete') {
      const prefix = rel.endsWith('/') ? rel : rel + '/';
      for (const p of Object.keys(rec.files)) {
        if (p === rel || p.startsWith(prefix)) await gdDelete(rec, p);
      }
    } else if (action === 'rename' && newPath) {
      const prefix = rel.endsWith('/') ? rel : rel + '/';
      for (const p of Object.keys(rec.files)) {
        if (p === rel || p.startsWith(prefix)) await gdDelete(rec, p);
      }
      const root = effectiveRoot(req.user, req.token);
      const t = safePath(root, newPath);
      const content = (t && fs.existsSync(t) && fs.statSync(t).isFile()) ? fs.readFileSync(t, 'utf8') : '';
      await gdUpload(rec, newPath, content);
    } else {
      return res.status(400).json({ error: 'Invalid sync action' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gdrive/disconnect', (req, res) => {
  if (DB.gdrive) delete DB.gdrive[req.user.username];
  saveDB();
  res.json({ ok: true });
});

app.get('/api/system', (req, res) => {
  res.json({
    platform: os.platform(),
    homedir: os.homedir(),
    root: effectiveRoot(req.user, req.token),
    cpus: os.cpus().length,
    mem: os.totalmem(),
    load: os.loadavg(),
    node: process.version,
    disk: diskInfo()
  });
});

// Catch-all -> SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ---------- Realtime system stats ----------
let prevCpu = null;
function readCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return { idle: 0, total: 0 };
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: (parts[3] || 0) + (parts[4] || 0), total: parts.reduce((a, b) => a + b, 0) };
  } catch (e) { return { idle: 0, total: 0 }; }
}
function cpuPercent() {
  const now = readCpu();
  if (!prevCpu || !prevCpu.total) { prevCpu = now; return 0; }
  const idle = Math.max(0, now.idle - prevCpu.idle);
  const total = Math.max(0, now.total - prevCpu.total);
  prevCpu = now;
  return total > 0 ? Math.min(100, Math.round(((total - idle) / total) * 100)) : 0;
}
function topProcesses(n = 5) {
  try {
    const out = execSync(`ps -eo pcpu,rss,comm --sort=-pcpu | head -${n + 1}`, { maxBuffer: 1 << 20 }).toString();
    return out.trim().split('\n').slice(1).map((line) => {
      const p = line.trim().split(/\s+/);
      return {
        cpu: Math.min(999, Math.round(parseFloat(p[0] || 0) * 10) / 10),
        mem: Math.round((parseInt(p[1], 10) || 0) / 1024),
        name: (p[2] || '').slice(0, 24),
      };
    }).filter((r) => r.name);
  } catch (e) { return []; }
}
function diskInfo() {
  try {
    const s = fs.statfsSync(ROOT);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, pct: total > 0 ? Math.round(((total - free) / total) * 100) : 0 };
  } catch (e) {}
  try {
    const out = execSync(`df -k ${JSON.stringify(ROOT)} | tail -1`, { maxBuffer: 1 << 16 }).toString().trim().split(/\s+/);
    if (out.length >= 4) {
      const total = parseInt(out[1], 10) * 1024;
      const free = parseInt(out[3], 10) * 1024;
      return { total, free, pct: total > 0 ? Math.round(((total - free) / total) * 100) : 0 };
    }
  } catch (e) {}
  return null;
}

function collectStats() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    cpu: cpuPercent(),
    memUsed: used,
    memTotal: total,
    memPct: total > 0 ? Math.round((used / total) * 100) : 0,
    disk: diskInfo(),
    os: os.platform(),
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    uptime: Math.max(0, Math.round(os.uptime())),
    procs: topProcesses(5),
  };
}

// ---------- Multiplayer rooms ----------
const rooms = new Map(); // roomId -> room
const roomIdForWs = new Map();  // ws -> { roomId, role }

function mpRoomId(chars = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  while (true) {
    let id = '';
    for (let i = 0; i < chars; i++) id += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(id)) return id;
  }
}

function playerView(p) {
  return {
    oid: p.oid, name: p.name, color: p.color, mic: !!p.mic, ms: p.ms || null,
    frozen: !!p.frozen, ready: !!p.ready, isHost: !!p.isHost,
  };
}

function roomBroadcast(room, obj, except) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws !== except && p.ws.readyState === 1) send(p.ws, obj);
  }
}

function broadcastRoomPlayers(room) {
  const msg = {
    type: 'mp:players',
    roomId: room.id,
    roomName: room.name,
    requireApproval: room.requireApproval,
    players: [...room.players.values()].map(playerView),
    pending: room.requireApproval ? [...room.pending.values()].map((p) => playerView(p)) : [],
  };
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) send(p.ws, msg);
}

function createRoom(ws, name) {
  leaveRoom(ws, false); // a user hosts only one room at a time
  const meta = ws.meta;
  const room = {
    id: mpRoomId(),
    name: (name || `${meta.name}'s room`).slice(0, 40),
    ownerOid: meta.oid,
    requireApproval: DB.multiplayer.requireApproval !== false,
    players: new Map(),
    pending: new Map(),
    folder: ws.meta.root, // the host's folder is the room's shared workspace
    createdAt: Date.now(),
  };
  const host = {
    oid: meta.oid, name: meta.name, color: meta.color, ws,
    mic: false, ms: null, frozen: false, ready: true, isHost: true,
  };
  room.players.set(meta.oid, host);
  rooms.set(room.id, room);
  roomIdForWs.set(ws, { roomId: room.id, role: 'player' });
  if (meta.token) roomFolders.set(meta.token, room.folder);
  send(ws, {
    type: 'mp:joined',
    roomId: room.id,
    roomName: room.name,
    myOid: meta.oid,
    invite: room.id,
    requireApproval: room.requireApproval,
    players: [...room.players.values()].map(playerView),
  });
  return room;
}

function joinRoom(ws, roomId, requested) {
  const room = rooms.get(roomId);
  if (!room) return send(ws, { type: 'mp:error', error: 'Room not found' });
  const meta = ws.meta;
  if (room.players.has(meta.oid)) return send(ws, { type: 'mp:error', error: 'You are already in this room' });
  if (room.players.size >= (DB.multiplayer.maxPlayers || 8) && !room.requireApproval)
    return send(ws, { type: 'mp:error', error: 'Room is full' });
  const guest = {
    oid: meta.oid, name: meta.name, color: meta.color, ws,
    mic: false, ms: null, frozen: false, ready: false,
  };
  if (room.requireApproval) {
    if (room.pending.size + room.players.size >= (DB.multiplayer.maxPlayers || 8) + 4)
      return send(ws, { type: 'mp:error', error: 'Room is full' });
    room.pending.set(meta.oid, { ...guest, ready: false, isHost: false });
    roomIdForWs.set(ws, { roomId: room.id, role: 'pending' });
    if (meta.token) { const r = tokens.get(meta.token); if (r) r.pending = true; }
    send(ws, { type: 'mp:pending', roomId: room.id, roomName: room.name });
    send(ws, { type: 'mp:status', msg: 'Waiting for the host to approve your join…' });
    const host = room.players.get(room.ownerOid);
    if (host) send(host.ws, {
      type: 'mp:joinRequest',
      roomId: room.id,
      pending: [...room.pending.values()].map(playerView),
    });
    return;
  }
  room.players.set(meta.oid, { ...guest, ready: true });
  roomIdForWs.set(ws, { roomId: room.id, role: 'player' });
  // Joining a room puts you in the HOST's folder, not your own root.
  if (meta.token) roomFolders.set(meta.token, room.folder);
  ws.meta.root = room.folder;
  send(ws, {
    type: 'mp:joined',
    roomId: room.id,
    roomName: room.name,
    myOid: meta.oid,
    invite: room.id,
    requireApproval: false,
    players: [...room.players.values()].map(playerView),
  });
  roomBroadcast(room, { type: 'mp:join', oid: meta.oid, name: meta.name, color: meta.color });
  broadcastRoomPlayers(room);
}

function leaveRoom(ws, broadcastLeave = true) {
  const rel = roomIdForWs.get(ws);
  roomIdForWs.delete(ws);
  if (ws.meta && ws.meta.token) {
    const r = tokens.get(ws.meta.token); if (r) r.pending = false;
    roomFolders.delete(ws.meta.token);
  }
  if (!rel) return;
  const room = rooms.get(rel.roomId);
  if (!room) return;
  const oid = ws.meta && ws.meta.oid;
  room.pending.delete(oid);
  room.players.delete(oid);
  roomBroadcast(room, { type: 'mp:leave', oid, name: ws.meta.name });
  // If no one's left, drop the room.
  if (room.players.size === 0) {
    rooms.delete(room.id);
    return;
  }
  // If the host left, promote the first remaining player to host.
  if (room.ownerOid === oid) {
    const next = room.players.values().next().value;
    if (next) {
      next.isHost = true;
      next.ready = true;
      room.ownerOid = next.oid;
    }
  }
  if (broadcastLeave) broadcastRoomPlayers(room);
}

function handleMp(ws, msg) {
  const meta = ws.meta;
  const rel = roomIdForWs.get(ws);

  switch (msg.type) {
    case 'mp:create': {
      const room = createRoom(ws, msg.name);
      console.log(`[mp] ${meta.name} created room ${room.id} (${room.name})`);
      break;
    }

    case 'mp:join':
      joinRoom(ws, String(msg.roomId || '').toUpperCase().trim(), msg);
      break;

    case 'mp:leave':
      leaveRoom(ws, true);
      send(ws, { type: 'mp:left' });
      break;

    case 'mp:list': {
      const list = [...rooms.entries()].map(([id, r]) => ({
        id, name: r.name, players: r.players.size,
        max: DB.multiplayer.maxPlayers, lock: r.requireApproval,
      }));
      send(ws, { type: 'mp:list', rooms: list });
      break;
    }
  }

  if (!rel) return; // everything below requires a room

  const room = rooms.get(rel.roomId);
  if (!room) return;
  const player = room.players.get(meta.oid);

  switch (msg.type) {
    case 'mp:chat': {
      const text = String(msg.text || '').slice(0, 500);
      if (!text.trim()) return;
      roomBroadcast(room, { type: 'mp:chat', oid: meta.oid, name: meta.name, color: meta.color, text, at: Date.now() });
      break;
    }

    case 'mp:ms': {
      if (player) {
        player.ms = Math.max(0, Math.min(9999, Math.round(msg.ms || 0)));
        // Throttle presence broadcasts
        if (!room.__msTimer) {
          room.__msTimer = setTimeout(() => {
            room.__msTimer = null;
            broadcastRoomPlayers(room);
          }, 1500);
        }
      }
      break;
    }

    case 'mp:mic': {
      if (player) {
        player.mic = !!msg.on;
        if (!player.mic) roomBroadcast(room, { type: 'mp:voiceoff', oid: meta.oid });
        broadcastRoomPlayers(room);
      }
      break;
    }

    case 'mp:needvoice': {
      roomBroadcast(room, { type: 'mp:needvoice', from: meta.oid }, ws);
      break;
    }

    case 'mp:offer': {
      const target = room.players.get(String(msg.to));
      if (target) send(target.ws, { type: 'mp:offer', from: meta.oid, sdp: msg.sdp });
      break;
    }

    case 'mp:answer': {
      const target = room.players.get(String(msg.to));
      if (target) send(target.ws, { type: 'mp:answer', from: meta.oid, sdp: msg.sdp });
      break;
    }

    case 'mp:ice': {
      const target = room.players.get(String(msg.to));
      if (target) send(target.ws, { type: 'mp:ice', from: meta.oid, candidate: msg.candidate });
      break;
    }

    case 'mp:op': {
      roomBroadcast(room, { type: 'mp:op', from: meta.oid, name: meta.name, color: meta.color, path: msg.path, edits: msg.edits }, ws);
      break;
    }

    case 'mp:cursor': {
      // Throttle cursor relays per sender to reduce mesh chatter.
      const n = Date.now();
      if (n - (ws.meta.lastCursorAt || 0) < 250) break;
      ws.meta.lastCursorAt = n;
      roomBroadcast(room, {
        type: 'mp:cursor', from: meta.oid, name: meta.name, color: meta.color,
        path: msg.path, line: msg.line || 1, col: msg.col || 1,
      }, ws);
      break;
    }

    case 'mp:freeze': {
      if (player && player.isHost) {
        const target = room.players.get(String(msg.oid));
        if (target) {
          target.frozen = !!msg.frozen;
          roomBroadcast(room, { type: 'mp:frozen', oid: target.oid, frozen: target.frozen }, target.ws);
          send(target.ws, { type: 'mp:frozen', oid: target.oid, frozen: target.frozen, you: true });
        }
      }
      break;
    }

    case 'mp:kick': {
      if (player && player.isHost) {
        const target = room.players.get(String(msg.oid));
        if (target && target.oid !== room.ownerOid) {
          leaveRoom(target.ws, true);
          // Revoke their token server-side so they lose file access entirely,
          // even if they try to bypass by reconnecting.
          if (target.ws.meta && target.ws.meta.token) { const tok = target.ws.meta.token; dropToken(tok); roomFolders.delete(tok); }
          try { target.ws.close(4002, 'Kicked by host'); } catch (e) {}
        }
      }
      break;
    }

    case 'mp:approval': {
      if (player && player.isHost) {
        room.requireApproval = !!msg.on;
        broadcastRoomPlayers(room);
      }
      break;
    }

    case 'mp:approve': {
      if (player && player.isHost) {
        const guest = room.pending.get(String(msg.oid));
        if (guest) {
          room.pending.delete(guest.oid);
          if (guest.ws.meta && guest.ws.meta.token) { const r = tokens.get(guest.ws.meta.token); if (r) r.pending = false; }
          guest.ready = true;
          guest.isHost = false;
          room.players.set(guest.oid, guest);
          roomIdForWs.set(guest.ws, { roomId: room.id, role: 'player' });
          // Approved joiner now works in the host's folder too.
          if (guest.ws.meta && guest.ws.meta.token) roomFolders.set(guest.ws.meta.token, room.folder);
          if (guest.ws.meta) guest.ws.meta.root = room.folder;
          send(guest.ws, {
            type: 'mp:joined',
            roomId: room.id,
            roomName: room.name,
            myOid: guest.oid,
            invite: room.id,
            requireApproval: room.requireApproval,
            players: [...room.players.values()].map(playerView),
          });
          roomBroadcast(room, { type: 'mp:join', oid: guest.oid, name: guest.name, color: guest.color });
          broadcastRoomPlayers(room);
        }
      }
      break;
    }

    case 'mp:deny': {
      if (player && player.isHost) {
        const guest = room.pending.get(String(msg.oid));
        if (guest) {
          room.pending.delete(guest.oid);
          roomIdForWs.delete(guest.ws);
          if (guest.ws.meta && guest.ws.meta.token) { const tok = guest.ws.meta.token; dropToken(tok); roomFolders.delete(tok); }
          try { guest.ws.close(4003, 'Join request denied'); } catch (e) {}
          broadcastRoomPlayers(room);
        }
      }
      break;
    }

    case 'mp:stop': {
      if (player && player.isHost) {
        roomBroadcast(room, { type: 'mp:closed', reason: 'Host ended the session' });
        for (const p of room.players.values()) {
          roomIdForWs.delete(p.ws);
          // Guests lose file access when the session ends.
          if (p.ws !== ws && p.ws.meta && p.ws.meta.token) dropToken(p.ws.meta.token);
          if (p.ws.meta && p.ws.meta.token) roomFolders.delete(p.ws.meta.token);
          try { p.ws.close(4004, 'Session ended by host'); } catch (e) {}
        }
        rooms.delete(room.id);
        console.log(`[mp] host ${meta.name} ended room ${room.id}`);
      }
      break;
    }

    case 'mp:reqsync': {
      const target = room.players.get(String(msg.to));
      if (target && String(msg.to) !== meta.oid && msg.path) {
        send(target.ws, { type: 'mp:reqsync', from: meta.oid, to: msg.to, path: msg.path });
      }
      break;
    }

    case 'mp:sync': {
      const target = room.players.get(String(msg.to));
      if (target && String(msg.to) !== meta.oid && msg.path) {
        send(target.ws, {
          type: 'mp:sync', from: meta.oid, to: msg.to,
          path: msg.path, text: String(msg.text == null ? '' : msg.text),
        });
      }
      break;
    }
  }
}

// ---------- WebSocket Server ----------
const server = app.listen(PORT, () => {
  console.log(`Project CUI running at http://localhost:${PORT}`);
  console.log(`Workspace root: ${ROOT}`);
  startWSS(server);
});

function startWSS(server) {
  wss = new Server({ server, path: '/ws' });

  const statsTimer = setInterval(() => {
    const stats = collectStats();
    wss.clients.forEach((c) => { if (c.readyState === 1) send(c, { type: 'system:stats', stats }); });
  }, 2500);

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const user = userByToken(token);
    if (!user) {
      try { ws.close(4001, 'unauthorized'); } catch (e) {}
      return;
    }
    ws.meta = {
      oid: crypto.randomUUID(),
      name: user.username,
      color: user.color || defaultColorFor(user.username),
      token,
      root: userRootOf(user),
    };
    console.log(`Client connected (${ws.meta.name} → ${ws.meta.root})`);
    send(ws, { type: 'connected', root: ws.meta.root, me: { oid: ws.meta.oid, name: ws.meta.name, color: ws.meta.color } });
    send(ws, { type: 'system', system: {
      platform: os.platform(), node: process.version, mem: os.totalmem(), cpus: os.cpus().length
    }});
    send(ws, { type: 'system:stats', stats: collectStats() });
    send(ws, { type: 'term:sessions', sessions: [...termSessions.entries()].map(([id, s]) => ({ id, title: s.title })) });
    if (DB.multiplayer.enabled) {
      send(ws, { type: 'mp:ready', config: DB.multiplayer });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      switch (msg.type) {
        case 'ping':
          send(ws, { type: 'pong' });
          break;

        case 'mp:create': case 'mp:join': case 'mp:leave': case 'mp:list':
        case 'mp:chat': case 'mp:ms': case 'mp:mic': case 'mp:needvoice':
        case 'mp:offer': case 'mp:answer': case 'mp:ice':
        case 'mp:op': case 'mp:cursor': case 'mp:freeze': case 'mp:kick':
        case 'mp:approval': case 'mp:approve': case 'mp:deny': case 'mp:stop':
        case 'mp:reqsync': case 'mp:sync':
          if (DB.multiplayer.enabled) handleMp(ws, msg);
          break;

        case 'term:list':
          send(ws, { type: 'term:sessions', sessions: [...termSessions.entries()].map(([id, s]) => ({ id, title: s.title })) });
          break;

        case 'term:start': {
          const id = msg.id || 'main';
          const cols = Math.max(2, msg.cols || 80);
          const rows = Math.max(2, msg.rows || 24);
          let session = termSessions.get(id);
          if (!session) {
            const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
            const cwd = msg.cwd ? (safePath(ws.meta.root, msg.cwd) || ws.meta.root) : ws.meta.root;
            try {
              const proc = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols, rows,
                cwd,
                env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
              });
              session = { proc, buf: [], title: `Terminal ${id.replace(/\D/g, '') || 'main'}` };
              termSessions.set(id, session);
              proc.onData((data) => {
                if (termSessions.get(id) !== session) return;
                pushBuf(session, data);
                broadcast({ type: 'term:data', id, data });
              });
              proc.onExit(({ exitCode }) => {
                if (termSessions.get(id) === session) termSessions.delete(id);
                broadcast({ type: 'term:exit', id, code: exitCode });
              });
            } catch (e) {
              send(ws, { type: 'term:error', id, error: e.message });
              break;
            }
          } else {
            try { session.proc.resize(cols, rows); } catch (e) {}
          }
          send(ws, { type: 'term:ready', id });
          if (session.buf.length) {
            send(ws, { type: 'term:history', id, data: session.buf.join('') });
          }
          break;
        }

        case 'term:input': {
          const id = msg.id || 'main';
          const s = termSessions.get(id);
          if (s) { try { s.proc.write(msg.data); } catch (e) {} }
          break;
        }

        case 'term:resize': {
          const id = msg.id || 'main';
          const s = termSessions.get(id);
          if (s) {
            try { s.proc.resize(Math.max(2, msg.cols || 80), Math.max(2, msg.rows || 24)); } catch (e) {}
          }
          break;
        }

        case 'term:kill': {
          const id = msg.id || 'main';
          const s = termSessions.get(id);
          if (s) {
            termSessions.delete(id);
            try { s.proc.kill(); } catch (e) {}
            broadcast({ type: 'term:closed', id });
          }
          break;
        }
      }
    });

    // Sessions are kept alive when the client disconnects (reconnect = reattach).
    ws.on('close', () => {
      leaveRoom(ws, true);
    });
  });
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcastRefresh() {
  if (wss) {
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        send(ws, { type: 'fs:refresh' });
      }
    });
  }
}
