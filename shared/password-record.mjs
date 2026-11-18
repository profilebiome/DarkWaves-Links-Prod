/**
 * Registro de contraseñas compartido entre el servidor y las herramientas.
 *
 * Cada registro guarda dos hashes de la misma contraseña:
 *
 * - `salt` + `hash` (128 hex): scrypt, el que valida `server.mjs`.
 * - `pbkdf2` (o `salt`/`iterations`/`hash` de 64 hex): PBKDF2-SHA256, porque
 *   WebCrypto no implementa scrypt. Es el que se publica en el repositorio para
 *   que el navegador (y el host sin disco) puedan verificar la misma clave.
 *
 * Ninguno de los dos se puede revertir; el texto de la contraseña no se guarda.
 */
import crypto from 'node:crypto';

export const PBKDF2_ITERATIONS = 210000;
const PBKDF2_BYTES = 32;

export function makeRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');

  const keySalt = crypto.randomBytes(16).toString('hex');
  const keyHash = crypto
    .pbkdf2Sync(password, keySalt, PBKDF2_ITERATIONS, PBKDF2_BYTES, 'sha256')
    .toString('hex');

  return {
    salt,
    hash,
    pbkdf2: { salt: keySalt, iterations: PBKDF2_ITERATIONS, hash: keyHash },
  };
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifyRecord(password, record) {
  if (!record || !password) return false;

  // Un mismo registro puede traer el scrypt (salt+hash) y el PBKDF2 (`pbkdf2`).
  const keys = [];
  if (record.pbkdf2 && record.pbkdf2.salt) keys.push(record.pbkdf2);
  if (record.salt && record.hash) keys.push(record);

  for (const key of keys) {
    if (!key.salt || !key.hash) continue;
    const digest = String(key.hash);

    // scrypt: 64 bytes = 128 hex.
    if (digest.length === 128 && key === record) {
      const attempt = crypto.scryptSync(password, key.salt, 64).toString('hex');
      if (sameText(attempt, digest)) return true;
      continue;
    }

    // PBKDF2: 32 bytes = 64 hex.
    if (digest.length === 64) {
      const iterations = Number(key.iterations) || PBKDF2_ITERATIONS;
      const attempt = crypto.pbkdf2Sync(password, key.salt, iterations, PBKDF2_BYTES, 'sha256').toString('hex');
      if (sameText(attempt, digest)) return true;
    }
  }

  return false;
}

/** Solo el bloque verificable en el navegador (nunca el scrypt). */
export function publicRecord(record) {
  if (!record) return null;
  if (record.pbkdf2 && record.pbkdf2.salt && record.pbkdf2.hash) {
    const { salt, iterations, hash } = record.pbkdf2;
    return { salt, iterations: Number(iterations) || PBKDF2_ITERATIONS, hash };
  }
  if (record.salt && record.hash && String(record.hash).length === 64) {
    return { salt: record.salt, iterations: Number(record.iterations) || PBKDF2_ITERATIONS, hash: record.hash };
  }
  return null;
}
