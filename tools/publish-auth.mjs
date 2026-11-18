/**
 * Publica en `shared/accounts.json` la parte de las cuentas que el navegador
 * puede verificar sin servidor (GitHub Pages): nombre, rol y hash PBKDF2.
 *
 * No incluye el hash scrypt ni ningún dato privado más allá del PBKDF2, pero
 * tenlo presente: con este archivo en el repositorio, la contraseña del panel
 * se puede atacar por fuerza bruta offline. Por eso las claves deben ser largas
 * y solo se publican las cuentas del panel, nunca contraseñas de pistas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { publicRecord } from '../shared/password-record.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERS_FILE = path.join(path.resolve(process.env.DARKWAVES_DATA_DIR || path.join(ROOT, 'data')), 'users.json');
const OUTPUT = path.join(ROOT, 'shared', 'accounts.json');

export function publishAccounts() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    data = null;
  }

  const users = (data && data.users) || {};
  const out = { version: 1, updatedAt: new Date().toISOString(), users: {} };
  const skipped = [];

  for (const [name, record] of Object.entries(users)) {
    const key = publicRecord(record);
    if (!key) {
      skipped.push(name);
      continue;
    }
    out.users[name] = { ...key, owner: Boolean(record.owner) };
  }

  // Nunca publicar un archivo vacío: dejaría el login del sitio sin cuentas.
  const count = Object.keys(out.users).length;
  if (!count) {
    const existing = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : null;
    const kept = existing && existing.users ? Object.keys(existing.users).length : 0;
    console.warn(
      `  AVISO: no hay cuentas que publicar (cuentas leídas: ${Object.keys(users).length}).` +
        (kept ? ` Se conserva shared/accounts.json con ${kept} cuenta(s).` : '')
    );
    return existing || out;
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  const total = Object.keys(out.users).length;
  console.log(`shared/accounts.json: ${total} cuenta(s)${skipped.length ? ` — sin PBKDF2: ${skipped.join(', ')}` : ''}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishAccounts();
}
