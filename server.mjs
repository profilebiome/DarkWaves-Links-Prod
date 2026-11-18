#!/usr/bin/env node
/**
 * DarkWaves — servidor de música + panel de administración.
 *
 * - Sirve el reproductor y transmite la música con enlaces firmados.
 * - Panel en /admin con usuario y contraseña.
 * - Subida de pistas a music/ con título, artista, álbum, género, año,
 *   descripción y contraseña opcional por pista.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeRecord, verifyRecord } from './shared/password-record.mjs';
import { publishAccounts } from './tools/publish-auth.mjs';
import { buildManifest } from './tools/build-manifest.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Publicar los cambios del panel en GitHub (sin tokens en el navegador) */
/* ------------------------------------------------------------------ */

/*
 * El panel escribe en music/ y shared/. Cuando algo cambia, el servidor hace
 * `git add` + `commit` + `push` con las credenciales que ya tiene tu PC
 * (Git Credential Manager). Así el sitio de GitHub Pages se actualiza solo y el
 * navegador nunca necesita un token.
 *
 * Se desactiva con DARKWAVES_PUSH=0 y se puede forzar un push manual con
 * POST /api/admin/publish.
 */
const PUSH_ENABLED = process.env.DARKWAVES_PUSH !== '0';
let syncTimer = null;
let syncBusy = false;
let syncMessage = '';
let lastSync = { at: 0, ok: null, message: '' };
let gitIdentity = null;

/** Nombre y correo para los commits: los de tu git o los de la cuenta del repo. */
async function resolveIdentity() {
  if (gitIdentity) return gitIdentity;
  const name = (await runGit(['config', '--get', 'user.name'])).stdout.trim();
  const email = (await runGit(['config', '--get', 'user.email'])).stdout.trim();
  gitIdentity = {
    name: name || process.env.DARKWAVES_GIT_NAME || 'profilebiome',
    email: email || process.env.DARKWAVES_GIT_EMAIL || 'profilebiome@users.noreply.github.com',
  };
  return gitIdentity;
}

function runGit(args) {
  return new Promise((resolve) => {
    // safe.directory: en el host el repo puede ser de otro usuario.
    const child = spawn('git', ['-c', 'safe.directory=*', ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function queueSync(message) {
  if (!PUSH_ENABLED) return;
  syncMessage = message || 'Panel: actualizar el sitio';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { runSync(); }, 1200);
}

/* ------------------------------------------------------------------ */
/* Publicar por la API de GitHub (hosts sin git, como Render) */
/* ------------------------------------------------------------------ */

const GH_TOKEN = process.env.DARKWAVES_GITHUB_TOKEN || '';
const GH_REPO = process.env.DARKWAVES_REPO || 'profilebiome/DarkWaves-Links-Prod';
const GH_BRANCH = process.env.DARKWAVES_BRANCH || 'main';
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;

async function github(pathname, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${GH_REPO}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'darkwaves-panel',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data && data.message ? data.message : `${response.status}`;
    throw new Error(`GitHub ${response.status}: ${detail}`);
  }
  return data;
}

const blobSha = (buffer) =>
  crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

async function remoteFiles(dir) {
  try {
    const list = await github(`/contents/${dir}?ref=${GH_BRANCH}`);
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (item && item.type === 'file') map.set(item.name, item.sha);
    }
    return map;
  } catch (error) {
    if (/404/.test(error.message)) return new Map();
    throw error;
  }
}

/** Sube/borra lo necesario para que el repo refleje el panel. */
async function publishViaApi() {
  if (!GH_TOKEN) throw new Error('Falta DARKWAVES_GITHUB_TOKEN en el servidor');

  const changes = [];

  // Música y playlist.
  const remote = await remoteFiles('music');
  let entries = [];
  try {
    entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const local = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!AUDIO_EXT.test(entry.name) && entry.name !== 'tracks.json') continue;
    local.add(entry.name);
    const buffer = fs.readFileSync(path.join(MUSIC_DIR, entry.name));
    if (remote.get(entry.name) === blobSha(buffer)) continue;
    changes.push({ path: `music/${entry.name}`, base64: buffer.toString('base64') });
  }
  for (const [name, sha] of remote) {
    if (!local.has(name) && (AUDIO_EXT.test(name) || name === 'tracks.json')) {
      changes.push({ path: `music/${name}`, sha, remove: true });
    }
  }

  // Cuentas publicadas (login del sitio y del host).
  const accountsPath = path.join(PUBLIC_DIR, 'shared', 'accounts.json');
  if (fs.existsSync(accountsPath)) {
    const buffer = fs.readFileSync(accountsPath);
    const current = await github(`/contents/shared/accounts.json?ref=${GH_BRANCH}`).catch(() => null);
    const currentSha = current && current.sha ? current.sha : null;
    if (!currentSha || currentSha !== blobSha(buffer)) {
      changes.push({ path: 'shared/accounts.json', base64: buffer.toString('base64'), sha: currentSha });
    }
  }

  if (!changes.length) {
    lastSync = { at: Date.now(), ok: true, message: 'Sin cambios pendientes' };
    return;
  }

  // sha de los archivos existentes para actualizarlos (la API lo exige).
  for (const change of changes) {
    if (change.remove) continue;
    if (change.sha) continue;
    const existing = await github(`/contents/${change.path}?ref=${GH_BRANCH}`).catch(() => null);
    change.sha = existing && existing.sha ? existing.sha : null;
  }

  const commitMessage = syncMessage || 'Panel: actualizar el sitio';
  for (const change of changes) {
    if (change.remove) {
      await github(`/contents/${change.path}`, {
        method: 'DELETE',
        body: JSON.stringify({ message: `${commitMessage} (borrar ${path.basename(change.path)})`, sha: change.sha, branch: GH_BRANCH }),
      });
      continue;
    }
    const body = { message: `${commitMessage} (${path.basename(change.path)})`, content: change.base64, branch: GH_BRANCH };
    if (change.sha) body.sha = change.sha;
    await github(`/contents/${change.path}`, { method: 'PUT', body: JSON.stringify(body) });
  }

  lastSync = { at: Date.now(), ok: true, message: `${commitMessage} · ${changes.length} archivo(s)` };
  console.log(`  ↳ Publicado en GitHub (${changes.length} archivo/s): ${commitMessage}`);
}

/* En el host el repo existe pero sin remoto "origin": se publica por API. */
let gitRemoteCache = null;
async function gitRemoteReady() {
  if (gitRemoteCache !== null) return gitRemoteCache;
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    gitRemoteCache = false;
    return false;
  }
  const remote = await runGit(['remote', 'get-url', 'origin']);
  gitRemoteCache = remote.code === 0 && remote.stdout.trim().length > 0;
  return gitRemoteCache;
}

