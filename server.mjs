#!/usr/bin/env node
/**
 * DarkWaves — servidor local de música.
 * Lee los archivos de ./music y los reproduce vía streaming (sin descarga directa).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = path.join(ROOT, 'music');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.DARKWAVES_PORT || 4321);
const HOST = process.env.DARKWAVES_HOST || '127.0.0.1';

const SECRET = crypto.randomBytes(32);
const TOKEN_TTL = 1000 * 60 * 60 * 6;

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

const PAGES = new Map([['/', 'index.html']]);

function sign(id) {
  const exp = Date.now() + TOKEN_TTL;
  const mac = crypto
    .createHmac('sha256', SECRET)
    .update(`${id}.${exp}`)
    .digest('base64url');
  return `${exp}.${mac}`;
}

function verify(id, token) {
  if (typeof token !== 'string') return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp || !mac) return false;
  const good = crypto
    .createHmac('sha256', SECRET)
    .update(`${id}.${exp}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const cleanName = (value) => value.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

let cache = { at: 0, tracks: [] };

function listTracks() {
  const now = Date.now();
  if (now - cache.at < 1200) return cache.tracks;
  let entries = [];
  try {
    entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const tracks = entries
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
      const id = crypto.createHash('sha1').update(entry.name).digest('hex').slice(0, 16);
      return {
        id,
        title: title || base,
        artist,
        ext: ext.slice(1),
        url: `/stream/${id}?t=${encodeURIComponent(sign(id))}`,
        file: path.join(MUSIC_DIR, entry.name),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));

  cache = { at: now, tracks };
  return tracks;
}

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

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Método no permitido');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Solicitud inválida');
  }

  if (pathname === '/api/tracks') {
    const tracks = listTracks().map(({ file, ...track }) => track);
    return sendJSON(res, 200, {
      tracks,
      folder: 'music',
      scannedAt: Date.now(),
    });
  }

  if (pathname.startsWith('/stream/')) {
    const id = pathname.slice('/stream/'.length);
    const token = new URL(req.url, 'http://localhost').searchParams.get('t');
    const track = listTracks().find((item) => item.id === id);
    if (!track) return sendText(res, 404, 'Pista no encontrada');
    if (!verify(id, token)) return sendText(res, 403, 'Enlace no válido o expirado');
    return streamTrack(req, res, track);
  }

  if (pathname === '/music' || pathname.startsWith('/music/')) {
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
  console.log(`\n  DarkWaves listo en http://localhost:${PORT}\n  Carpeta de música: ${MUSIC_DIR}\n`);
});
