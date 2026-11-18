#!/usr/bin/env node
/**
 * Despliega el panel completo (server.mjs) en Render y deja el servicio listo:
 * plan, variables de entorno, disco persistente y URL pública.
 *
 *   RENDER_API_KEY=rnd_xxx node tools/deploy-render.mjs \
 *     --user admin --password "TuClaveLarga" [--plan starter|free] [--push-origin https://tu-dominio]
 *
 * La llave se crea en https://dashboard.render.com/u/settings#api-keys (Create API Key).
 * No se guarda en ningún archivo ni se envía al sitio: solo la usa este script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.render.com/v1';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : '';
};

const KEY = process.env.RENDER_API_KEY || '';
const NAME = flag('name') || 'darkwaves-links';
const PLAN = flag('plan') || 'starter';
const USER = flag('user') || '';
const PASSWORD = flag('password') || '';
const REGION = flag('region') || 'oregon';
const REPO = flag('repo') || 'https://github.com/profilebiome/DarkWaves-Links-Prod';
const BRANCH = flag('branch') || 'main';
const ORIGIN = flag('origin') || '';

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!KEY) fail('Falta RENDER_API_KEY (Settings → API Keys en Render).');
if (!USER || !PASSWORD) fail('Faltan --user y --password para la cuenta principal del panel.');
if (PASSWORD.length < 8 && !args.includes('--allow-weak')) {
  fail('La contraseña del panel necesita al menos 8 caracteres (o usa --allow-weak a sabiendas).');
}

const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };

async function api(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data && data.message ? data.message : text.slice(0, 300);
    throw new Error(`${response.status} ${detail}`);
  }
  return data;
}

async function main() {
  console.log('\n  1/4 · Leyendo la cuenta de Render…');
  const owners = await api('/owners?limit=1');
  const owner = Array.isArray(owners) && owners[0] ? owners[0].owner || owners[0] : null;
  const ownerId = owner && owner.id ? owner.id : null;
  if (!ownerId) fail('No se pudo leer el owner de la cuenta.');
  console.log(`        owner: ${ownerId}`);

  console.log('  2/4 · Creando el servicio web…');
  const envVars = [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'DARKWAVES_DATA_DIR', value: '/var/data/data' },
    { key: 'DARKWAVES_MUSIC_DIR', value: '/var/data/music' },
    { key: 'DARKWAVES_ADMIN_USER', value: USER },
    { key: 'DARKWAVES_ADMIN_PASSWORD', value: PASSWORD },
    ...(ORIGIN ? [{ key: 'DARKWAVES_PUBLIC_URL', value: ORIGIN }] : []),
  ];

  const payload = {
    type: 'web_service',
    name: NAME,
    ownerId,
    repo: REPO,
    branch: BRANCH,
    autoDeploy: 'yes',
    envVars,
    serviceDetails: {
      env: 'node',
      plan: PLAN,
      region: REGION,
      healthCheckPath: '/healthz',
      envSpecificDetails: {
        buildCommand: 'npm install --no-audit --no-fund',
        startCommand: 'node server.mjs',
      },
    },
  };

  let created;
  try {
    created = await api('/services', { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    if (/already exists|name/i.test(error.message)) {
      fail(`Ya existe un servicio llamado "${NAME}". Usa --name otro-nombre o bórralo en Render.`);
    }
    throw error;
  }

  const service = created && created.service ? created.service : created;
  const serviceId = service && service.id ? service.id : null;
  if (!serviceId) fail('Render creó el servicio pero no devolvió su id.');
  const url = service.serviceDetails && service.serviceDetails.url ? service.serviceDetails.url : '';
  console.log(`        id: ${serviceId}`);
  if (url) console.log(`        url: ${url}`);

  if (PLAN !== 'free') {
    console.log('  3/4 · Añadiendo disco persistente (5 GB en /var/data)…');
    try {
      await api('/disks', {
        method: 'POST',
        body: JSON.stringify({ name: `${NAME}-data`, ownerId, serviceId, mountPath: '/var/data', sizeGB: 5 }),
      });
      console.log('        disco listo');
    } catch (error) {
      console.warn(`        aviso: no se pudo crear el disco (${error.message})`);
      console.warn('        sin disco, las subidas y las cuentas se pierden al reiniciar.');
    }
  } else {
    console.log('  3/4 · Plan free: sin disco (los datos se pierden al reiniciar).');
  }

  console.log('  4/4 · Lanzando el despliegue…');
  try {
    await api(`/services/${serviceId}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
  } catch (error) {
    console.warn(`        aviso: el autoDeploy debería encargarse (${error.message})`);
  }

  const out = {
    serviceId,
    url: url || `https://${NAME}.onrender.com`,
    panel: `${url || `https://${NAME}.onrender.com`}/admin`,
  };
  fs.writeFileSync(path.join(ROOT, '.render-deploy.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  console.log('\n  Listo. Cuando Render diga "Live":');
  console.log(`    panel: ${out.panel}`);
  console.log(`    usuario: ${USER}`);
  console.log('    (la contraseña es la que pasaste con --password)');
  console.log('\n  Comprueba con: node tools/check-deploy.mjs ' + out.url);
  console.log('  Para el dominio: Render → Settings → Custom Domains y libera el dominio en GitHub Pages.\n');
}

main().catch((error) => fail(error.message));
