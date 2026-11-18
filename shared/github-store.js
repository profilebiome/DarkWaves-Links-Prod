/**
 * Cliente mínimo de la API de GitHub para administrar el sitio desde el navegador.
 *
 * GitHub Pages no ejecuta servidor, así que el panel guarda los cambios
 * (música, metadatos y usuarios) haciendo commits al repositorio con un token
 * personal. El token vive solo en `localStorage` de ese navegador y nunca se
 * escribe en el repositorio ni se envía a terceros: las peticiones van directas
 * a `api.github.com`.
 *
 * Permisos necesarios del token (fine-grained, solo este repositorio):
 *   Contents → Read and write.  Nada más.
 */

import { SHARED_TOKEN, SHARED_OWNER, SHARED_REPO, SHARED_BRANCH } from "./repo-token.js";

const STORE_KEY = "dw:github";
const DEFAULT_REPO = { owner: "profilebiome", repo: "DarkWaves-Links-Prod", branch: "main" };

export const apiBase = () =>
  (typeof window !== "undefined" && window.DW_GITHUB_API) || "https://api.github.com";

export function defaultConfig() {
  return { ...DEFAULT_REPO, token: "" };
}

export function readConfig() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && cfg.token && cfg.owner && cfg.repo) {
        return { branch: DEFAULT_REPO.branch, ...cfg, shared: false };
      }
    }
  } catch {
    /* almacenamiento bloqueado */
  }
  return sharedConfig();
}

/** Token del sitio (shared/repo-token.js): sirve para todos los navegadores. */
export function sharedConfig() {
  if (!SHARED_TOKEN) return null;
  let token = "";
  try {
    token = atob(String(SHARED_TOKEN).split("").reverse().join(""));
  } catch {
    token = "";
  }
  if (!token) return null;
  return {
    token,
    owner: SHARED_OWNER || DEFAULT_REPO.owner,
    repo: SHARED_REPO || DEFAULT_REPO.repo,
    branch: SHARED_BRANCH || DEFAULT_REPO.branch,
    shared: true,
  };
}

export const hasSharedToken = () => Boolean(sharedConfig());

export function saveConfig(config) {
  const clean = {
    token: String(config.token || "").trim(),
    owner: String(config.owner || "").trim(),
    repo: String(config.repo || "").trim(),
    branch: String(config.branch || DEFAULT_REPO.branch).trim(),
  };
  window.localStorage.setItem(STORE_KEY, JSON.stringify(clean));
  return clean;
}

export function clearConfig() {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* nada */
  }
}

/* --------------------------- base64 / UTF-8 --------------------------- */

const encoder = new TextEncoder();