async function runSync() {
  if (syncBusy) {
    queueSync(syncMessage);
    return;
  }
  syncBusy = true;
  const message = syncMessage || 'Panel: actualizar el sitio';
  try {
    // Sin remoto git (Render entrega el código sin "origin"): API de GitHub.
    if (!(await gitRemoteReady())) {
      await publishViaApi();
      return;
    }

    const add = await runGit(['add', '-A', 'music', 'shared']);
    if (add.code !== 0) throw new Error((add.stderr || add.stdout || 'git add fallo').trim());

    const who = await resolveIdentity();
    const commit = await runGit([
      '-c', `user.name=${who.name}`,
      '-c', `user.email=${who.email}`,
      'commit', '-m', message,
    ]);
    if (commit.code !== 0) {
      const detail = `${commit.stdout}\n${commit.stderr}`.trim();
      const nothing = /nothing to commit|no changes added/i.test(detail);
      lastSync = { at: Date.now(), ok: nothing ? true : false, message: nothing ? 'Sin cambios pendientes' : detail };
      if (!nothing) throw new Error(detail || 'git commit fallo');
      return;
    }

    // En el host no hay credenciales de git: se usa el token de una variable de
    // entorno (secreto del servidor, nunca del navegador).
    const gitToken = process.env.DARKWAVES_GITHUB_TOKEN || '';
    const auth = gitToken
      ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${gitToken}`).toString('base64')}`]
      : [];
    const push = await runGit([...auth, 'push', 'origin', 'HEAD:main']);
    if (push.code !== 0) throw new Error((push.stderr || push.stdout || 'git push fallo').trim());

    lastSync = { at: Date.now(), ok: true, message };
    console.log(`  ↳ Publicado en GitHub: ${message}`);
  } catch (error) {
    lastSync = { at: Date.now(), ok: false, message: error.message };
    console.warn(`  ↳ No se pudo publicar en GitHub: ${error.message}`);
  } finally {
    syncBusy = false;
  }
}
const BUNDLED_MUSIC_DIR = path.join(ROOT, 'music');
const BUNDLED_DATA_DIR = path.join(ROOT, 'data');

/**
 * Usa la carpeta pedida (disco persistente) y, si no se puede escribir —por
 * ejemplo en un plan sin disco— cae a la carpeta del proyecto.
 */
function usableDir(preferred, fallback) {
  for (const dir of [preferred, fallback]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* siguiente opción */
    }
  }
  return fallback || preferred;
}

/* En un host con disco persistente, music/ y data/ se montan fuera del repo. */
const MUSIC_DIR = usableDir(
  process.env.DARKWAVES_MUSIC_DIR ? path.resolve(process.env.DARKWAVES_MUSIC_DIR) : '',
  BUNDLED_MUSIC_DIR
);
const DATA_DIR = usableDir(
  process.env.DARKWAVES_DATA_DIR ? path.resolve(process.env.DARKWAVES_DATA_DIR) : '',
  BUNDLED_DATA_DIR
);
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const META_FILE = path.join(DATA_DIR, 'tracks.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = ROOT;

const BLOCKED_PATHS = new Set([
  '/server.mjs',
  '/package.json',
  '/README.md',
  '/.gitignore',
  '/.nojekyll',
  '/CNAME',
  '/data',
]);
const BLOCKED_PREFIXES = ['/.git/', '/.github/', '/tools/', '/data/', '/node_modules/', '/.freebuff/'];

/* Hosts como Render/Railway inyectan PORT y esperan 0.0.0.0. */
const PORT = Number(process.env.PORT || process.env.DARKWAVES_PORT || 4321);
const HOST = process.env.DARKWAVES_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
/* Cookies Secure cuando el sitio se sirve por HTTPS (detrás de un proxy). */
const SECURE_COOKIES = process.env.DARKWAVES_SECURE_COOKIES
  ? process.env.DARKWAVES_SECURE_COOKIES !== '0'
  : process.env.NODE_ENV === 'production';

/* El secreto vive en memoria: al reiniciar se invalidan enlaces y sesiones. */
/*
 * Secreto de firma (enlaces de audio y permisos de pista).
 * Se guarda en el disco para que un reinicio del host no invalide los enlaces
 * ni obligue a los oyentes a escribir otra vez la contraseña de la pista.
 */
function loadSecret() {
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const stored = fs.readFileSync(file);
    if (stored && stored.length >= 32) return stored;
  } catch {
    /* primer arranque */
  }
  const generated = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (error) {
    console.warn(`  No se pudo guardar el secreto de firma: ${error.message}`);
  }
  return generated;
}

