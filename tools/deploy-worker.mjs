#!/usr/bin/env node
/**
 * Despliega el Worker del panel en Cloudflare y conecta el sitio.
 *
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... GITHUB_TOKEN=... node tools/deploy-worker.mjs
 *   ... --name darkwaves-panel --origin https://josspreview.profilebio.me --push
 *
 * CF_API_TOKEN necesita el permiso "Workers Scripts: Edit".
 * GITHUB_TOKEN es el token fine-grained (Contents: Read and write) que quedará
 * como secreto DENTRO del Worker: nunca se escribe en el repositorio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_FILE = path.join(ROOT, 'worker', 'darkwaves-panel.js');
const ENDPOINT_FILE = path.join(ROOT, 'shared', 'api-endpoint.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const CF_TOKEN = process.env.CF_API_TOKEN || '';
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const NAME = value('name', 'darkwaves-panel');
const ORIGIN = value('origin', 'https://josspreview.profilebio.me');
const REPO = value('repo', 'profilebiome/DarkWaves-Links-Prod');
const BRANCH = value('branch', 'main');

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!CF_TOKEN || !CF_ACCOUNT) fail('Faltan CF_API_TOKEN y/o CF_ACCOUNT_ID.');
if (!GITHUB_TOKEN) fail('Falta GITHUB_TOKEN (el token fine-grained que usará el Worker).');

const API = 'https://api.cloudflare.com/client/v4';
const headers = { Authorization: `Bearer ${CF_TOKEN}` };

async function cf(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok || (data && data.success === false)) {
    const detail = data && data.errors ? JSON.stringify(data.errors) : text.slice(0, 200);
    throw new Error(`${response.status} ${detail}`);
  }
  return data;
}

async function main() {
  console.log(`\n  Desplegando Worker "${NAME}" en la cuenta ${CF_ACCOUNT}…`);

  // 1. Subir el script (módulo ES).
  const code = fs.readFileSync(WORKER_FILE, 'utf8');
  const form = new FormData();
  form.append('metadata', JSON.stringify({ main_module: 'darkwaves-panel.js', compatibility_date: '2024-11-01' }));
  form.append('darkwaves-panel.js', new Blob([code], { type: 'application/javascript+module' }), 'darkwaves-panel.js');
  await cf(`/accounts/${CF_ACCOUNT}/workers/scripts/${NAME}`, { method: 'PUT', body: form });
  console.log('  ✓ Código subido');

  // 2. Variables y secretos.
  const secrets = [
    { name: 'GITHUB_TOKEN', text: GITHUB_TOKEN, type: 'secret_text' },
    { name: 'REPO', text: REPO, type: 'plain_text' },
    { name: 'BRANCH', text: BRANCH, type: 'plain_text' },
    { name: 'ALLOWED_ORIGIN', text: ORIGIN, type: 'plain_text' },
  ];
  for (const secret of secrets) {
    await cf(`/accounts/${CF_ACCOUNT}/workers/scripts/${NAME}/secrets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secret),
    });
    console.log(`  ✓ ${secret.name}`);
  }

  // 3. Activar workers.dev y obtener la URL.
  await cf(`/accounts/${CF_ACCOUNT}/workers/scripts/${NAME}/subdomain`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const sub = await cf(`/accounts/${CF_ACCOUNT}/workers/subdomain`);
  const subdomain = sub && sub.result ? sub.result.subdomain : '';
  if (!subdomain) fail('No se pudo obtener el subdominio workers.dev de la cuenta.');
  const url = `https://${NAME}.${subdomain}.workers.dev`;
  console.log(`  ✓ URL: ${url}`);

  // 4. Comprobar que responde.
  const health = await fetch(`${url}/healthz`);
  if (!health.ok) fail(`El Worker no responde en /healthz (${health.status}). Revisa los secretos.`);
  console.log('  ✓ /healthz responde');

  // 5. Conectar el sitio.
  fs.writeFileSync(
    ENDPOINT_FILE,
    `/**\n * Proxy del panel (Cloudflare Worker).\n * Generado por tools/deploy-worker.mjs — el token vive en el Worker, no aquí.\n */\nexport const PANEL_ENDPOINT = ${JSON.stringify(url)};\n`,
    'utf8'
  );
  console.log('  ✓ shared/api-endpoint.js actualizado');

  if (flag('push')) {
    execFileSync('git', ['add', 'shared/api-endpoint.js'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', 'Conectar el panel con el Worker del servidor'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
    console.log('  ✓ Publicado (GitHub Pages tarda ~1 minuto)');
  } else {
    console.log('  Añade --push para publicar el cambio en el sitio.');
  }
}

main().catch((error) => fail(error.message));
