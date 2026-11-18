#!/usr/bin/env node
/**
 * Comprueba si una URL está sirviendo el reproductor con backend (Node) o
 * solo el sitio estático de GitHub Pages.
 *
 *   node tools/check-deploy.mjs https://josspreview.profilebio.me
 *   node tools/check-deploy.mjs http://localhost:4321
 */
const base = (process.argv[2] || 'http://localhost:4321').replace(/\/+$/, '');

const rows = [];
const ask = async (label, path, init) => {
  try {
    const response = await fetch(`${base}${path}`, { cache: 'no-store', ...init });
    const text = await response.text();
    let detail = `${response.status}`;
    try {
      const json = JSON.parse(text);
      if (json.error) detail += ` ${json.error}`;
      if (Array.isArray(json.tracks)) detail += ` · ${json.tracks.length} pista(s)`;
      if (json.authenticated === false) detail += ' · sin sesión';
    } catch {
      /* no es JSON */
    }
    rows.push({ label, ok: response.ok, detail });
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    rows.push({ label, ok: false, detail: error.message });
    return { ok: false, status: 0, text: '' };
  }
};

console.log(`\n  Comprobando ${base}\n`);

const page = await ask('Reproductor', '/');
const health = await ask('Healthcheck', '/healthz');
const tracks = await ask('API de pistas', '/api/tracks');
const admin = await ask('Panel /admin', '/admin');
await ask('Login (control)', '/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'x', password: 'x' }),
});
// Un 401 es la respuesta correcta: el endpoint existe y rechaza la clave falsa.
const loginControl = rows[rows.length - 1];
if (loginControl.detail.startsWith('401') || loginControl.detail.startsWith('429')) {
  loginControl.ok = true;
  loginControl.detail = `${loginControl.detail.split(' ')[0]} (rechaza clave falsa)`;
}

for (const row of rows) {
  console.log(`  ${row.ok ? '✓' : '✗'} ${row.label.padEnd(24)} ${row.detail}`);
}

const backend = health.ok && tracks.ok;
console.log('');
if (backend) {
  const lista = tracks.text.includes('"locked"') ? ' con pistas bloqueadas/desbloqueadas por clave' : '';
  console.log(`  Resultado: BACKEND ACTIVO${lista}.`);
  console.log('  Login, usuarios y contraseñas por pista funcionan.\n');
  if (tracks.text.includes('"hasPassword":false')) {
    console.log('  Aviso: hay pistas sin contraseña (hasPassword:false) y quedan');
    console.log('  bloqueadas hasta asignarles una en /admin → Biblioteca.\n');
  }
} else if (page.ok) {
  console.log('  Resultado: SOLO ESTÁTICO (GitHub Pages).');
  console.log('  /api/* responde 404: no hay login, ni usuarios, ni claves de pista.');
  console.log('  Despliega en un host con Node (ver DESPLIEGUE.md).\n');
} else {
  console.log('  Resultado: el sitio no responde.\n');
  process.exitCode = 1;
}

const adminOk = admin.ok && backend;
if (!adminOk) process.exitCode = 1;
