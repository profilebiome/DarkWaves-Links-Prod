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

## Publicar en GitHub Pages

El sitio se sirve desde la raíz de la rama `main`:

1. `index.html` en la raíz (no dentro de una subcarpeta).
2. `.nojekyll` para desactivar Jekyll.
3. `CNAME` con tu dominio (`musiclinks.profilebio.me`).
4. Settings → Pages → Deploy from a branch → `main` / `(root)`.

Con eso la portada ya no muestra el README: carga el reproductor.

## Límite importante

En GitHub Pages todos los archivos del repositorio son públicos: cualquiera puede abrir la URL del MP3. **No es posible impedir la descarga en hosting estático**, solo se puede ocultar el enlace en la interfaz. Si la prioridad es que nadie acceda al archivo original, hace falta hosting con backend y almacenamiento privado.

## Estructura

```
index.html              reproductor
shared/                 motor de audio y estilos
music/                  tus pistas + tracks.json
tools/build-manifest.mjs   genera la playlist
server.mjs              servidor local opcional
.github/workflows/      actualiza la playlist al subir música
```
