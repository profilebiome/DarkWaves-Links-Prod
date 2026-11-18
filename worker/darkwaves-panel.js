/**
 * DarkWaves — proxy del panel para Cloudflare Workers (plan gratuito).
 *
 * Por qué existe: para que el panel escriba en GitHub hace falta un token, y un
 * token dentro de un sitio público lo lee cualquiera (además GitHub lo revoca).
 * Este Worker guarda el token como secreto en el servidor: el navegador solo
 * envía usuario y contraseña del panel, y el Worker habla con GitHub.
 *
 * Rutas:
 *   GET  /            → estado
 *   POST /proxy       → { user, password, path, method, body } → GitHub API
 *
 * Variables y secretos (Cloudflare → Worker → Settings):
 *   GITHUB_TOKEN    (secreto) token fine-grained con Contents: Read and write
 *   REPO            profilebiome/DarkWaves-Links-Prod
 *   BRANCH          main
 *   ALLOWED_ORIGIN  https://josspreview.profilebio.me
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function reply(body, status = 200, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || '';
  const allow = allowed === '*' || allowed === origin ? (allowed === '*' ? '*' : origin) : allowed;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

function decodeBase64Utf8(base64) {
  const binary = atob(String(base64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'darkwaves-panel',
  };
}

async function readAccounts(env) {
  const repo = env.REPO || 'profilebiome/DarkWaves-Links-Prod';
  const branch = env.BRANCH || 'main';
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/shared/accounts.json?ref=${branch}`,
    { headers: githubHeaders(env), cf: { cacheTtl: 0 } }
  );
  if (!response.ok) return null;
  const file = await response.json();
  try {
    return JSON.parse(decodeBase64Utf8(file.content));
  } catch {
    return null;
  }
}

async function verifyPassword(record, password) {
  if (!record || !record.salt || !record.hash || !password) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(record.salt), iterations: Number(record.iterations) || 210000, hash: 'SHA-256' },
    key,
    256
  );
  const attempt = hex(bits);
  if (attempt.length !== record.hash.length) return false;
  let diff = 0;
  for (let index = 0; index < attempt.length; index += 1) {
    diff |= attempt.charCodeAt(index) ^ record.hash.charCodeAt(index);
  }
  return diff === 0;
}

/** Solo se permite tocar este repositorio, y solo contents/git. */
function pathAllowed(env, path) {
  const repo = env.REPO || 'profilebiome/DarkWaves-Links-Prod';
  const [owner, name] = repo.split('/');
  const prefix = `/repos/${owner}/${name}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.startsWith('contents/') || rest.startsWith('git/');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/healthz') {
      return reply({ ok: true, service: 'darkwaves-panel' }, 200, cors);
    }
    if (url.pathname !== '/proxy') return reply({ error: 'Ruta no encontrada' }, 404, cors);
    if (request.method !== 'POST') return reply({ error: 'Método no permitido' }, 405, cors);
    if (!env.GITHUB_TOKEN) return reply({ error: 'Falta el secreto GITHUB_TOKEN en el Worker' }, 500, cors);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return reply({ error: 'JSON inválido' }, 400, cors);
    }

    const user = String(payload.user || '').trim().toLowerCase();
    const password = String(payload.password || '');
    const path = String(payload.path || '');
    const method = String(payload.method || 'GET').toUpperCase();

    if (!user || !password) return reply({ error: 'Faltan usuario y contraseña' }, 400, cors);
    if (!pathAllowed(env, path)) return reply({ error: 'Ruta no permitida' }, 403, cors);
    if (!['GET', 'PUT', 'POST', 'DELETE'].includes(method)) {
      return reply({ error: 'Método no permitido' }, 405, cors);
    }

    const accounts = await readAccounts(env);
    if (!accounts || !accounts.users) return reply({ error: 'No se pudieron leer las cuentas' }, 503, cors);
    const record = accounts.users[user];
    if (!record || !(await verifyPassword(record, password))) {
      return reply({ error: 'Usuario o contraseña incorrectos' }, 401, cors);
    }

    const init = { method, headers: githubHeaders(env) };
    if (payload.body !== undefined && payload.body !== null) {
      init.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }

    const github = await fetch(`https://api.github.com${path}`, init);
    const text = await github.text();
    return new Response(text, {
      status: github.status,
      headers: { ...cors, 'Content-Type': github.headers.get('content-type') || 'application/json' },
    });
  },
};
