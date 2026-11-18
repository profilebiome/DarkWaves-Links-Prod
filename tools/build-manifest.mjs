#!/usr/bin/env node
/**
 * Genera music/tracks.json a partir de los archivos de audio de music/.
 * Se usa en GitHub Pages (sin servidor) y en local mediante `npm run manifest`.
 *
 * Si una pista tiene contraseña en `data/tracks.json`, se publica solo su hash
 * PBKDF2 (`key`) para que el navegador pueda pedirla y comprobarla sin backend.
 * El hash scrypt y cualquier otro dato privado se quedan fuera.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUSIC_DIR = path.resolve(process.env.DARKWAVES_MUSIC_DIR || path.join(ROOT, 'music'));
const OUTPUT = path.join(MUSIC_DIR, 'tracks.json');
// Metadatos guardados por el panel de administración (títulos, artista, álbum…).
const META_FILE = path.join(path.resolve(process.env.DARKWAVES_DATA_DIR || path.join(ROOT, 'data')), 'tracks.json');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);

const cleanName = (value) => value.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

export function buildManifest() {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')).tracks || {};
  } catch {
    meta = {};
  }

  // Si no hay data/ (por ejemplo en GitHub Actions), se conserva lo que ya
  // estaba publicado: títulos editados y claves de pista no se pierden.
  const previous = {};
  try {
    const current = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    for (const item of current.tracks || []) {
      if (item && item.file) previous[item.file] = item;
    }
  } catch {
    /* primera vez */
  }

  const entries = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR, { withFileTypes: true }).filter((entry) => entry.isFile())
    : [];

  const tracks = entries
    .filter((entry) => AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
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
      const record = meta[entry.name] || {};
      const kept = previous[entry.name] || {};
      const track = {
        file: entry.name,
        title: record.title || kept.title || title || base,
        artist: record.artist || kept.artist || artist,
        ext: ext.slice(1),
      };
      const album = record.album || kept.album;
      const genre = record.genre || kept.genre;
      const year = record.year || kept.year;
      const description = record.description || kept.description;
      if (album) track.album = album;
      if (genre) track.genre = genre;
      if (year) track.year = year;
      if (description) track.description = description;

      const key = (record.password && record.password.pbkdf2) || kept.key;
      if (key && key.salt && key.hash && Number(key.iterations)) {
        track.key = { salt: key.salt, iterations: Number(key.iterations), hash: key.hash };
        track.locked = true;
      }
      return track;
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));

  fs.writeFileSync(OUTPUT, `${JSON.stringify({ tracks }, null, 2)}\n`, 'utf8');
  const locked = tracks.filter((track) => track.locked).length;
  console.log(
    `music/tracks.json: ${tracks.length} pista(s) — ${tracks.map((t) => t.file).join(', ') || 'vacío'}` +
      (locked ? ` · ${locked} con contraseña` : '')
  );
  return tracks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildManifest();
}
