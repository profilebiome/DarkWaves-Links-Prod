# DarkWaves — Console

Reproductor musical en negro y azul oscuro. Funciona de dos formas con el mismo código:

- **GitHub Pages** (público, sin servidor): lee la playlist de `music/tracks.json` y sirve el audio desde `music/`.
- **Local** (privado): un servidor Node lee tu carpeta `music/` y transmite cada pista con enlace firmado.

## Añadir música

Copia tus archivos a `music/` (MP3, WAV, FLAC, M4A, AAC, OGG, OPUS o WEBM) y actualiza la playlist:

```bash
npm run manifest
```

Si subes la música directamente desde GitHub, la acción **Actualizar playlist** regenera `music/tracks.json` sola al hacer push. No tienes que tocar el JSON a mano.

Si nombras los archivos como `Artista - Título.mp3`, se separan artista y título automáticamente.

## Uso local

Requiere Node.js 18 o superior. No tiene dependencias: no hace falta `npm install`.

```bash
npm run dev
```

Abre http://localhost:4321. En este modo `/music` no se sirve y el audio sale en streaming por enlaces firmados que caducan.

## Panel de administración

Con el servidor local (`npm run dev`) abre **http://localhost:4321/admin**.

- **Credenciales iniciales:** usuario `admin`, contraseña `darkwaves`. Cámbiala en
  *Tu contraseña* la primera vez.
- Al arrancar por primera vez se crea `data/users.json` (contraseñas con `scrypt`).
  Si existe el antiguo `data/admin.json`, su cuenta se migra con la misma contraseña.
  Puedes fijar las credenciales iniciales con `DARKWAVES_ADMIN_USER` y
  `DARKWAVES_ADMIN_PASSWORD` antes del primer arranque.
- **Varios administradores:** en *Usuarios del panel* el usuario principal crea
  cuentas nuevas (de 3 a 32 caracteres: minúsculas, números, punto, guion o guion
  bajo) con su contraseña. Todos tienen los mismos permisos: subir música, editar
  pistas, borrarlas y asignar la contraseña de cada audio. Solo el principal crea,
  borra o restablece cuentas, y su propia cuenta no se puede borrar.
- **Subir música:** elige el archivo y rellena título, artista, álbum, género, año,
  descripción y la contraseña de la pista (obligatoria). El archivo se guarda en
  `music/` y los datos en `data/tracks.json`.
- **Contraseña por pista (obligatoria):** el audio de cada pista solo se entrega a
  quien escriba su clave. El reproductor la pide al pulsar la pista y recuerda el
  permiso 12 h. Una pista subida sin clave (o a la que se le quita) queda bloqueada
  y no se puede escuchar hasta asignarle una.
- **Acceso:** el botón *Admin* de la esquina superior derecha del reproductor abre
  el inicio de sesión; al entrar te lleva al panel.
- **Editar / borrar:** cada fila de la biblioteca permite cambiar los datos, poner
  o quitar la contraseña y eliminar el archivo del disco.

`data/` está en `.gitignore`: nunca subas credenciales ni contraseñas al repositorio.
El panel solo existe en el servidor local; en GitHub Pages no hay backend que pueda
validar contraseñas ni recibir archivos.

Si quieres abrirlo desde otro equipo de tu red, arranca con
`DARKWAVES_HOST=0.0.0.0 npm run dev` y hazlo siempre por HTTPS o en una red de
confianza: el login viaja en texto plano sin TLS.

## Protección anti-captura

`shared/protect.js` aplica cuatro capas, todas de disuasión:

1. **Copia directa:** bloquea clic derecho, arrastre, copia, `Ctrl/Cmd+S`,
   `Ctrl/Cmd+P`, `PrintScreen` (vacía el portapapeles), `F12` y las herramientas
   de desarrollo, y oculta el documento al imprimir.
2. **APIs de captura dentro de la página:** `getDisplayMedia` (compartir pantalla),
   `captureStream` del audio y picture-in-picture quedan deshabilitados, así que
   una extensión o un script en la propia página no puede grabar el audio.
3. **Pestaña oculta o ventana sin foco:** pausa el audio, tapa el contenido con un
   aviso y lo restaura al volver. Es el instante en que se abre el grabador o se
   cambia de aplicación.
4. **Marca de agua:** dominio, usuario (si está logueado) y hora, cada 30 s. No
   impide grabar, pero identifica la sesión si la grabación se filtra.

**Límite real:** ningún navegador puede impedir una captura o una grabación. El
sistema operativo captura píxeles sin consultar a la página: Win+PrtScn, Recortes,
Cmd+Shift+5, OBS, Game Bar, una capturadora HDMI o el grabador nativo de Android e
iOS (que además no dispara ningún evento, así que es indetectable). Una cámara
apuntando al monitor no se puede bloquear de ninguna manera. Para una protección
de salida real hace falta DRM (Widevine/FairPlay con HDCP), que este proyecto no
implementa y que tampoco detiene una cámara.

