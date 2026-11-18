#!/usr/bin/env node
/**
 * Aplica los cambios que prepara el panel del sitio publicado.
 *
 * El panel (GitHub Pages) no puede escribir en el repositorio, así que deja un
 * archivo pequeño en `shared/_pending/` o `music/_pending/` y GitHub Actions
 * ejecuta este script, que:
 *
 *   shared/_pending/*.json  → crea/actualiza/borra usuarios en shared/accounts.json
 *   music/_pending/*.json   → crea/actualiza/borra pistas en music/tracks.json
 *                             (y borra el audio si el cambio lo pide)
 *
 * Después borra los archivos pendientes. Sin tokens en el navegador.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNTS = path.join(ROOT, 'shared', 'accounts.json');
const TRACKS = path.join(ROOT, 'music', 'tracks.json');
const MUSIC = path.join(ROOT, 'music');
const PENDING_DIRS = [path.join(ROOT, 'shared', '_pending'), path.join(ROOT, 'music', '_pending')];
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;

const readJSON = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const pendingFiles = [];
for (const dir of PENDING_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) pendingFiles.push(path.join(dir, name));
  }
}

if (!pendingFiles.length) {
  console.log('Sin cambios pendientes.');
  process.exit(0);
}

const accounts = readJSON(ACCOUNTS, { version: 1, users: {} });
accounts.users = accounts.users || {};
const tracksData = readJSON(TRACKS, { tracks: [] });
tracksData.tracks = Array.isArray(tracksData.tracks) ? tracksData.tracks : [];

let applied = 0;

for (const file of pendingFiles.sort()) {
  const change = readJSON(file, null);
  if (!change || typeof change !== 'object') {
    fs.rmSync(file, { force: true });
    continue;
  }

  // ------------------------------- usuarios -------------------------------
  if (change.kind === 'user' && change.user) {
    const name = String(change.user).toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
      console.warn(`  ${path.basename(file)}: usuario inválido (${name})`);
    } else if (change.remove) {
      const isOwner = accounts.users[name] && accounts.users[name].owner;
      if (accounts.users[name] && !isOwner) delete accounts.users[name];
      if (isOwner) console.warn(`  ${path.basename(file)}: no se borra la cuenta principal`);
    } else if (change.password && change.password.salt && change.password.hash) {
      const previous = accounts.users[name] || {};
      accounts.users[name] = {
        salt: change.password.salt,
        iterations: Number(change.password.iterations) || 210000,
        hash: change.password.hash,
        ...(previous.owner || change.owner ? { owner: true } : {}),
        createdAt: previous.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    // La primera cuenta del archivo debe ser la principal si no hay ninguna.
    if (!Object.values(accounts.users).some((item) => item && item.owner)) {
      const first = Object.keys(accounts.users)[0];
      if (first) accounts.users[first] = { ...accounts.users[first], owner: true };
    }
    applied += 1;
  }

  // -------------------------------- pistas --------------------------------
  if (change.kind === 'track' && change.file) {
    const fileName = path.basename(String(change.file));
    const index = tracksData.tracks.findIndex((item) => item && item.file === fileName);

    if (change.remove) {
      const target = path.join(MUSIC, fileName);
      if (AUDIO_EXT.test(fileName) && fs.existsSync(target)) fs.rmSync(target, { force: true });
      if (index >= 0) tracksData.tracks.splice(index, 1);
      applied += 1;
    } else {
      const entry = index >= 0 ? tracksData.tracks[index] : { file: fileName, ext: (fileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase() };
      for (const field of ['title', 'artist', 'album', 'genre', 'year', 'description']) {
        if (typeof change[field] === 'string') {
          if (change[field].trim()) entry[field] = change[field].trim();
          else delete entry[field];
        }
      }
      if (change.clearPassword) {
        delete entry.key;
        delete entry.locked;
      } else if (change.password && change.password.salt && change.password.hash) {
        entry.key = {
          salt: change.password.salt,
          iterations: Number(change.password.iterations) || 210000,
          hash: change.password.hash,
        };
        entry.locked = true;
      }
      if (!entry.title) entry.title = fileName.replace(/\.[a-z0-9]+$/i, '');
      if (index >= 0) tracksData.tracks[index] = entry;
      else tracksData.tracks.push(entry);
      applied += 1;
    }
    tracksData.tracks.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));
  }

  fs.rmSync(file, { force: true });
}

writeJSON(ACCOUNTS, { ...accounts, version: 1, updatedAt: new Date().toISOString() });
writeJSON(TRACKS, { version: 1, tracks: tracksData.tracks });

for (const dir of PENDING_DIRS) {
  if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

console.log(`Cambios aplicados: ${applied}`);