const SECRET = loadSecret();
const STREAM_TTL = 1000 * 60 * 60 * 6;
const GRANT_TTL = 1000 * 60 * 60 * 12;
const SESSION_TTL = 1000 * 60 * 60 * 8;
const MAX_UPLOAD = 400 * 1024 * 1024;
const MAX_FIELD = 4096;

const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.opus', 'audio/ogg'],
  ['.webm', 'audio/webm'],
]);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/* Primera puesta en marcha con disco vacío: trae la música del repo. */
function seedMusic() {
  if (path.resolve(MUSIC_DIR) === path.resolve(BUNDLED_MUSIC_DIR)) return;
  if (!fs.existsSync(BUNDLED_MUSIC_DIR)) return;
  try {
    const onDisk = fs
      .readdirSync(MUSIC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && AUDIO_TYPES.has(path.extname(entry.name).toLowerCase()));
    if (onDisk.length) return;
    let copied = 0;
    for (const entry of fs.readdirSync(BUNDLED_MUSIC_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_TYPES.has(ext) && entry.name !== 'tracks.json') continue;
      fs.copyFileSync(path.join(BUNDLED_MUSIC_DIR, entry.name), path.join(MUSIC_DIR, entry.name));
      if (AUDIO_TYPES.has(ext)) copied += 1;
    }
    if (copied) console.log(`  Música copiada al disco persistente: ${copied} pista(s)`);
  } catch (error) {
    console.warn(`  No se pudo preparar ${MUSIC_DIR}: ${error.message}`);
  }
}

seedMusic();

const PAGES = new Map([
  ['/', 'index.html'],
  ['/admin', 'admin.html'],
]);

/* ------------------------------------------------------------------ */
/* Utilidades de disco                                                  */
/* ------------------------------------------------------------------ */

function readJSONFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONFile(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const cleanName = (value) => value.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

const idFor = (fileName) => crypto.createHash('sha1').update(fileName).digest('hex').slice(0, 16);

function safeFileName(name) {
  const base = path.basename(String(name || 'pista'));
  const ext = path.extname(base).toLowerCase();
  if (!AUDIO_TYPES.has(ext)) return null;
  let stem = path
    .basename(base, path.extname(base))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!stem) stem = 'pista';
  if (stem.length > 90) stem = stem.slice(0, 90).trim();
  return `${stem}${ext}`;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Contraseñas y sesiones                                              */
/* ------------------------------------------------------------------ */

/* scrypt para el servidor + PBKDF2 para verificar en el navegador sin backend. */
function makePasswordRecord(password) {
  return makeRecord(password);
}

function verifyPassword(password, record) {
  return verifyRecord(password, record);
}

const USER_NAME = /^[a-z0-9._-]{3,32}$/;
const normalizeUser = (value) => String(value || '').trim().toLowerCase();

/**
 * Cuentas del panel en data/users.json.
 * La primera cuenta es la principal (owner): crea y borra al resto.
 * Todas pueden subir música, editar pistas y asignar contraseñas.
 */
/* Recupera las cuentas publicadas en shared/accounts.json (host sin disco). */
function importPublicUsers() {
  const data = readJSONFile(path.join(PUBLIC_DIR, 'shared', 'accounts.json'), null);
  if (!data || !data.users) return null;
  const users = {};
  for (const [name, record] of Object.entries(data.users)) {
    if (!record || !record.salt || !record.hash) continue;
    users[name] = {
      pbkdf2: {
        salt: record.salt,
        iterations: Number(record.iterations) || 210000,
        hash: record.hash,
      },
      ...(record.owner ? { owner: true } : {}),
      createdAt: new Date().toISOString(),
    };
  }
  return Object.keys(users).length ? users : null;
}

function loadUsers() {
  const stored = readJSONFile(USERS_FILE, null);
  if (stored && stored.users && Object.keys(stored.users).length) return stored.users;

  // Sin data/ local (host sin disco): se recuperan las cuentas publicadas en
  // shared/accounts.json para que un reinicio no borre a los administradores.
  const imported = importPublicUsers();
  if (imported) {
    writeJSONFile(USERS_FILE, { version: 1, users: imported });
    console.log(`  Cuentas recuperadas de shared/accounts.json: ${Object.keys(imported).join(', ')}`);
    return imported;
  }

  // Migración desde la cuenta única anterior (data/admin.json).
  const legacy = readJSONFile(ADMIN_FILE, null);
  const name = normalizeUser(
    (legacy && legacy.user) || process.env.DARKWAVES_ADMIN_USER || 'admin'
  );
  const now = new Date().toISOString();
  const record =
    legacy && legacy.salt && legacy.hash
      ? { salt: legacy.salt, hash: legacy.hash }
      : makePasswordRecord(process.env.DARKWAVES_ADMIN_PASSWORD || 'darkwaves');

  const users = {
    [name]: { ...record, owner: true, createdAt: (legacy && legacy.createdAt) || now },
  };
  writeJSONFile(USERS_FILE, { version: 1, users });

  if (!legacy) {
    console.log(`\n  Panel nuevo creado.`);
    console.log(`  Usuario:    ${name}`);
    console.log(`  Contraseña: ${process.env.DARKWAVES_ADMIN_PASSWORD || 'darkwaves'}`);
    console.log(`  Cámbiala en /admin → Seguridad.`);
    console.log(`  Más administradores en /admin → Usuarios.\n`);
  }
  return users;
}

let users = loadUsers();

/* Publica el verificador PBKDF2 de las cuentas para el modo estático. */
try {
  publishAccounts();
} catch (error) {
  console.warn(`  No se pudo publicar shared/accounts.json: ${error.message}`);
}

function saveUsers() {
  writeJSONFile(USERS_FILE, { version: 1, users });
  // El login sin backend (GitHub Pages) verifica contra shared/accounts.json.
  try {
    publishAccounts();
  } catch (error) {
    console.warn(`  No se pudo publicar shared/accounts.json: ${error.message}`);
  }
  queueSync('Panel: cuentas del panel');
}

const isOwner = (name) => Boolean(users[name] && users[name].owner);

function dropSessionsOf(name) {
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.user === name) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) saveSessions();
}

