/**
 * Panel de administración sin servidor: implementa las mismas rutas que
 * `server.mjs` (`/api/admin/...`) pero guardando en el repositorio de GitHub.
 *
 * Flujo: el administrador pega una vez un token fine-grained (Contents:
 * Read and write) y el panel escribe `music/`, `music/tracks.json` y
 * `shared/accounts.json` con commits. GitHub Pages se reconstruye solo.
 *
 * Reglas que se mantienen igual que en el servidor:
 *   - Solo la cuenta principal (owner) crea, borra o restablece usuarios.
 *   - Cada pista puede tener su contraseña; la clave se guarda como PBKDF2.
 *   - Cualquier cuenta puede subir música y editar pistas.
 */
import {
  readConfig, readJSON, writeJSON, putBase64, deletePath, listDir, fileToBase64,
} from "./github-store.js";
import {
  makePasswordRecord, verifyPasswordRecord, readStaticSession, clearStaticSession,
} from "./static-auth.js";

const TRACKS_PATH = "music/tracks.json";
const ACCOUNTS_PATH = "shared/accounts.json";
const MUSIC_DIR = "music";
const USER_NAME = /^[a-z0-9._-]{3,32}$/;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;

export const isConnected = () => Boolean(readConfig());

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function sha1Hex(text) {
  const buffer = await window.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Mismo id que usa el servidor: sha1(nombre de archivo) recortado a 16. */
async function trackId(fileName) {
  return (await sha1Hex(fileName)).slice(0, 16);
}

/** Mismo saneado de nombre que `server.mjs`. */
function safeFileName(name) {
  const base = String(name || "pista").split(/[\\/]/).pop();
  const ext = (base.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (!AUDIO_EXT.test(ext)) return null;
  let stem = base
    .slice(0, base.length - ext.length)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!stem) stem = "pista";
  if (stem.length > 90) stem = stem.slice(0, 90).trim();
  return `${stem}${ext}`;
}

async function loadTracks(cfg) {
  const { json } = await readJSON(cfg, TRACKS_PATH);
  const tracks = json && Array.isArray(json.tracks) ? json.tracks : [];
  const entries = await listDir(cfg, MUSIC_DIR);
  const sizes = {};
  for (const entry of entries) {
    if (entry && entry.type === "file") sizes[entry.name] = entry.size;
  }
  return { tracks, sizes };
}

function publicTrack(track, size, id) {
  const ext = track.ext || (String(track.file || "").match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  return {
    id,
    file: track.file,
    title: track.title || track.file,
    artist: track.artist || "",
    album: track.album || "",
    genre: track.genre || "",
    year: track.year || "",
    description: track.description || "",
    ext,
    size: Number(size) || 0,
    hasPassword: Boolean(track.key),
    locked: Boolean(track.key),
  };
}

async function requireSession() {
  const session = await readStaticSession();
  if (!session) throw httpError("Sesión caducada, vuelve a entrar", 401);
  return session;
}

async function loadAccounts(cfg) {
  const { json } = await readJSON(cfg, ACCOUNTS_PATH);
  const users = (json && json.users) || {};
  return { data: json || { version: 1, users: {} }, users };
}

async function saveAccounts(cfg, data, message) {
  const payload = { ...data, version: 1, updatedAt: new Date().toISOString() };
  await writeJSON(cfg, ACCOUNTS_PATH, payload, message);
  return payload;
}

async function saveTracks(cfg, tracks, message) {
  const sorted = [...tracks].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "es"));
  await writeJSON(cfg, TRACKS_PATH, { tracks: sorted }, message);
  return sorted;
}

/* ------------------------------------------------------------------ */
/* subida de una pista                                                 */
/* ------------------------------------------------------------------ */

