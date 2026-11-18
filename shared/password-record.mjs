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
  if (!record) return false;
  // Registros scrypt del servidor.
  if (record.salt && record.hash && record.hash.length >= 64 && !record.pbkdf2) {
    const hash = crypto.scryptSync(password, record.salt, 64);
    const stored = Buffer.from(record.hash, 'hex');
    return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
  }
  // Registros PBKDF2 (los que se publican en el repo).
  const key = record.pbkdf2 && record.pbkdf2.salt ? record.pbkdf2 : record.k && record.k.salt ? record.k : record;
  if (key && key.salt && key.hash && Number(key.iterations)) {
    const attempt = crypto
      .pbkdf2Sync(password, key.salt, Number(key.iterations), 32, 'sha256')
      .toString('hex');
    if (attempt.length !== key.hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(key.hash));
  }
  // Registro scrypt antiguo sin pbkdf2.
  if (record.salt && record.hash) {
    const hash = crypto.scryptSync(password, record.salt, 64);
    const stored = Buffer.from(record.hash, 'hex');
    return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
  }
  return false;
}

/** Solo el bloque verificable en el navegador (nunca el scrypt). */
export function publicRecord(record) {
  if (!record || !record.pbkdf2) return null;
  const { salt, iterations, hash } = record.pbkdf2;
  if (!salt || !hash || !Number(iterations)) return null;
  return { salt, iterations, hash };
}