/* Las sesiones viven en data/sessions.json: un reinicio del host (o el modo
   reposo de un plan gratuito) ya no saca a nadie del panel. */
const sessions = new Map(loadSessions());

function loadSessions() {
  const stored = readJSONFile(SESSIONS_FILE, null);
  const now = Date.now();
  const entries = stored && stored.sessions ? Object.entries(stored.sessions) : [];
  return entries.filter(([, session]) => session && session.exp > now);
}

function saveSessions() {
  const now = Date.now();
  const out = {};
  for (const [token, session] of sessions) {
    if (session.exp > now) out[token] = session;
  }
  try {
    writeJSONFile(SESSIONS_FILE, { version: 1, sessions: out });
  } catch (error) {
    console.warn(`  No se pudieron guardar las sesiones: ${error.message}`);
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL });
  saveSessions();
  return token;
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.exp < now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) saveSessions();
}

function cookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

/* Orígenes que pueden llamar a la API (el panel del sitio publicado). */
const ALLOWED_ORIGINS = (
  process.env.DARKWAVES_ALLOWED_ORIGINS ||
  'https://josspreview.profilebio.me,http://localhost:4321,http://127.0.0.1:4321'
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

/** Usuario y contraseña del panel enviados con autenticación básica. */
function basicUser(req) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('basic ')) return null;
  try {
    const raw = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const index = raw.indexOf(':');
    if (index < 0) return null;
    const name = normalizeUser(raw.slice(0, index));
    const password = raw.slice(index + 1);
    if (!users[name] || !verifyPassword(password, users[name])) return null;
    return { user: name, exp: Date.now() + SESSION_TTL, token: 'basic' };
  } catch {
    return null;
  }
}

function sessionFor(req) {
  pruneSessions();
  const token = cookies(req).dw_admin;
  if (token) {
    const session = sessions.get(token);
    if (session && session.exp >= Date.now()) return { ...session, token };
  }
  return basicUser(req);
}

function appendCookie(res, cookie) {
  const previous = res.getHeader('Set-Cookie');
  const list = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  const value = SECURE_COOKIES && !/;\s*secure/i.test(cookie) ? `${cookie}; Secure` : cookie;
  list.push(value);
  res.setHeader('Set-Cookie', list);
}

/* Limita intentos de login y de desbloqueo por IP. */
const attempts = new Map();

function allowAttempt(key, limit = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

/* Detrás de un proxy (Render, Cloudflare…) la IP real viene en X-Forwarded-For. */
const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'local';
};

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Enlaces firmados y permisos de pista                                */
/* ------------------------------------------------------------------ */

function signStream(id) {
  const exp = Date.now() + STREAM_TTL;
  const mac = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}

function verifyStream(id, token) {
  if (typeof token !== 'string') return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp || !mac) return false;
  const good = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readGrants(req) {
  const raw = cookies(req).dw_unlocked;
  const ids = new Set();
  if (!raw) return ids;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return ids;
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return ids;
  const now = Date.now();
  for (const entry of payload.split(',')) {
    const [id, exp] = entry.split(':');
    if (id && Number(exp) > now) ids.add(id);
  }
  return ids;
}

function writeGrants(res, ids) {
  const exp = Date.now() + GRANT_TTL;
  const payload = [...ids].map((id) => `${id}:${exp}`).join(',');
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  appendCookie(
    res,
    `dw_unlocked=${payload}.${mac}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(GRANT_TTL / 1000)}`
  );
}

/* ------------------------------------------------------------------ */
/* Metadatos de pistas                                                 */
/* ------------------------------------------------------------------ */

let metaCache = null;

function metaStore() {
  if (metaCache) return metaCache;
  let data = readJSONFile(META_FILE, null);

  // Sin data/ (host sin disco): se recupera de music/tracks.json para no perder
  // las claves de las pistas que ya están publicadas.
  if (!data) {
    const published = readJSONFile(path.join(MUSIC_DIR, 'tracks.json'), null);
    if (published && Array.isArray(published.tracks)) {
      const tracks = {};
      for (const item of published.tracks) {
        if (!item || !item.file) continue;
        const record = { title: item.title, artist: item.artist, addedAt: new Date().toISOString() };
        for (const field of ['album', 'genre', 'year', 'description']) {
          if (item[field]) record[field] = item[field];
        }
        if (item.key && item.key.salt) {
          record.password = {
            salt: item.key.salt,
            iterations: Number(item.key.iterations) || 210000,
            hash: item.key.hash,
            pbkdf2: item.key,
          };
        }
        tracks[item.file] = record;
      }
      if (Object.keys(tracks).length) data = { version: 1, tracks };
    }
  }

  metaCache = { version: 1, tracks: (data && data.tracks) || {} };
  return metaCache;
}