export async function staticUpload(formData, onProgress = () => {}) {
  const cfg = readConfig();
  if (!cfg) throw httpError("Conecta tu token de GitHub para subir música", 428);
  await requireSession();

  const file = formData.get("file");
  const name = file && file.name ? safeFileName(file.name) : null;
  if (!name) throw httpError("Formato de audio no admitido", 400);

  const password = String(formData.get("password") || "");
  if (password.length < 4) throw httpError("La contraseña de la pista necesita al menos 4 caracteres", 400);

  onProgress(0.05);
  const base64 = await fileToBase64(file);
  onProgress(0.4);

  const { tracks } = await loadTracks(cfg);
  let finalName = name;
  let counter = 2;
  while (tracks.some((track) => track.file === finalName)) {
    finalName = name.replace(/(\.[a-z0-9]+)$/i, ` (${counter})$1`);
    counter += 1;
  }

  await putBase64(cfg, `${MUSIC_DIR}/${finalName}`, base64, `Subir pista: ${finalName}`);
  onProgress(0.75);

  const stem = finalName.replace(/\.[a-z0-9]+$/i, "");
  const entry = {
    file: finalName,
    title: String(formData.get("title") || "").trim() || stem,
    artist: String(formData.get("artist") || "").trim() || "Artista desconocido",
    ext: (finalName.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase(),
  };
  for (const field of ["album", "genre", "year", "description"]) {
    const value = String(formData.get(field) || "").trim();
    if (value) entry[field] = value;
  }
  entry.key = await makePasswordRecord(password);
  entry.locked = true;

  const next = [...tracks, entry];
  await saveTracks(cfg, next, `Metadatos: ${finalName}`);
  onProgress(1);

  return { ok: true, track: publicTrack(entry, file.size, await trackId(finalName)) };
}

/* ------------------------------------------------------------------ */
/* adaptador de /api/admin/*                                           */
/* ------------------------------------------------------------------ */

export async function staticApi(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const parseBody = () => {
    if (!options.body) return {};
    if (typeof options.body !== "string") return options.body;
    try {
      return JSON.parse(options.body);
    } catch {
      return {};
    }
  };
  const body = parseBody();

  if (url === "/api/admin/session") {
    const session = await readStaticSession();
    if (!session) throw httpError("Sin sesión", 401);
    return { authenticated: true, user: session.user, owner: session.owner, static: true };
  }

  if (url === "/api/admin/logout") {
    await clearStaticSession();
    return { ok: true };
  }

  const cfg = readConfig();
  if (!cfg) {
    throw httpError("Conecta tu token de GitHub (Contents: Read and write) para administrar desde aquí", 428);
  }

  /* ------------------------------ pistas ------------------------------ */

  if (url === "/api/admin/tracks" && method === "GET") {
    const { tracks, sizes } = await loadTracks(cfg);
    const list = [];
    for (const track of tracks) {
      list.push(publicTrack(track, sizes[track.file], await trackId(track.file)));
    }
    return { tracks: list };
  }

  if (url === "/api/admin/tracks" && method === "POST") {
    if (!(options.body instanceof FormData)) throw httpError("Subida inválida", 400);
    return staticUpload(options.body);
  }

  const trackMatch = url.match(/^\/api\/admin\/tracks\/([^/]+)$/);
  if (trackMatch) {
    await requireSession();
    const wanted = decodeURIComponent(trackMatch[1]);
    const { tracks } = await loadTracks(cfg);
    let index = -1;
    let entry = null;
    for (let position = 0; position < tracks.length; position += 1) {
      if ((await trackId(tracks[position].file)) === wanted) {
        index = position;
        entry = tracks[position];
        break;
      }
    }
    if (!entry) throw httpError("Pista no encontrada", 404);

    if (method === "PATCH" || method === "PUT") {
      for (const field of ["title", "artist", "album", "genre", "year", "description"]) {
        if (field in body) entry[field] = String(body[field] || "").trim();
      }
      if (body.clearPassword === true) {
        delete entry.key;
        delete entry.locked;
      } else if (typeof body.password === "string" && body.password) {
        if (body.password.length < 4) throw httpError("La contraseña necesita al menos 4 caracteres", 400);
        entry.key = await makePasswordRecord(body.password);
        entry.locked = true;
      }
      const next = [...tracks];
      next[index] = entry;
      await saveTracks(cfg, next, `Editar pista: ${entry.file}`);
      return { ok: true };
    }

    if (method === "DELETE") {
      await deletePath(cfg, `${MUSIC_DIR}/${entry.file}`, `Borrar audio: ${entry.file}`);
      const next = tracks.filter((track) => track.file !== entry.file);
      await saveTracks(cfg, next, `Borrar pista: ${entry.file}`);
      return { ok: true };
    }
  }

  /* ------------------------------ usuarios ------------------------------ */

  if (url === "/api/admin/users" && method === "GET") {
    const session = await requireSession();
    const { users } = await loadAccounts(cfg);
    return {
      users: Object.entries(users).map(([name, record]) => ({
        user: name,
        owner: Boolean(record.owner),
        createdAt: record.createdAt || "",
      })),
      you: session.user,
      owner: Boolean(users[session.user] && users[session.user].owner),
    };
  }

  if (url === "/api/admin/users" && method === "POST") {
    const session = await requireSession();
    const { data, users } = await loadAccounts(cfg);
    if (!users[session.user] || !users[session.user].owner) {
      throw httpError("Solo la cuenta principal crea usuarios", 403);
    }
    const name = String(body.user || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!USER_NAME.test(name)) throw httpError("Usuario no válido: 3-32 caracteres, minúsculas, números, . _ -", 400);
    if (users[name]) throw httpError("Ese usuario ya existe", 409);
    if (password.length < 4) throw httpError("La contraseña necesita al menos 4 caracteres", 400);

    users[name] = { ...(await makePasswordRecord(password)), createdAt: new Date().toISOString() };
    await saveAccounts(cfg, { ...data, users }, `Crear usuario: ${name}`);
    return { ok: true };
  }

  const userPasswordMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (userPasswordMatch && method === "POST") {
    const session = await requireSession();
    const { data, users } = await loadAccounts(cfg);
    if (!users[session.user] || !users[session.user].owner) {
      throw httpError("Solo la cuenta principal restablece contraseñas", 403);
    }
    const name = decodeURIComponent(userPasswordMatch[1]).toLowerCase();
    if (!users[name]) throw httpError("Ese usuario no existe", 404);
    const password = String(body.password || "");
    if (password.length < 4) throw httpError("La contraseña necesita al menos 4 caracteres", 400);
    const record = users[name];
    users[name] = {
      ...(await makePasswordRecord(password)),
      ...(record.owner ? { owner: true } : {}),
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveAccounts(cfg, { ...data, users }, `Contraseña de ${name}`);
    return { ok: true };
  }

  const userMatch = url.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && method === "DELETE") {
    const session = await requireSession();
    const { data, users } = await loadAccounts(cfg);
    if (!users[session.user] || !users[session.user].owner) {
      throw httpError("Solo la cuenta principal borra usuarios", 403);
    }
    const name = decodeURIComponent(userMatch[1]).toLowerCase();
    if (name === session.user) throw httpError("No puedes borrar tu propia cuenta", 400);
    if (!users[name]) throw httpError("Ese usuario no existe", 404);
    if (users[name].owner) throw httpError("La cuenta principal no se puede borrar", 400);
    delete users[name];
    await saveAccounts(cfg, { ...data, users }, `Borrar usuario: ${name}`);
    return { ok: true };
  }

  /* ------------------------- propia contraseña ------------------------- */

  if (url === "/api/admin/password" && method === "POST") {
    const session = await requireSession();
    const { data, users } = await loadAccounts(cfg);
    const record = users[session.user];
    if (!record) throw httpError("Cuenta no encontrada", 404);
    const current = String(body.current || "");
    const next = String(body.next || "");
    if (!(await verifyPasswordRecord(record, current))) throw httpError("La contraseña actual no es correcta", 401);
    if (next.length < 4) throw httpError("La contraseña nueva necesita al menos 4 caracteres", 400);
    users[session.user] = {
      ...(await makePasswordRecord(next)),
      ...(record.owner ? { owner: true } : {}),
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveAccounts(cfg, { ...data, users }, `Contraseña de ${session.user}`);
    return { ok: true };
  }

  throw httpError("Ruta no encontrada", 404);
}
