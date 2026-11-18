/**
 * DarkWaves — backend del panel en Cloudflare Workers (plan gratuito).
 *
 * El panel del sitio publicado (GitHub Pages) llama a este Worker con el usuario
 * y la contraseña del panel (autenticación básica). El Worker:
 *
 *   · verifica la contraseña contra `shared/accounts.json` (PBKDF2, WebCrypto)
 *   · lee y escribe `music/`, `music/tracks.json` y `shared/accounts.json`
 *     en el repositorio con un token que vive AQUÍ, nunca en el navegador
 *
 * Endpoints (los mismos que el servidor local):
 *   GET    /healthz
 *   GET    /api/admin/session
 *   GET    /api/admin/tracks
 *   POST   /api/admin/tracks              (multipart: file, title, artist, …, password)
 *   PUT    /api/admin/tracks/:id          (JSON: title, artist, …, password, clearPassword)
 *   DELETE /api/admin/tracks/:id
 *   GET    /api/admin/users
 *   POST   /api/admin/users               (JSON: user, password)
 *   POST   /api/admin/users/:name/password (JSON: password)
 *   DELETE /api/admin/users/:name
 *   POST   /api/admin/password            (JSON: current, next)
 *
 * Secretos (Cloudflare → Worker → Settings → Variables):
 *   GITHUB_TOKEN    token fine-grained con Contents: Read and write
 *   REPO            profilebiome/DarkWaves-Links-Prod
 *   BRANCH          main
 *   ALLOWED_ORIGIN  https://josspreview.profilebio.me
 */

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;
const USER_NAME = /^[a-z0-9._-]{3,32}$/;
const PBKDF2_ITERATIONS = 100000;
const TRACKS_PATH = 'music/tracks.json';
const ACCOUNTS_PATH = 'shared/accounts.json';
const MUSIC_DIR = 'music';