function saveMeta() {
  writeJSONFile(META_FILE, metaStore());
  // music/tracks.json alimenta el modo estático: claves de pista y bloqueo.
  try {
    buildManifest();
  } catch (error) {
    console.warn(`  No se pudo regenerar music/tracks.json: ${error.message}`);
  }
  queueSync('Panel: pistas y claves');
}

function fileTracks() {
  let entries = [];
  try {
    entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }

  return entries
    .filter((entry) => entry.isFile() && AUDIO_TYPES.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const ext = path.extname(entry.name).toLowerCase();
      const base = path.basename(entry.name, path.extname(entry.name));
      let artist = 'Artista desconocido';
      let title = cleanName(base);
      const parts = base.split(/\s+-\s+/);
      if (parts.length >= 2) {
        artist = cleanName(parts[0]);
        title = cleanName(parts.slice(1).join(' - '));
      }
      let size = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(path.join(MUSIC_DIR, entry.name));
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        /* archivo ilegible */
      }
      return {
        id: idFor(entry.name),
        fileName: entry.name,
        ext: ext.slice(1),
        title: title || base,
        artist,
        size,
        mtime,
        file: path.join(MUSIC_DIR, entry.name),
      };
    });
}

function buildTracks({ grants = new Set(), adminView = false } = {}) {
  const meta = metaStore().tracks;
  return fileTracks()
    .map((track) => {
      const record = meta[track.fileName] || {};
      const hasPassword = Boolean(record.password && record.password.hash);
      // La página es pública, pero ninguna pista se escucha sin la clave del panel.
      const locked = !hasPassword || !grants.has(track.id);
      const view = {
        id: track.id,
        title: record.title || track.title,
        artist: record.artist || track.artist,
        album: record.album || '',
        genre: record.genre || '',
        year: record.year || '',
        description: record.description || '',
        ext: track.ext,
        size: track.size,
        locked,
        hasPassword,
      };
      if (adminView) {
        view.file = track.fileName;
        view.updatedAt = record.updatedAt || '';
        view.addedAt = record.addedAt || '';
      }
      if (adminView || !locked) {
        view.url = `/stream/${track.id}?t=${encodeURIComponent(signStream(track.id))}`;
      }
      return view;
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

/* ------------------------------------------------------------------ */
/* Respuestas HTTP                                                     */
/* ------------------------------------------------------------------ */

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
  });
  res.end(message);
}

function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'No encontrado');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function pipeFile(res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.destroy();
  });
  stream.pipe(res);
}

function streamTrack(req, res, track) {
  let stat;
  try {
    stat = fs.statSync(track.file);
  } catch {
    return sendText(res, 404, 'La pista ya no está disponible');
  }
  const type = AUDIO_TYPES.get(path.extname(track.file).toLowerCase()) || 'audio/mpeg';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; media-src 'self'",
  };

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!match[1] && match[2]) {
      start = Math.max(0, stat.size - Number(match[2]));
      end = stat.size - 1;
    }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return pipeFile(res, track.file, { start, end });
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  pipeFile(res, track.file);
}

