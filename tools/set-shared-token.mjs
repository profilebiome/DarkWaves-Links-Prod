#!/usr/bin/env node
/**
 * Escribe el token compartido del sitio en `shared/repo-token.js`.
 *
 *   node tools/set-shared-token.mjs github_pat_xxx
 *   node tools/set-shared-token.mjs github_pat_xxx --push
 *   node tools/set-shared-token.mjs --clear
 *
 * Requisitos del token: fine-grained, solo este repositorio y permiso
 * `Contents: Read and write`. Un token clásico con permisos de cuenta NO debe
 * usarse aquí: este archivo se publica en GitHub Pages y cualquiera puede leerlo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'shared', 'repo-token.js');
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const token = args.find((arg) => !arg.startsWith('--')) || '';

const encode = (value) => Buffer.from(String(value), 'utf8').toString('base64').split('').reverse().join('');

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (flags.includes('--clear')) {
  const current = fs.readFileSync(FILE, 'utf8');
  const cleared = current.replace(/export const SHARED_TOKEN = "[^"]*";/, 'export const SHARED_TOKEN = "";');
  fs.writeFileSync(FILE, cleared, 'utf8');
  console.log('  Token compartido borrado.');
  if (flags.includes('--push')) {
    execFileSync('git', ['add', 'shared/repo-token.js'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', 'Quitar token compartido del sitio'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
  }
  process.exit(0);
}

if (!token) fail('Uso: node tools/set-shared-token.mjs <token> [--push]');

if (/^ghp_/.test(token) || /^github_pat_/.test(token) === false) {
  console.warn('  AVISO: los tokens clásicos (ghp_…) suelen tener permisos de toda la cuenta.');
  console.warn('  Usa un token fine-grained (github_pat_…) limitado a este repositorio');
  console.warn('  con el permiso Contents: Read and write.');
}

const body = `/**
 * Token del repositorio compartido por todo el sitio (opcional).
 *
 * Si \`SHARED_TOKEN\` tiene valor, cualquier cuenta del panel que entre desde
 * cualquier navegador puede administrar sin pegar nada: el panel usa este token
 * automáticamente.
 *
 * OJO: este archivo se publica en GitHub Pages. Cualquiera que abra el sitio
 * puede leer el token, así que SOLO debe ser un token fine-grained limitado a
 * este repositorio con el permiso \`Contents: Read and write\`. Nunca un token
 * clásico con permisos de cuenta (repo + admin / workflow / delete_repo…):
 * con uno de esos, quien lo lea puede borrar tus repositorios.
 *
 * Generado por tools/set-shared-token.mjs (base64 invertido, no es cifrado).
 */

export const SHARED_OWNER = "profilebiome";
export const SHARED_REPO = "DarkWaves-Links-Prod";
export const SHARED_BRANCH = "main";

export const SHARED_TOKEN = ${JSON.stringify(encode(token))};
`;

fs.writeFileSync(FILE, body, 'utf8');
console.log(`  Token guardado en shared/repo-token.js (${token.length} caracteres).`);
console.log('  Recuerda: cualquiera que abra el sitio podrá leerlo.');

if (flags.includes('--push')) {
  execFileSync('git', ['add', 'shared/repo-token.js'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', 'Configurar token compartido del panel'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
  console.log('  Publicado. GitHub Pages lo servirá en ~1 minuto.');
} else {
  console.log('  Añade --push para publicarlo.');
}
