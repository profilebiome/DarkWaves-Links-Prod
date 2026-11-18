# Desplegar DarkWaves con backend

**El panel completo (subir MP3, crear usuarios, claves) no puede vivir dentro de
GitHub Pages**, porque Pages solo entrega archivos y no ejecuta código. El servidor
que sí lo hace es el mismo que ya funciona en tu PC (`server.mjs`); aquí se publica
en un host conectado a tu repositorio de GitHub.

Despliegue en 3 clics (sin tarjeta, sin tokens en el navegador):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/profilebiome/DarkWaves-Links-Prod)

1. Entra con **Sign in with GitHub** (no pide contraseña nueva ni tarjeta).
2. Acepta el `render.yaml` (te pedirá `DARKWAVES_ADMIN_USER` y
   `DARKWAVES_ADMIN_PASSWORD`: la cuenta principal del panel).
3. Cuando diga *Live*, tu panel completo estará en esa URL y podrás apuntarle el
   dominio `josspreview.profilebio.me` (paso 4 de esta guía).

Resultado esperado: `node tools/check-deploy.mjs https://josspreview.profilebio.me`
termina con **BACKEND ACTIVO**. Si prefieres que lo despliegue yo, pásame una llave
API del host (`CF`/`Render`) y lo hago en un comando — el token queda en el servidor,
nunca en el sitio.

---

## 1. Cuenta en el host

Render: entra a <https://render.com> con tu cuenta de GitHub.

## 2. Crear el servicio desde el Blueprint

1. Dashboard → **New +** → **Blueprint**.
2. Elige el repositorio `profilebiome/DarkWaves-Links-Prod` (rama `main`).
3. Render lee `render.yaml` y muestra el servicio `darkwaves-links` con su disco
   de 5 GB en `/var/data`.
4. Cuando pida las variables marcadas `sync: false`, escribe:
   - `DARKWAVES_ADMIN_USER` → el usuario principal que quieras (por ejemplo `admin`)
   - `DARKWAVES_ADMIN_PASSWORD` → una contraseña larga y única (mínimo 12 caracteres)
5. **Apply**. El plan del Blueprint es `starter` porque el disco persistente no
   existe en el plan gratuito; si aceptas perder subidas y cuentas en cada
   reinicio, cámbialo a `free` y quita el bloque `disk:`.

Espera a que el deploy diga **Live** y abre la URL `https://darkwaves-links.onrender.com`.

## 3. Comprobar antes de tocar el dominio

```bash
node tools/check-deploy.mjs https://darkwaves-links.onrender.com
```

Debe salir **BACKEND ACTIVO**. Si sale *SOLO ESTÁTICO*, el servicio no arrancó
(revisa los logs del deploy).

## 4. Dominio propio

1. En Render → servicio → **Settings → Custom Domains → Add Custom Domain** →
   `josspreview.profilebio.me`.
2. Render te da un destino tipo `darkwaves-links.onrender.com`. En el DNS de
   `profilebio.me` crea el registro que indique (normalmente
   `CNAME josspreview → darkwaves-links.onrender.com`).
3. **Antes**, libera el dominio en GitHub Pages: repo → **Settings → Pages →
   Custom domain** → bórralo (si no, Pages y Render pelean por el mismo CNAME).
4. Espera el certificado (Render lo emite solo) y vuelve a comprobar:

```bash
node tools/check-deploy.mjs https://josspreview.profilebio.me
```

## 5. Primer arranque dentro del panel

Entra a `/admin` con la cuenta del paso 2.

1. **Seguridad** → cambia la contraseña inicial.
2. **Usuarios del panel** → crea las cuentas que necesites (por ejemplo `jossgiant`).
   Las cuentas de tu `data/` local no viajan al host: ese archivo es privado y
   está en `.gitignore`.
3. **Biblioteca** → edita cada pista → **Nueva contraseña**. Las pistas que
   existían antes del panel no tienen clave y quedan bloqueadas
   (`hasPassword: false`) hasta asignarles una.
4. Sube música nueva desde **Biblioteca → Subir**: los archivos van al disco
   (`DARKWAVES_MUSIC_DIR`) y sobreviven a los despliegues.

## 6. Qué se guarda y dónde

| Ruta en el disco | Contenido |
| --- | --- |
| `/var/data/data/users.json` | Cuentas y hashes `scrypt` |
| `/var/data/data/tracks.json` | Títulos, artistas y contraseñas de pista |
| `/var/data/data/sessions.json` | Sesiones del panel (sobreviven al reinicio) |
| `/var/data/music/` | Audio subido y la copia inicial del repo |

Sin disco (`free`), esas rutas se pierden en cada reinicio y el servidor vuelve a
crear la cuenta principal desde `DARKWAVES_ADMIN_USER` / `DARKWAVES_ADMIN_PASSWORD`.

## Alternativa: Docker

```bash
docker build -t darkwaves .
docker run -d -p 4321:4321 -v darkwaves-data:/var/data \
  -e NODE_ENV=production \
  -e DARKWAVES_PUBLIC_URL=https://josspreview.profilebio.me \
  -e DARKWAVES_ADMIN_USER=admin \
  -e DARKWAVES_ADMIN_PASSWORD='una-clave-larga' \
  darkwaves
```

## GitHub Pages

Puedes dejar Pages como escaparate estático (sigue leyendo `music/tracks.json`),
pero allí no hay login ni contraseñas por pista: `/api/*` responde 404. Lo que
impide descargar el MP3 original es el backend, no el JavaScript de la página.
