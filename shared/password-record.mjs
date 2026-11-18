/**
 * Registro de contraseñas compartido entre el servidor y las herramientas.
 *
 * Cada registro guarda dos hashes de la misma contraseña:
 *
 * - `salt` + `hash`: scrypt (memoria dura). Es el que valida `server.mjs`.
 * - `pbkdf2`: PBKDF2-SHA256, porque WebCrypto no implementa scrypt. Es el que
 *   permite verificar la misma clave en el navegador cuando el sitio se sirve
 *   sin backend (GitHub Pages).
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

export function verifyRecord(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const hash = crypto.scryptSync(password, record.salt, 64);
  const stored = Buffer.from(record.hash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

/** Solo el bloque verificable en el navegador (nunca el scrypt). */
export function publicRecord(record) {
  if (!record || !record.pbkdf2) return null;
  const { salt, iterations, hash } = record.pbkdf2;
  if (!salt || !hash || !Number(iterations)) return null;
  return { salt, iterations, hash };
}