function readJSON(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new Error('El cuerpo de la solicitud es demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON no válido'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Parser multipart/form-data (sin dependencias)                       */
/* ------------------------------------------------------------------ */

function parseMultipart(req, boundary, destDir) {
  return new Promise((resolve, reject) => {
    const dash = Buffer.from(`--${boundary}`);
    const bodyDelim = Buffer.from(`\r\n--${boundary}`);
    const maxHead = 32 * 1024;

    const fields = {};
    let file = null;
    let fd = null;
    let state = 'preamble';
    let buf = Buffer.alloc(0);
    let current = null;
    let total = 0;
    let settled = false;
    let done = false;

    const cleanup = () => {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ya cerrado */
        }
        fd = null;
      }
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (file && file.path) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          /* nada que borrar */
        }
      }
      reject(new Error(message));
    };

    const startPart = (headers) => {
      const disposition = headers['content-disposition'] || '';
      const nameMatch = /name="([^"]*)"/i.exec(disposition);
      const fileMatch = /filename="([^"]*)"/i.exec(disposition);
      const fieldName = nameMatch ? nameMatch[1] : '';

      if (fileMatch) {
        const fileName = safeFileName(fileMatch[1]);
        if (!fileName) throw new Error('Formato de audio no permitido');
        if (file) throw new Error('Solo se puede subir un archivo por vez');
        const destination = uniquePath(destDir, fileName);
        fd = fs.openSync(destination, 'wx');
        file = {
          field: fieldName,
          path: destination,
          fileName: path.basename(destination),
          size: 0,
        };
      } else {
        current = { name: fieldName, chunks: [], size: 0 };
      }
    };

    const writeBody = (chunk) => {
      if (!chunk.length) return;
      total += chunk.length;
      if (total > MAX_UPLOAD) throw new Error('El archivo supera el máximo de 400 MB');
      if (fd !== null) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!written) throw new Error('No se pudo guardar el archivo en disco');
          offset += written;
          file.size += written;
        }
      } else if (current) {
        current.size += chunk.length;
        if (current.size > MAX_FIELD) throw new Error('Un campo del formulario es demasiado largo');
        current.chunks.push(chunk);
      }
    };

    const endPart = () => {
      if (fd !== null) {
        fs.closeSync(fd);
        fd = null;
      } else if (current) {
        fields[current.name] = Buffer.concat(current.chunks).toString('utf8');
        current = null;
      }
    };

    const process = () => {
      for (;;) {
        if (done) return;

        if (state === 'preamble') {
          const index = buf.indexOf(dash);
          if (index === -1) {
            buf = buf.subarray(Math.max(0, buf.length - dash.length));
            return;
          }
          buf = buf.subarray(index + dash.length);
          state = 'afterDash';
          continue;
        }

        if (state === 'afterDash') {
          if (buf.length < 2) return;
          if (buf[0] === 0x2d && buf[1] === 0x2d) {
            done = true;
            return;
          }
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw new Error('Formato de subida no válido');
          buf = buf.subarray(2);
          state = 'headers';
          continue;
        }

        if (state === 'headers') {
          const index = buf.indexOf('\r\n\r\n');
          if (index === -1) {
            if (buf.length > maxHead) throw new Error('Encabezados de subida no válidos');
            return;
          }
          const raw = buf.subarray(0, index).toString('utf8');
          buf = buf.subarray(index + 4);
          const headers = {};
          for (const line of raw.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
          startPart(headers);
          state = 'body';
          continue;
        }

        if (state === 'body') {
          const index = buf.indexOf(bodyDelim);
          if (index === -1) {
            const keep = bodyDelim.length + 2;
            if (buf.length > keep) {
              writeBody(buf.subarray(0, buf.length - keep));
              buf = buf.subarray(buf.length - keep);
            }
            return;
          }
          writeBody(buf.subarray(0, index));
          buf = buf.subarray(index + bodyDelim.length);
          endPart();
          state = 'afterDash';
          continue;
        }

        return;
      }
    };

    req.on('data', (chunk) => {
      if (settled) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        process();
      } catch (error) {
        fail(error.message || 'Error al procesar la subida');
      }
    });

    req.on('end', () => {
      if (settled) return;
      try {
        process();
      } catch (error) {
        return fail(error.message || 'Error al procesar la subida');
      }
      if (!done && state !== 'afterDash') return fail('Subida incompleta');
      cleanup();
      settled = true;
      resolve({ fields, file });
    });

    req.on('error', () => fail('Conexión interrumpida durante la subida'));
    req.on('aborted', () => fail('Subida cancelada'));
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

const META_FIELDS = ['title', 'artist', 'album', 'genre', 'year', 'description'];

