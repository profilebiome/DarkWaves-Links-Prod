# Panel sin tokens (Cloudflare Worker)

Objetivo: **nadie** pega tokens. Cada administrador entra al panel con su usuario
y contraseña, y el Worker (servidor de Cloudflare, gratis) hace los commits con
un token que nunca sale del servidor.

```
navegador  ──usuario+contraseña──▶  Worker de Cloudflare  ──token──▶  GitHub
(panel)                              (guarda el secreto)              (repo)
```

El token no está en el repositorio ni en el navegador, así que GitHub no lo
puede revocar y nadie puede leerlo abriendo el sitio.

---

## 1. Cuenta de Cloudflare (gratis)

<https://dash.cloudflare.com/sign-up> — correo y contraseña, sin tarjeta.

## 2. Crear el Worker

1. Menú lateral → **Compute (Workers)** → **Create** → **Worker**.
2. Nombre: `darkwaves-panel` → **Deploy**.
3. **Edit code** → borra todo → pega el contenido completo de
   [`worker/darkwaves-panel.js`](worker/darkwaves-panel.js) → **Deploy**.

## 3. Configurar los secretos

En el Worker → **Settings** → **Variables and Secrets** → *Add*:

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `GITHUB_TOKEN` | **Secret** | token fine-grained con `Contents: Read and write` **solo** en `DarkWaves-Links-Prod` |
| `REPO` | Text | `profilebiome/DarkWaves-Links-Prod` |
| `BRANCH` | Text | `main` |
| `ALLOWED_ORIGIN` | Text | `https://josspreview.profilebio.me` |

Guarda y **Deploy** otra vez. El token de GitHub que uses aquí no se publica en
ninguna parte: solo lo lee el Worker.

## 4. Conectar el sitio con el Worker

Copia la URL del Worker (`https://darkwaves-panel.TU-SUBDOMINIO.workers.dev`) y
escríbela en `shared/api-endpoint.js`:

```js
export const PANEL_ENDPOINT = "https://darkwaves-panel.TU-SUBDOMINIO.workers.dev";
```

Commit y push. En ~1 minuto GitHub Pages sirve el panel conectado.

## 5. Comprobar

`https://josspreview.profilebio.me/admin` → entra con tu cuenta → debe decir
**“Conectado con tu cuenta · sin token”**, sin ninguna casilla de token. Prueba
crear un usuario y subir una pista.

---

## Si prefieres que lo despliegue yo

Con un **API token de Cloudflare** (`Workers Scripts: Edit`) y el **Account ID**
puedo desplegar el Worker, ponerle los secretos y conectar el sitio desde aquí:

```bash
CF_API_TOKEN=... CF_ACCOUNT_ID=... GITHUB_TOKEN=... node tools/deploy-worker.mjs
```

El script crea el Worker, sube los secretos, escribe la URL en
`shared/api-endpoint.js` y hace commit + push.

## Límites y seguridad

- Plan gratuito de Workers: 100 000 peticiones/día — de sobra para el panel.
- El Worker solo acepta rutas de `contents/` y `git/` del repositorio configurado.
- CORS limitado a `ALLOWED_ORIGIN` (tu dominio).
- La contraseña se verifica contra `shared/accounts.json` (PBKDF2) en cada
  petición; si cambias la clave en el panel, el Worker la acepta al instante.
- Para revocar el acceso de alguien: bórralo en *Usuarios del panel*.
- Si algún día se filtra el token de GitHub: revócalo en GitHub y pon otro en los
  secretos del Worker (30 segundos, sin tocar el sitio).
