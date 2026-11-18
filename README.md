# DarkWaves

Reproductor de música en negro y azul oscuro para GitHub Pages, con panel de
administración, contraseña por pista y protectores anti-captura.

- **Sitio:** https://josspreview.profilebio.me
- **Panel:** https://josspreview.profilebio.me/admin (login `admin` / `admin`)
- **Tu PC:** doble clic en `Iniciar-Panel.bat` → `http://localhost:4321/admin`

## Añadir música

1. Copia el archivo de audio a `music/` (mp3, wav, flac, m4a, aac, ogg, opus, webm).
2. `npm run manifest` regenera `music/tracks.json`.
3. Sin servidor, la pista queda **bloqueada** hasta asignarle una contraseña desde
   el panel local (`npm run dev` → *Biblioteca* → *Editar* → *Nueva contraseña*).

El flujo normal es el del panel: eliges el archivo, rellenas los datos y la clave,
y el servidor guarda el audio, el título, el artista, el álbum, el género, el año,
la descripción y la contraseña.

## Uso local (panel completo)

Requiere Node.js 18 o superior. No hay dependencias: no hace falta `npm install`.

```bash
npm run dev     # o doble clic en Iniciar-Panel.bat
```

Abre http://localhost:4321/admin. Aquí el panel es completo:

- **Login dentro del propio panel** (`admin` / `admin` por defecto).
- **Subir música** con título, artista, álbum, género, año, descripción y contraseña.
- **Biblioteca**: editar datos, cambiar o quitar la contraseña, borrar la pista.
- **Usuarios del panel**: crear cuentas, restablecer su contraseña y borrarlas
  (solo la cuenta principal); todas pueden subir música y editar pistas.
- **Tu contraseña**: cambiar la de tu propia cuenta.
- Cada cambio se guarda y el servidor hace `git add` + `commit` + `push` con tu git,
  así que el sitio publicado se actualiza en ~1 minuto.
  Se desactiva con `DARKWAVES_PUSH=0`, y el estado se consulta en
  `GET /api/admin/publish`.

Contraseñas iniciales: `admin` / `admin` y `jossgiant` / `Dark-Joss-7mB3Zp8R`.
Cámbialas en *Seguridad* y *Usuarios del panel*. Se pueden fijar de nuevo con:

```bash
npm run reset-accounts -- --users "admin:Clave1,jossgiant:Clave2" --track-password "ClaveDePistas"
```

## Qué funciona en el sitio publicado (GitHub Pages)

GitHub Pages **solo entrega archivos**: no ejecuta `server.mjs`, así que allí no se
puede guardar un usuario nuevo ni un MP3. Lo que sí funciona, sin pedir nada:

| | Panel en tu PC (`npm run dev`) | Sitio publicado (Pages) |
| --- | --- | --- |
| Login con usuario y contraseña | Sí | Sí |
| Escuchar pistas con su contraseña | Sí | Sí |
| Subir música | Sí | No (Pages no ejecuta código) |
| Editar / borrar pistas y claves | Sí | No |
| Crear / borrar usuarios | Sí | No |

Los datos de login y las claves de las pistas viajan al sitio dentro de
`shared/accounts.json` (hash PBKDF2) y `music/tracks.json` (`key`), que el servidor
local regenera solo:

```bash
npm run accounts   # shared/accounts.json desde data/users.json
npm run manifest    # music/tracks.json desde music/ + data/tracks.json
```

`data/` está en `.gitignore`: las credenciales privadas y las sesiones no se suben.

## DNS en Cloudflare

El dominio `josspreview.profilebio.me` vive en GitHub Pages (archivo `CNAME`). En
Cloudflare, en la zona `profilebio.me`:

| Tipo | Nombre | Contenido | Proxy |
| --- | --- | --- | --- |
| CNAME | `josspreview` | `profilebiome.github.io` | **DNS only** (nube gris) |

Y en GitHub: *Settings → Pages → Custom domain* = `josspreview.profilebio.me`, con
**Enforce HTTPS** activado. El proxy de Cloudflare debe quedar desactivado (nube
gris) para que GitHub pueda emitir el certificado.

## App Android con bloqueo real de grabación

La web **no puede** impedir que el sistema operativo grabe la pantalla (ningún
navegador puede). Para tener el comportamiento de Telegram —pantalla en negro al
capturar o grabar— está el proyecto `android-app/`, que carga el sitio dentro de
una app y activa `FLAG_SECURE` en la ventana.

El APK lo compila GitHub Actions (`.github/workflows/android.yml`) en cada cambio:
GitHub → **Actions → Compilar app Android (APK)** → descarga el artefacto
`DarkWaves-apk` e instálalo en Android (permitir “instalar apps desconocidas”).

- En Android, con la app: capturas y grabadores del sistema graban **negro**.
- En iPhone no existe ese bloqueo; solo se puede detectar la grabación y tapar.
- En la web (navegador) no se puede bloquear, solo estorbar.

## Protección anti-captura

`shared/protect.js` aplica disuasores, no una barrera real:

1. Bloquea menú contextual, arrastre, copia, `Ctrl/Cmd+S`, `Ctrl/Cmd+P`,
   `PrintScreen`, `F12` y las herramientas de desarrollo; oculta el documento al imprimir.
2. Deshabilita dentro de la página `getDisplayMedia`, `captureStream` y
   picture-in-picture.
3. Si la pestaña se oculta o la ventana pierde el foco: pausa el audio, tapa el
   contenido con un aviso y lo restaura al volver.
4. Marca de agua con dominio, usuario y hora cada 30 s.

**Límite:** ningún navegador puede impedir una grabación. Windows/macOS, OBS, una
capturadora o el grabador nativo de Android/iOS capturan la pantalla sin consultar
a la página, y una cámara apuntando al monitor no se puede bloquear. Esto encarece
la copia y deja rastro; no la impide.

## Estructura

```
index.html            reproductor (GitHub Pages)
admin.html            panel de administración
server.mjs            servidor local: panel completo, streaming firmado, sesiones
shared/player.js      reproductor y visualizador
shared/protect.js     disuasores anti-captura y marca de agua
shared/static-auth.js login y claves de pista sin servidor (PBKDF2, WebCrypto)
shared/accounts.json  cuentas publicadas (solo hashes PBKDF2)
shared/password-record.mjs  scrypt (servidor) + PBKDF2 (navegador)
music/                audio y music/tracks.json
tools/                manifest, cuentas, reinicio de credenciales, check-deploy
data/                 privado (gitignored): usuarios, metadatos con claves, sesiones
Iniciar-Panel.bat     arranca el panel local y abre el navegador
```