## Publicar en GitHub Pages (solo reproductor, sin backend)

El sitio se sirve desde la raíz de la rama `main`:

1. `index.html` en la raíz (no dentro de una subcarpeta).
2. `.nojekyll` para desactivar Jekyll.
3. `CNAME` con el dominio de Pages (`josspreview.profilebio.me`).
4. Settings → Pages → Deploy from a branch → `main` / `(root)`.

Con eso la portada ya no muestra el README: carga el reproductor.

## Publicar con backend (usuarios, panel y contraseñas de verdad)

GitHub Pages no ejecuta `server.mjs`: allí `/api/*` responde 404, el login no
funciona y las contraseñas por pista no se aplican. Para que el panel, las cuentas
y las claves de pista funcionen, el sitio tiene que correr en un host con Node y
un disco persistente.

### Render (Blueprint incluido)

1. Dashboard → **New → Blueprint** → elige este repositorio. Render lee
   `render.yaml` y crea el servicio con su disco de 5 GB en `/var/data`.
2. Define las variables que pide (`sync: false`): `DARKWAVES_ADMIN_USER` y
   `DARKWAVES_ADMIN_PASSWORD`. Solo se usan la primera vez, cuando `data/` está
   vacío; después se cambia la clave en `/admin` → *Seguridad*.
3. Apunta el dominio: en el servicio → *Custom Domains* agrega
   `josspreview.profilebio.me` y crea en tu DNS el CNAME que te indique Render.
4. Si ese dominio sigue apuntando a GitHub Pages, primero quita el dominio en
   Settings → Pages para que no peleen por el mismo CNAME.

El disco requiere una instancia de pago (Starter). Sin disco el sitio funciona,
pero pierde en cada reinicio las subidas, las cuentas y las sesiones.

### Docker (Railway, Fly.io, VPS)

```bash
docker build -t darkwaves .
docker run -d -p 4321:4321 -v darkwaves-data:/var/data \
  -e NODE_ENV=production -e DARKWAVES_PUBLIC_URL=https://tu-dominio \
  -e DARKWAVES_ADMIN_USER=admin -e DARKWAVES_ADMIN_PASSWORD='algo-largo' \
  darkwaves
```

Variables que entiende el servidor:

| Variable | Para qué |
| --- | --- |
| `PORT` | Puerto del host (Render/Railway lo inyectan). También `DARKWAVES_PORT`. |
| `DARKWAVES_HOST` | Interfaz de escucha. Por defecto `0.0.0.0` con `NODE_ENV=production`. |
| `DARKWAVES_DATA_DIR` | Carpeta de `users.json`, `tracks.json`, `sessions.json` (disco). |
| `DARKWAVES_MUSIC_DIR` | Carpeta de audio (disco). Si está vacía se copia la del repo. |
| `DARKWAVES_SECURE_COOKIES` | `1`/`0` para forzar cookies `Secure`. Por defecto activas en producción. |
| `DARKWAVES_PUBLIC_URL` | Solo para los mensajes del arranque. |
| `DARKWAVES_ADMIN_USER` / `DARKWAVES_ADMIN_PASSWORD` | Cuenta principal en el primer arranque. |

`GET /healthz` responde `{"ok":true}` para el chequeo del host.

### Después del primer despliegue

1. Entra a `/admin` con la cuenta principal y cambia la contraseña.
2. Crea las cuentas de *Usuarios del panel* que necesites.
3. **Asigna contraseña a cada pista:** las pistas que ya existían antes del panel
   no tienen clave y quedan bloqueadas (`hasPassword: false`). En *Biblioteca* →
   editar → *Nueva contraseña* se arregla.

## Límite importante

En GitHub Pages todos los archivos del repositorio son públicos: cualquiera puede abrir la URL del MP3. **No es posible impedir la descarga en hosting estático**, solo se puede ocultar el enlace en la interfaz, y las contraseñas por pista del panel **no se aplican** en ese modo. Con el backend desplegado, el audio sale por `/stream/<id>?t=<firma>` con enlace firmado que caduca a las 6 h y `music/` nunca se sirve directo.

## Estructura

```
index.html              reproductor
admin.html              panel de administración
shared/                 motor de audio, estilos y anti-captura
music/                  tus pistas + tracks.json
data/                   credenciales y metadatos del panel (privado, ignorado por git)
tools/build-manifest.mjs   genera la playlist
server.mjs              servidor local + API del panel
.github/workflows/      actualiza la playlist al subir música
```
