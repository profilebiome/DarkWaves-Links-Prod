#!/usr/bin/env node
/**
 * Genera music/tracks.json a partir de los archivos de audio de music/.
 * Se usa en GitHub Pages (sin servidor) y en local mediante `npm run manifest`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUSIC_DIR = path.join(ROOT, 'music');
const OUTPUT = path.join(MUSIC_DIR, 'tracks.json');
// Metadatos guardados por el panel de administración (títulos, artista, álbum…).
const META_FILE = path.join(ROOT, 'data', 'tracks.json');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);

const cleanName = (value) => value.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

let meta = {};
try {
  meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')).tracks || {};
} catch {
  meta = {};
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
    const track = {
      file: entry.name,
      title: record.title || title || base,
      artist: record.artist || artist,
      ext: ext.slice(1),
    };
    if (record.album) track.album = record.album;
    if (record.genre) track.genre = record.genre;
    if (record.year) track.year = record.year;
    if (record.description) track.description = record.description;
    return track;
  })
  .sort((a, b) => a.title.localeCompare(b.title, 'es'));

fs.writeFileSync(OUTPUT, `${JSON.stringify({ tracks }, null, 2)}\n`, 'utf8');
console.log(`music/tracks.json: ${tracks.length} pista(s) — ${tracks.map((t) => t.file).join(', ') || 'vacío'}`);
