#!/usr/bin/env node
/**
 * Deja las cuentas del panel y las contraseñas de pista en un estado conocido.
 *
 *   node tools/reset-accounts.mjs --users "admin:ClaveLarga1,jossgiant:ClaveLarga2"
 *   node tools/reset-accounts.mjs --users "admin:ClaveLarga1" --track-password "ClaveDePistas"
 *   node tools/reset-accounts.mjs --track-password "ClaveDePistas"     # solo pistas
 *
 * El primer usuario de la lista es la cuenta principal (owner): crea y borra al
 * resto. Después de escribir data/, regenera shared/accounts.json (para el
 * login sin backend) y music/tracks.json (para las contraseñas de pista).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRecord } from '../shared/password-record.mjs';
import { buildManifest } from './build-manifest.mjs';
import { publishAccounts } from './publish-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const MUSIC_DIR = path.join(ROOT, 'music');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const META_FILE = path.join(DATA_DIR, 'tracks.json');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm']);
const USER_NAME = /^[a-z0-9._-]{3,32}$/;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const usersArg = arg('users').trim();
const trackPassword = arg('track-password').trim();

if (!usersArg && !trackPassword) {
  fail('Nada que hacer. Usa --users "admin:Clave,jossgiant:Clave" y/o --track-password "Clave".');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------- cuentas ---------------------------- */

if (usersArg) {
  const pairs = usersArg
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const index = chunk.indexOf(':');
      if (index < 0) fail(`Formato inválido en "${chunk}". Usa usuario:contraseña.`);
      return { name: chunk.slice(0, index).trim().toLowerCase(), password: chunk.slice(index + 1) };
    });

  if (pairs.length < 2) {
    console.warn('  Aviso: solo hay una cuenta. El panel quedará con 1 usuario.');
  }

  const now = new Date().toISOString();
  const users = {};
  pairs.forEach((pair, index) => {
    if (!USER_NAME.test(pair.name)) fail(`Usuario inválido "${pair.name}": 3-32 caracteres, minúsculas, números, . _ -`);
    if (pair.password.length < 8) fail(`La contraseña de "${pair.name}" necesita al menos 8 caracteres.`);
    if (users[pair.name]) fail(`Usuario repetido: "${pair.name}".`);
    users[pair.name] = {
      ...makeRecord(pair.password),
      ...(index === 0 ? { owner: true } : {}),
      createdAt: now,
    };
  });

  fs.writeFileSync(USERS_FILE, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { mode: 0o600 });
  console.log(`data/users.json: ${pairs.map((pair) => pair.name).join(', ')} (principal: ${pairs[0].name})`);
}

/* ----------------------- contraseñas de pista ----------------------- */

if (trackPassword) {
  if (trackPassword.length < 4) fail('La contraseña de pista necesita al menos 4 caracteres.');

  let meta = { version: 1, tracks: {} };
  try {
    meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    if (!meta.tracks) meta.tracks = {};
  } catch {
    meta = { version: 1, tracks: {} };
  }

  const files = fs.existsSync(MUSIC_DIR)
    ? fs
        .readdirSync(MUSIC_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
    : [];

  if (!files.length) fail(`No hay audio en ${MUSIC_DIR}.`);

  const now = new Date().toISOString();
  for (const file of files) {
    const record = meta.tracks[file] || { addedAt: now };
    if (!record.title) record.title = path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
    if (!record.artist) record.artist = 'Artista desconocido';
    record.password = makeRecord(trackPassword);
    record.updatedAt = now;
    meta.tracks[file] = record;
  }

  fs.writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  console.log(`data/tracks.json: contraseña asignada a ${files.length} pista(s)`);
}

/* ------------------------- publicar ------------------------- */

buildManifest();
publishAccounts();