function sanitizeField(value, max = 300) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function requireAdmin(req, res) {
  const session = sessionFor(req);
  if (!session) {
    sendJSON(res, 401, { error: 'Sesión no válida o expirada' });
    return null;
  }
  return session;
}

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (pathname === '/api/tracks' && (method === 'GET' || method === 'HEAD')) {
    const grants = readGrants(req);
    return sendJSON(res, 200, {
      tracks: buildTracks({ grants }),
      folder: 'music',
      scannedAt: Date.now(),
    });
  }

  if (pathname === '/api/unlock' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    if (!allowAttempt(`unlock:${clientIp(req)}`, 20)) {
      return sendJSON(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    }
    let body;
    try {
      body = await readJSON(req, 8 * 1024);
    } catch (error) {
      return sendJSON(res, 400, { error: error.message });
    }
    const id = String(body.id || '');
    const password = String(body.password || '');
    const file = fileTracks().find((item) => item.id === id);
    if (!file) return sendJSON(res, 404, { error: 'Pista no encontrada' });
    const record = metaStore().tracks[file.fileName] || {};
    if (!record.password || !record.password.hash) {
      return sendJSON(res, 409, {
        error: 'Esta pista todavía no tiene contraseña. Asígnale una desde el panel de administración.',
      });
    }
    if (!verifyPassword(password, record.password)) {
      return sendJSON(res, 401, { error: 'Contraseña incorrecta' });
    }
    attempts.delete(`unlock:${clientIp(req)}`);
    const grants = readGrants(req);
    grants.add(id);
    writeGrants(res, grants);
    const unlocked = buildTracks({ grants }).find((item) => item.id === id);
    return sendJSON(res, 200, { ok: true, url: unlocked ? unlocked.url : null });
  }

  if (pathname === '/api/admin/session' && method === 'GET') {
    const session = sessionFor(req);
    if (!session) return sendJSON(res, 401, { authenticated: false });
    return sendJSON(res, 200, {
      authenticated: true,
      user: session.user,
      owner: isOwner(session.user),
    });
  }

  /* Estado y publicación manual en GitHub (para el sitio publicado). */
  if (pathname === '/api/admin/publish' && (method === 'GET' || method === 'POST')) {
    const session = sessionFor(req);
    if (!session) return sendJSON(res, 401, { authenticated: false });
    if (method === 'POST') {
      if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
      clearTimeout(syncTimer);
      // Si hay una publicación en curso, se espera a que termine.
      for (let intento = 0; intento < 30 && syncBusy; intento += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await runSync();
    }
    return sendJSON(res, 200, {
      enabled: PUSH_ENABLED,
      ok: lastSync.ok,
      message: lastSync.message,
      at: lastSync.at ? new Date(lastSync.at).toISOString() : null,
    });
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    const key = `login:${clientIp(req)}`;
    if (!allowAttempt(key, 8)) {
      return sendJSON(res, 429, { error: 'Demasiados intentos fallidos. Espera 10 minutos.' });
    }
    let body;
    try {
      body = await readJSON(req, 8 * 1024);
    } catch (error) {
      return sendJSON(res, 400, { error: error.message });
    }
    const user = normalizeUser(body.user);
    const password = String(body.password || '');
    if (!user || !password) return sendJSON(res, 400, { error: 'Usuario y contraseña obligatorios' });
    if (!users[user] || !verifyPassword(password, users[user])) {
      return sendJSON(res, 401, { error: 'Usuario o contraseña incorrectos' });
    }
    attempts.delete(key);
    const token = createSession(user);
    appendCookie(
      res,
      `dw_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}`
    );
    return sendJSON(res, 200, { authenticated: true, user, owner: isOwner(user) });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const session = sessionFor(req);
    if (session) sessions.delete(session.token);
    appendCookie(res, 'dw_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/password' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    const session = requireAdmin(req, res);
    if (!session) return;
    let body;
    try {
      body = await readJSON(req, 8 * 1024);
    } catch (error) {
      return sendJSON(res, 400, { error: error.message });
    }
    const current = String(body.current || '');
    const next = String(body.next || '');
    const record = users[session.user];
    if (!record) return sendJSON(res, 401, { error: 'Sesión no válida o expirada' });
    if (!verifyPassword(current, record)) {
      return sendJSON(res, 401, { error: 'La contraseña actual no es correcta' });
    }
    if (next.length < 6) {
      return sendJSON(res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }
    users[session.user] = {
      ...record,
      ...makePasswordRecord(next),
      updatedAt: new Date().toISOString(),
    };
    saveUsers();
    dropSessionsOf(session.user);
    const token = createSession(session.user);
    appendCookie(
      res,
      `dw_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}`
    );
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    return sendJSON(res, 200, {
      you: session.user,
      owner: isOwner(session.user),
      users: Object.entries(users)
        .map(([name, record]) => ({
          user: name,
          owner: Boolean(record.owner),
          createdAt: record.createdAt || '',
          updatedAt: record.updatedAt || '',
        }))
        .sort((a, b) =>
          a.owner === b.owner ? a.user.localeCompare(b.user, 'es') : a.owner ? -1 : 1
        ),
    });
  }

  if (pathname === '/api/admin/users' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    const session = requireAdmin(req, res);
    if (!session) return;
    if (!isOwner(session.user)) {
      return sendJSON(res, 403, { error: 'Solo el administrador principal puede crear usuarios' });
    }
    let body;
    try {
      body = await readJSON(req, 8 * 1024);
    } catch (error) {
      return sendJSON(res, 400, { error: error.message });
    }
    const name = normalizeUser(body.user);
    const password = String(body.password || '');
    if (!USER_NAME.test(name)) {
      return sendJSON(res, 400, {
        error: 'Usuario no válido: de 3 a 32 caracteres, solo minúsculas, números, punto, guion o guion bajo',
      });
    }
    if (users[name]) return sendJSON(res, 409, { error: 'Ese usuario ya existe' });
    if (password.length < 6) {
      return sendJSON(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const now = new Date().toISOString();
    users[name] = { ...makePasswordRecord(password), createdAt: now, updatedAt: now };
    saveUsers();
    return sendJSON(res, 201, { ok: true, user: name });
  }

  if (pathname.startsWith('/api/admin/users/')) {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    const session = requireAdmin(req, res);
    if (!session) return;
    if (!isOwner(session.user)) {
      return sendJSON(res, 403, { error: 'Solo el administrador principal puede gestionar usuarios' });
    }
    const rest = pathname.slice('/api/admin/users/'.length).split('/');
    const name = normalizeUser(rest[0]);
    const action = rest[1] || '';
    const record = users[name];
    if (!record) return sendJSON(res, 404, { error: 'Usuario no encontrado' });

    if (action === 'password' && (method === 'POST' || method === 'PUT')) {
      let body;
      try {
        body = await readJSON(req, 8 * 1024);
      } catch (error) {
        return sendJSON(res, 400, { error: error.message });
      }
      const password = String(body.password || '');
      if (password.length < 6) {
        return sendJSON(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      users[name] = { ...record, ...makePasswordRecord(password), updatedAt: new Date().toISOString() };
      saveUsers();
      if (name !== session.user) dropSessionsOf(name);
      return sendJSON(res, 200, { ok: true });
    }

    if (method === 'DELETE') {
      if (record.owner) {
        return sendJSON(res, 400, { error: 'El administrador principal no se puede borrar' });
      }
      if (name === session.user) {
        return sendJSON(res, 400, { error: 'No puedes borrar tu propio usuario' });
      }
      if (Object.keys(users).length <= 1) {
        return sendJSON(res, 400, { error: 'Debe quedar al menos un usuario' });
      }
      delete users[name];
      saveUsers();
      dropSessionsOf(name);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 405, { error: 'Método no permitido' });
  }

  if (pathname === '/api/admin/tracks' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return sendJSON(res, 200, { tracks: buildTracks({ adminView: true, grants: readGrants(req) }) });
  }

  if (pathname === '/api/admin/tracks' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });
    if (!requireAdmin(req, res)) return;

    const contentType = String(req.headers['content-type'] || '');
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!/^multipart\/form-data/i.test(contentType) || !match) {
      return sendJSON(res, 400, { error: 'Formato de subida no válido' });
    }
    const boundary = match[1] || match[2];
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) {
      return sendJSON(res, 413, { error: 'El archivo supera el máximo de 400 MB' });
    }

    let parsed;
    try {
      parsed = await parseMultipart(req, boundary, MUSIC_DIR);
    } catch (error) {
      return sendJSON(res, 400, { error: error.message || 'No se pudo subir el archivo' });
    }

    if (!parsed.file) return sendJSON(res, 400, { error: 'Selecciona un archivo de audio' });

    const { fields, file } = parsed;
    const base = path.basename(file.fileName, path.extname(file.fileName));
    const record = {
      title: sanitizeField(fields.title) || cleanName(base),
      artist: sanitizeField(fields.artist) || 'Artista desconocido',
      album: sanitizeField(fields.album),
      genre: sanitizeField(fields.genre),
      year: sanitizeField(fields.year, 20),
      description: sanitizeField(fields.description, 600),
      password: null,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const password = String(fields.password || '');
    if (password.length < 4) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        /* nada que borrar */
      }
      return sendJSON(res, 400, {
        error: password
          ? 'La contraseña de la pista debe tener al menos 4 caracteres'
          : 'La contraseña de la pista es obligatoria',
      });
    }
    record.password = makePasswordRecord(password);

    metaStore().tracks[file.fileName] = record;
    saveMeta();

    const track = buildTracks({ adminView: true }).find((item) => item.file === file.fileName);
    return sendJSON(res, 201, { ok: true, track });
  }

  if (pathname.startsWith('/api/admin/tracks/')) {
    if (!requireAdmin(req, res)) return;
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: 'Origen no permitido' });

    const id = pathname.slice('/api/admin/tracks/'.length);
    const track = fileTracks().find((item) => item.id === id);
    if (!track) return sendJSON(res, 404, { error: 'Pista no encontrada' });

    if (method === 'DELETE') {
      try {
        fs.unlinkSync(track.file);
      } catch {
        return sendJSON(res, 500, { error: 'No se pudo borrar el archivo' });
      }
      delete metaStore().tracks[track.fileName];
      saveMeta();
      const grants = readGrants(req);
      if (grants.delete(track.id)) writeGrants(res, grants);
      return sendJSON(res, 200, { ok: true });
    }

    if (method === 'PUT' || method === 'PATCH') {
      let body;
      try {
        body = await readJSON(req);
      } catch (error) {
        return sendJSON(res, 400, { error: error.message });
      }
      const meta = metaStore().tracks;
      const record = meta[track.fileName] || {};
      for (const key of META_FIELDS) {
        if (key in body) record[key] = sanitizeField(body[key], key === 'description' ? 600 : 300);
      }
      if (typeof body.password === 'string' && body.password) {
        if (body.password.length < 4) {
          return sendJSON(res, 400, { error: 'La contraseña de la pista debe tener al menos 4 caracteres' });
        }
        record.password = makePasswordRecord(body.password);
      }
      if (body.clearPassword === true) record.password = null;
      record.updatedAt = new Date().toISOString();
      if (!record.addedAt) record.addedAt = record.updatedAt;
      meta[track.fileName] = record;
      saveMeta();
      const updated = buildTracks({ adminView: true }).find((item) => item.id === id);
      return sendJSON(res, 200, { ok: true, track: updated });
    }

    return sendJSON(res, 405, { error: 'Método no permitido' });
  }

  return sendJSON(res, 404, { error: 'Ruta no encontrada' });
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let pathname;
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Solicitud inválida');
  }

  try {
    if (pathname === '/healthz') {
      return sendJSON(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    if (pathname.startsWith('/api/')) {
      applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      return await handleApi(req, res, pathname);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Método no permitido');
    }

    if (pathname.startsWith('/stream/')) {
      const id = pathname.slice('/stream/'.length);
      const token = url.searchParams.get('t');
      const track = fileTracks().find((item) => item.id === id);
      if (!track) return sendText(res, 404, 'Pista no encontrada');
      if (!verifyStream(id, token)) return sendText(res, 403, 'Enlace no válido o expirado');
      return streamTrack(req, res, track);
    }

    if (pathname === '/music/tracks.json') {
      return serveStatic(req, res, path.join(MUSIC_DIR, 'tracks.json'));
    }
    if (pathname === '/music' || pathname.startsWith('/music/')) {
      return sendText(res, 404, 'No disponible');
    }
    if (BLOCKED_PATHS.has(pathname) || BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return sendText(res, 404, 'No disponible');
    }

    const page = PAGES.get(pathname.replace(/\/+$/, '') || '/');
    if (page) return serveStatic(req, res, path.join(PUBLIC_DIR, page));

    const relative = pathname.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relative);
    if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
      return sendText(res, 403, 'Acceso denegado');
    }
    return serveStatic(req, res, resolved);
  } catch (error) {
    if (!res.headersSent) {
      return sendJSON(res, 500, { error: error.message || 'Error interno' });
    }
    res.destroy();
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${PORT} ya está ocupado. Prueba con DARKWAVES_PORT=4322 npm run dev\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = process.env.DARKWAVES_PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`\n  DrakoTheProducer Player listo en ${base}`);
  console.log(`  Panel de administración: ${base}/admin`);
  console.log(`  Usuarios del panel: ${Object.keys(users).length}`);
  console.log(`  Escuchando en ${HOST}:${PORT}`);
  console.log(`  Música: ${MUSIC_DIR}`);
  console.log(`  Datos:  ${DATA_DIR}`);
  console.log(`  Cookies Secure: ${SECURE_COOKIES ? 'sí' : 'no'}`);
  if (!SECURE_COOKIES) {
    console.log('  En el host de producción define NODE_ENV=production\n');
  } else {
    console.log('');
  }
});