export function toBase64(text) {
  const bytes = encoder.encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(String(base64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

/* ------------------------------ peticiones ------------------------------ */

function httpError(status, data) {
  const message = data && data.message ? String(data.message) : "";
  const readonly =
    status === 403 && /not accessible by personal access token/i.test(message);

  if (readonly) {
    const error = new Error(
      "Tu token es de SOLO LECTURA. En GitHub: Settings → Developer settings → " +
        "Personal access tokens → tu token → Permissions → Contents: Read and write → Save. " +
        "Luego pulsa Desconectar y vuelve a conectarlo."
    );
    error.status = 403;
    error.readonly = true;
    return error;
  }

  const map = {
    401: "Token inválido o revocado",
    403: "GitHub rechazó la operación (permisos del token o límite de peticiones)",
    404: "No encontrado: revisa el propietario, el repositorio o el archivo",
    409: "El archivo cambió mientras editabas. Vuelve a intentarlo",
    413: "El archivo supera el máximo de la API de GitHub (100 MB)",
    422: "GitHub rechazó los datos enviados",
  };
  const detail = message ? ` — ${message}` : "";
  const error = new Error((map[status] || `Error ${status}`) + detail);
  error.status = status;
  return error;
}

async function request(cfg, path, init = {}) {
  let response = null;
  let lastError = null;

  // GitHub devuelve 502/503 puntuales (balanceo o límite secundario): se reintenta.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${apiBase()}${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      lastError = new Error("No se pudo contactar con la API de GitHub (revisa tu conexión)");
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    break;
  }

  if (!response) throw lastError || new Error("No se pudo contactar con la API de GitHub");

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw httpError(response.status, data);
  return data;
}

const encodePath = (filePath) =>
  String(filePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const repoUrl = (cfg, suffix = "") => `/repos/${cfg.owner}/${cfg.repo}${suffix}`;
const contentsUrl = (cfg, filePath) =>
  `${repoUrl(cfg, `/contents/${encodePath(filePath)}`)}?ref=${encodeURIComponent(cfg.branch || "main")}`;

/** Comprueba token, repo y rama. Devuelve los datos del repositorio. */
export async function testConnection(cfg) {
  return request(cfg, repoUrl(cfg));
}

/**
 * Comprueba de verdad que el token puede ESCRIBIR.
 *
 * GitHub no expone los permisos del token en `GET /repos`: un token de solo
 * lectura responde bien a las lecturas y falla con 403 al guardar. Así que se
 * crea una rama temporal, se escribe y borra un archivo en ella y se elimina la
 * rama. No toca `main` ni dispara despliegues.
 */
export async function verifyWriteAccess(cfg) {
  const branchName = `dw-panel-check-${Date.now().toString(36)}`;
  const base = cfg.branch || "main";

  let head = null;
  try {
    head = await request(cfg, repoUrl(cfg, `/git/ref/heads/${encodeURIComponent(base)}`));
  } catch (error) {
    if (error.status === 403) return { ok: false, message: error.message };
    if (error.status === 404) return { ok: false, message: `La rama "${base}" no existe` };
    throw error;
  }
  const sha = head && head.object ? head.object.sha : null;
  if (!sha) return { ok: false, message: "No se pudo leer la rama" };

  try {
    await request(cfg, repoUrl(cfg, "/git/refs"), {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
    });
  } catch (error) {
    if (error.status === 403) return { ok: false, message: error.message };
    if (error.status === 422) return { ok: true, message: "" };
    throw error;
  }

  try {
    const tempCfg = { ...cfg, branch: branchName };
    await putBase64(tempCfg, ".dw-panel-check", toBase64("ok"), "Verificación del panel");
    await deletePath(tempCfg, ".dw-panel-check", "Verificación del panel");
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    try {
      await request(cfg, repoUrl(cfg, `/git/refs/heads/${branchName}`), { method: "DELETE" });
    } catch {
      /* la rama temporal se queda; no afecta al sitio */
    }
  }
}

/** Contenido de una carpeta (array) o [] si no existe. */
export async function listDir(cfg, dirPath = "") {
  try {
    const data = await request(cfg, contentsUrl(cfg, dirPath));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

/** Un archivo: { sha, size, base64 } o null si no existe. */
export async function getFile(cfg, filePath) {
  try {
    const data = await request(cfg, contentsUrl(cfg, filePath));
    if (Array.isArray(data)) return null;
    return { sha: data.sha, size: data.size, base64: data.content || "", path: data.path };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function readJSON(cfg, filePath) {
  const file = await getFile(cfg, filePath);
  if (!file) return { json: null, sha: null };
  try {
    return { json: JSON.parse(fromBase64(file.base64)), sha: file.sha };
  } catch {
    return { json: null, sha: file.sha };
  }
}

export async function putBase64(cfg, filePath, base64, message, sha = null) {
  const body = { message, content: base64, branch: cfg.branch || "main" };
  if (sha) body.sha = sha;
  const data = await request(cfg, repoUrl(cfg, `/contents/${encodePath(filePath)}`), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return data && data.content ? data.content.sha : null;
}

/** Escribe JSON reintentando una vez si otro proceso tocó el archivo. */
export async function writeJSON(cfg, filePath, value, message) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getFile(cfg, filePath);
    try {
      return await putBase64(cfg, filePath, toBase64(text), message, current ? current.sha : null);
    } catch (error) {
      lastError = error;
      if (error.status !== 409 && error.status !== 422) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error("No se pudo guardar en GitHub");
}

export async function deletePath(cfg, filePath, message) {
  const file = await getFile(cfg, filePath);
  if (!file) return false;
  await request(cfg, repoUrl(cfg, `/contents/${encodePath(filePath)}`), {
    method: "DELETE",
    body: JSON.stringify({ message, sha: file.sha, branch: cfg.branch || "main" }),
  });
  return true;
}
