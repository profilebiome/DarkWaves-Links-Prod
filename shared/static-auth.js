/**
 * Verificación de credenciales sin servidor (GitHub Pages).
 *
 * En el sitio estático no hay backend: las cuentas se comprueban en el
 * navegador contra `shared/accounts.json` (hash PBKDF2, nunca la contraseña) y
 * las contraseñas de pista contra el `key` de `music/tracks.json`.
 *
 * Límite honesto: cualquiera puede leer esos hashes y atacarlos offline, y el
 * audio del repositorio es público. Esto es una puerta de entrada, no
 * seguridad real. Con el servidor (`npm run dev` o el host Node) la
 * verificación ocurre en el backend y el audio sale por enlaces firmados.
 */

const ACCOUNTS_URL = "shared/accounts.json";
const TRACKS_URL = "music/tracks.json";
const SESSION_KEY = "dw:static-session";
const GRANTS_KEY = "dw:static-grants";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const GRANT_TTL = 12 * 60 * 60 * 1000;
export const PBKDF2_ITERATIONS = 210000;

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJSON(store, key, fallback) {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(store, key, value) {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento bloqueado */
  }
}

async function derive(password, record) {
  const subtle = window.crypto && window.crypto.subtle;
  if (!subtle) return null;
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(record.salt),
      iterations: Number(record.iterations) || 210000,
      hash: "SHA-256",
    },
    key,
    256
  );
  return hex(bits);
}

/** Compara sin cortocircuitos para no filtrar el prefijo correcto. */
function equalHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function verifyPasswordRecord(record, password) {
  if (!record || !record.salt || !record.hash || !password) return false;
  try {
    const attempt = await derive(password, record);
    return equalHex(attempt, record.hash);
  } catch {
    return false;
  }
}

/** Genera un registro PBKDF2 nuevo (crear usuario o cambiar clave de pista). */
export async function makePasswordRecord(password) {
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const hash = await derive(password, { salt, iterations: PBKDF2_ITERATIONS });
  if (!hash) throw new Error("Este navegador no puede cifrar contraseñas (necesita HTTPS)");
  return { salt, iterations: PBKDF2_ITERATIONS, hash };
}

async function fetchJSON(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadStaticAccounts() {
  const data = await fetchJSON(ACCOUNTS_URL);
  return data && data.users ? data.users : {};
}

/**
 * @returns {Promise<{user: string, owner: boolean}|null>} null si no coincide.
 */
export async function staticLogin(user, password) {
  const name = String(user || "").trim().toLowerCase();
  if (!name || !password) return null;
  const users = await loadStaticAccounts();
  if (!Object.keys(users).length) {
    throw new Error("No se pudo cargar shared/accounts.json. Recarga con Ctrl+Shift+R.");
  }
  const record = users[name];
  if (!record) return null;
  const ok = await verifyPasswordRecord(record, password);
  if (!ok) return null;
  const session = { user: name, owner: Boolean(record.owner), exp: Date.now() + SESSION_TTL };
  writeJSON(await storage(), SESSION_KEY, session);
  return { user: name, owner: Boolean(record.owner) };
}

export async function readStaticSession() {
  const store = await storage();
  const session = readJSON(store, SESSION_KEY, null);
  if (!session || !session.user || !session.exp || session.exp < Date.now()) return null;
  return session;
}

export async function clearStaticSession() {
  const store = await storage();
  if (!store) return;
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    /* nada */
  }
}

export async function countStaticAccounts() {
  return Object.keys(await loadStaticAccounts()).length;
}

async function grants() {
  const store = await storage();
  const data = readJSON(store, GRANTS_KEY, {});
  const now = Date.now();
  const live = {};
  for (const [file, exp] of Object.entries(data || {})) {
    if (Number(exp) > now) live[file] = Number(exp);
  }
  return { store, live };
}

/** Desbloquea una pista comprobando su `key` en music/tracks.json. */
export async function staticUnlockTrack(file, password) {
  const data = await fetchJSON(TRACKS_URL);
  const list = data && Array.isArray(data.tracks) ? data.tracks : [];
  const track = list.find((item) => item && item.file === file);
  if (!track) return { ok: false, error: "Pista no encontrada" };
  if (!track.key) return { ok: false, error: "Esta pista todavía no tiene contraseña. Asígnale una desde el panel." };
  const ok = await verifyPasswordRecord(track.key, password);
  if (!ok) return { ok: false, error: "Contraseña incorrecta" };

  const { store, live } = await grants();
  live[file] = Date.now() + GRANT_TTL;
  writeJSON(store, GRANTS_KEY, live);
  return { ok: true, error: "" };
}

export async function hasStaticGrant(file) {
  const { live } = await grants();
  return Boolean(live[file]);
}

/** Marca como desbloqueadas las pistas con permiso guardado. */
export async function applyStaticGrants(tracks) {
  const { live } = await grants();
  let changed = false;
  for (const track of tracks) {
    if (!track || !track.locked) continue;
    if (live[track.id] || live[track.file]) {
      track.locked = false;
      changed = true;
    }
  }
  return changed;
}