const cors = (env, request) => {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || '';
  const allow = allowed === '*' ? '*' : allowed.split(',').map((item) => item.trim()).includes(origin) ? origin : allowed.split(',')[0].trim();
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  };
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const decodeBase64Utf8 = (base64) => {
  const binary = atob(String(base64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
};

const encodeBase64Utf8 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const bytesToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const repoUrl = (env, suffix = '') => `/repos/${env.REPO || 'profilebiome/DarkWaves-Links-Prod'}${suffix}`;
const contentsUrl = (env, filePath) =>
  `${repoUrl(env, `/contents/${String(filePath).split('/').map(encodeURIComponent).join('/')}`)}?ref=${env.BRANCH || 'main'}`;

async function gh(env, pathname, init = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
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
    const message = data && data.message ? data.message : String(response.status);
    const error = new Error(`GitHub ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function readJSON(env, filePath) {
  try {
    const file = await gh(env, contentsUrl(env, filePath));
    if (!file || Array.isArray(file)) return { json: null, sha: null };
    return { json: JSON.parse(decodeBase64Utf8(file.content)), sha: file.sha };
  } catch (error) {
    if (error.status === 404) return { json: null, sha: null };
    throw error;
  }
}

async function writeJSON(env, filePath, value, message) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let sha = null;
    try {
      const current = await gh(env, contentsUrl(env, filePath));
      sha = current && current.sha ? current.sha : null;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    const body = { message, content: encodeBase64Utf8(`${JSON.stringify(value, null, 2)}\n`), branch: env.BRANCH || 'main' };
    if (sha) body.sha = sha;
    try {
      await gh(env, repoUrl(env, `/contents/${filePath}`), { method: 'PUT', body: JSON.stringify(body) });
      return;
    } catch (error) {
      if (error.status !== 409 && error.status !== 422) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error('No se pudo guardar en GitHub');
}

async function listMusic(env) {
  try {
    const list = await gh(env, contentsUrl(env, MUSIC_DIR));
    return Array.isArray(list) ? list : [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

const derive = async (password, salt, iterations) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: Number(iterations) || PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return hex(bits);
};

const sameText = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

async function verifyPassword(password, record) {
  if (!record || !password) return false;
  const key = record.pbkdf2 && record.pbkdf2.salt ? record.pbkdf2 : record;
  if (!key.salt || !key.hash) return false;
  const attempt = await derive(password, key.salt, key.iterations);
  return sameText(attempt, key.hash);
}

async function makePassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(saltBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return { salt, iterations: PBKDF2_ITERATIONS, hash };
}

async function loadAccounts(env) {
  const { json: data } = await readJSON(env, ACCOUNTS_PATH);
  const users = (data && data.users) || {};
  return { data: data || { version: 1, users: {} }, users };
}

async function authenticate(env, request) {
  const header = request.headers.get('Authorization') || '';
  if (!header.toLowerCase().startsWith('basic ')) return null;
  try {
    const raw = atob(header.slice(6).trim());
    const index = raw.indexOf(':');
    if (index < 0) return null;
    const name = raw.slice(0, index).trim().toLowerCase();
    const password = raw.slice(index + 1);
    const { users } = await loadAccounts(env);
    const record = users[name];
    if (!record) return null;
    if (!(await verifyPassword(password, record))) return null;
    return { user: name, owner: Boolean(record.owner) };
  } catch {
    return null;
  }
}

async function sha1Hex(text) {
  const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return hex(buffer);
}

const trackId = async (fileName) => (await sha1Hex(fileName)).slice(0, 16);

function safeFileName(name) {
  const base = String(name || 'pista').split(/[\\/]/).pop();
  const ext = (base.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (!AUDIO_EXT.test(ext)) return null;
  let stem = base
    .slice(0, base.length - ext.length)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!stem) stem = 'pista';
  if (stem.length > 90) stem = stem.slice(0, 90).trim();
  return `${stem}${ext}`;
}

/* ------------------------------------------------------------------ */
/* Audio: se sube como asset de un Release (streaming, sin base64)     */
/* ------------------------------------------------------------------ */

const RELEASE_TAG = 'audio';

async function ensureRelease(env) {
  try {
    const existing = await gh(env, repoUrl(env, `/releases/tags/${RELEASE_TAG}`));
    if (existing && existing.id) return existing;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return gh(env, repoUrl(env, '/releases'), {
    method: 'POST',
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: 'Audio del panel',
      body: 'Pistas subidas desde el panel. No borrar este release.',
    }),
  });
}

async function uploadAsset(env, releaseId, fileName, body, contentType, contentLength) {
  const repo = env.REPO || 'profilebiome/DarkWaves-Links-Prod';
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'darkwaves-panel',
    'Content-Type': contentType || 'audio/mpeg',
  };
  if (contentLength) headers['Content-Length'] = String(contentLength);
  const response = await fetch(
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
    { method: 'POST', headers, body, duplex: 'half' }
  );
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data && data.message ? data.message : `${response.status}`;
    throw new Error(`GitHub ${response.status}: ${message}`);
  }
  return data;
}

const AUDIO_TYPE = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', webm: 'audio/webm',
};

async function publicTracks(env) {
  const { json: data } = await readJSON(env, TRACKS_PATH);
  const list = data && Array.isArray(data.tracks) ? data.tracks : [];
  const files = await listMusic(env);
  const sizes = {};
  for (const file of files) if (file && file.type === 'file') sizes[file.name] = file.size;
  const out = [];
  for (const track of list) {
    out.push({
      id: await trackId(track.file),
      file: track.file,
      title: track.title || track.file,
      artist: track.artist || '',
      album: track.album || '',
      genre: track.genre || '',
      year: track.year || '',
      description: track.description || '',
      ext: track.ext || (String(track.file).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase(),
      size: Number(sizes[track.file]) || 0,
      hasPassword: Boolean(track.key),
      locked: Boolean(track.key),
    });
  }
  return { list, out };
}

async function saveTracks(env, tracks, message) {
  const sorted = [...tracks].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));
  await writeJSON(env, TRACKS_PATH, { version: 1, tracks: sorted }, message);
}

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/healthz') {
      return json({ ok: true, service: 'darkwaves-panel' }, 200, headers);
    }

    /* ------------------------- audio (público) ------------------------- */
    // Sirve el MP3/WAV alojado en el Release con CORS y soporte de rangos:
    // sin esto, Web Audio no puede analizar un archivo de otro dominio y el
    // reproductor se queda en bucle de error.
    if (pathname.startsWith('/audio/')) {
      const fileName = decodeURIComponent(pathname.slice('/audio/'.length));
      const release = await ensureRelease(env);
      const assets = await gh(env, repoUrl(env, `/releases/${release.id}/assets?per_page=100`));
      const asset = (assets || []).find((item) => item && item.name === fileName);
      if (!asset) return json({ error: 'Audio no encontrado' }, 404, headers);
      const range = request.headers.get('Range');
      const upstream = await fetch(`https://api.github.com/repos/${env.REPO || 'profilebiome/DarkWaves-Links-Prod'}/releases/assets/${asset.id}`, {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/octet-stream',
          'User-Agent': 'darkwaves-panel',
          ...(range ? { Range: range } : {}),
        },
      });
      const outHeaders = new Headers(headers);
      outHeaders.set('Content-Type', asset.content_type && asset.content_type !== 'application/octet-stream'
        ? asset.content_type
        : (AUDIO_TYPE[(fileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase()] || 'audio/mpeg'));
      outHeaders.set('Accept-Ranges', 'bytes');
      outHeaders.set('Cache-Control', 'public, max-age=3600');
      for (const name of ['Content-Length', 'Content-Range']) {
        const value = upstream.headers.get(name);
        if (value) outHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    }

    if (!pathname.startsWith('/api/admin/')) return json({ error: 'Ruta no encontrada' }, 404, headers);
    if (!env.GITHUB_TOKEN) return json({ error: 'Falta el secreto GITHUB_TOKEN en el Worker' }, 500, headers);

    const session = await authenticate(env, request);
    if (!session) {
      if (pathname === '/api/admin/session') return json({ authenticated: false }, 401, headers);
      return json({ error: 'Usuario o contraseña incorrectos' }, 401, headers);
    }

    try {
      if (pathname === '/api/admin/session') {
        return json({ authenticated: true, user: session.user, owner: session.owner }, 200, headers);
      }

      /* ---------------------------- pistas ---------------------------- */

      if (pathname === '/api/admin/tracks' && request.method === 'GET') {
        const { out } = await publicTracks(env);
        return json({ tracks: out }, 200, headers);
      }

      if (pathname === '/api/admin/tracks' && request.method === 'POST') {
        const params = url.searchParams;
        const name = safeFileName(params.get('name') || '');
        if (!name) return json({ error: 'Formato de audio no admitido' }, 400, headers);
        const password = String(params.get('password') || '');
        if (password.length < 4) return json({ error: 'La contraseña de la pista necesita al menos 4 caracteres' }, 400, headers);

        const length = Number(request.headers.get('content-length') || 0);
        if (length > 95 * 1024 * 1024) return json({ error: 'El archivo supera 95 MB' }, 413, headers);
        if (!request.body) return json({ error: 'Falta el archivo de audio' }, 400, headers);

        const { list } = await publicTracks(env);
        let finalName = name;
        let counter = 2;
        while (list.some((track) => track.file === finalName)) {
          finalName = name.replace(/(\.[a-z0-9]+)$/i, ` (${counter})$1`);
          counter += 1;
        }

        const ext = (finalName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
        const release = await ensureRelease(env);
        const asset = await uploadAsset(
          env,
          release.id,
          finalName,
          request.body,
          AUDIO_TYPE[ext] || 'application/octet-stream',
          length
        );

        const stem = finalName.replace(/\.[a-z0-9]+$/i, '');
        const entry = {
          file: finalName,
          title: String(params.get('title') || '').trim() || stem,
          artist: String(params.get('artist') || '').trim() || 'Artista desconocido',
          ext,
          url: `${url.origin}/audio/${encodeURIComponent(finalName)}`,
          assetId: asset.id,
          key: await makePassword(password),
          locked: true,
        };
        for (const field of ['album', 'genre', 'year', 'description']) {
          const value = String(params.get(field) || '').trim();
          if (value) entry[field] = value;
        }
        await saveTracks(env, [...list, entry], `Subir pista: ${finalName}`);
        return json({ ok: true, track: entry }, 200, headers);
      }

      const trackMatch = pathname.match(/^\/api\/admin\/tracks\/([^/]+)$/);
      if (trackMatch) {
        const wanted = decodeURIComponent(trackMatch[1]);
        const { list } = await publicTracks(env);
        let index = -1;
        for (let position = 0; position < list.length; position += 1) {
          if ((await trackId(list[position].file)) === wanted) {
            index = position;
            break;
          }
        }
        if (index < 0) return json({ error: 'Pista no encontrada' }, 404, headers);

        if (request.method === 'PUT' || request.method === 'PATCH') {
          const body = await request.json().catch(() => ({}));
          const entry = { ...list[index] };
          for (const field of ['title', 'artist', 'album', 'genre', 'year', 'description']) {
            if (field in body) {
              const value = String(body[field] || '').trim();
              if (value) entry[field] = value;
              else delete entry[field];
            }
          }
          if (body.clearPassword === true) {
            delete entry.key;
            delete entry.locked;
          } else if (typeof body.password === 'string' && body.password) {
            if (body.password.length < 4) return json({ error: 'La contraseña necesita al menos 4 caracteres' }, 400, headers);
            entry.key = await makePassword(body.password);
            entry.locked = true;
          }
          const next = [...list];
          next[index] = entry;
          await saveTracks(env, next, `Editar pista: ${entry.file}`);
          return json({ ok: true }, 200, headers);
        }

        if (request.method === 'DELETE') {
          const file = list[index].file;
          const assetId = list[index].assetId;
          if (assetId) {
            try {
              await gh(env, repoUrl(env, `/releases/assets/${assetId}`), { method: 'DELETE' });
            } catch (error) {
              if (error.status !== 404) throw error;
            }
          }
          try {
            const current = await gh(env, contentsUrl(env, `${MUSIC_DIR}/${file}`));
            await gh(env, repoUrl(env, `/contents/${MUSIC_DIR}/${encodeURIComponent(file)}`), {
              method: 'DELETE',
              body: JSON.stringify({ message: `Borrar audio: ${file}`, sha: current.sha, branch: env.BRANCH || 'main' }),
            });
          } catch (error) {
            if (error.status !== 404) throw error;
          }
          const next = list.filter((track) => track.file !== file);
          await saveTracks(env, next, `Borrar pista: ${file}`);
          return json({ ok: true }, 200, headers);
        }
      }

      /* --------------------------- usuarios --------------------------- */

      if (pathname === '/api/admin/users' && request.method === 'GET') {
        const { users } = await loadAccounts(env);
        return json(
          {
            users: Object.entries(users).map(([name, record]) => ({ user: name, owner: Boolean(record.owner), createdAt: record.createdAt || '' })),
            you: session.user,
            owner: Boolean(users[session.user] && users[session.user].owner),
          },
          200,
          headers
        );
      }

      if (pathname === '/api/admin/users' && request.method === 'POST') {
        if (!session.owner) return json({ error: 'Solo la cuenta principal crea usuarios' }, 403, headers);
        const body = await request.json().catch(() => ({}));
        const name = String(body.user || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!USER_NAME.test(name)) return json({ error: 'Usuario no válido: 3-32 caracteres, minúsculas, números, . _ -' }, 400, headers);
        if (password.length < 4) return json({ error: 'La contraseña necesita al menos 4 caracteres' }, 400, headers);
        const { data, users } = await loadAccounts(env);
        if (users[name]) return json({ error: 'Ese usuario ya existe' }, 409, headers);
        users[name] = { ...(await makePassword(password)), createdAt: new Date().toISOString() };
        await writeJSON(env, ACCOUNTS_PATH, { ...data, version: 1, users, updatedAt: new Date().toISOString() }, `Crear usuario: ${name}`);
        return json({ ok: true }, 200, headers);
      }

      const userPassword = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (userPassword && request.method === 'POST') {
        if (!session.owner) return json({ error: 'Solo la cuenta principal restablece contraseñas' }, 403, headers);
        const name = decodeURIComponent(userPassword[1]).toLowerCase();
        const body = await request.json().catch(() => ({}));
        const password = String(body.password || '');
        if (password.length < 4) return json({ error: 'La contraseña necesita al menos 4 caracteres' }, 400, headers);
        const { data, users } = await loadAccounts(env);
        if (!users[name]) return json({ error: 'Ese usuario no existe' }, 404, headers);
        users[name] = {
          ...(await makePassword(password)),
          ...(users[name].owner ? { owner: true } : {}),
          createdAt: users[name].createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJSON(env, ACCOUNTS_PATH, { ...data, version: 1, users, updatedAt: new Date().toISOString() }, `Contraseña de ${name}`);
        return json({ ok: true }, 200, headers);
      }

      const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && request.method === 'DELETE') {
        if (!session.owner) return json({ error: 'Solo la cuenta principal borra usuarios' }, 403, headers);
        const name = decodeURIComponent(userMatch[1]).toLowerCase();
        const { data, users } = await loadAccounts(env);
        if (!users[name]) return json({ error: 'Ese usuario no existe' }, 404, headers);
        if (users[name].owner) return json({ error: 'La cuenta principal no se puede borrar' }, 400, headers);
        delete users[name];
        await writeJSON(env, ACCOUNTS_PATH, { ...data, version: 1, users, updatedAt: new Date().toISOString() }, `Borrar usuario: ${name}`);
        return json({ ok: true }, 200, headers);
      }

      if (pathname === '/api/admin/password' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const current = String(body.current || '');
        const next = String(body.next || '');
        if (next.length < 4) return json({ error: 'La contraseña nueva necesita al menos 4 caracteres' }, 400, headers);
        const { data, users } = await loadAccounts(env);
        const record = users[session.user];
        if (!record || !(await verifyPassword(current, record))) {
          return json({ error: 'La contraseña actual no es correcta' }, 401, headers);
        }
        users[session.user] = {
          ...(await makePassword(next)),
          ...(record.owner ? { owner: true } : {}),
          createdAt: record.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeJSON(env, ACCOUNTS_PATH, { ...data, version: 1, users, updatedAt: new Date().toISOString() }, `Contraseña de ${session.user}`);
        return json({ ok: true }, 200, headers);
      }

      return json({ error: 'Ruta no encontrada' }, 404, headers);
    } catch (error) {
      return json({ error: error.message || 'Error interno' }, 500, headers);
    }
  },
};
