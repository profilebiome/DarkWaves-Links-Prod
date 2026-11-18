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

La página bloquea clic derecho, arrastre, copia, `Ctrl/Cmd+S`, `Ctrl/Cmd+P`,
`PrintScreen` (vacía el portapapeles), `F12` y las herramientas de desarrollo, y
oculta el documento al imprimir. Son disuasores: **ningún navegador puede impedir
realmente una captura de pantalla o una grabación**, porque el sistema operativo
captura píxeles sin consultar a la página. Tampoco existe forma de bloquear
`getDisplayMedia` desde la web. Para una protección real del audio hace falta DRM
(Widevine/FairPlay), que este proyecto no implementa.

## Publicar en GitHub Pages

El sitio se sirve desde la raíz de la rama `main`:

1. `index.html` en la raíz (no dentro de una subcarpeta).
2. `.nojekyll` para desactivar Jekyll.
3. `CNAME` con tu dominio (`musiclinks.profilebio.me`).
4. Settings → Pages → Deploy from a branch → `main` / `(root)`.

Con eso la portada ya no muestra el README: carga el reproductor.

## Límite importante

En GitHub Pages todos los archivos del repositorio son públicos: cualquiera puede abrir la URL del MP3. **No es posible impedir la descarga en hosting estático**, solo se puede ocultar el enlace en la interfaz, y las contraseñas por pista del panel **no se aplican** en ese modo. Si la prioridad es que nadie acceda al archivo original, hace falta el servidor con backend (`npm run dev`) desplegado en un hosting con Node y almacenamiento privado.

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
