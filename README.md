# DarkWaves — Console

Reproductor musical local en negro y azul oscuro. Lees tu propia carpeta `music/`, la web genera la playlist sola y reproduce en streaming, sin exponer los archivos para descarga directa.

## Uso

Requiere Node.js 18 o superior. No tiene dependencias: no hace falta `npm install`.

```bash
npm run dev
```

Abre http://localhost:4321 y copia tus temas a la carpeta `music/`. La lista se actualiza al recargar.

Formatos: MP3, WAV, FLAC, M4A, AAC, OGG, OPUS y WEBM.

Si nombras los archivos como `Artista - Título.mp3`, se separan artista y título automáticamente.

## Estructura

```
server.mjs          servidor local (API + streaming)
public/index.html   reproductor
public/shared/      motor de audio y estilos base
music/              tus archivos (no se suben a GitHub)
```

## Privacidad

- `/music` no se sirve y los archivos no se listan por URL directa.
- Cada pista usa un enlace firmado que caduca.
- El audio se entrega en streaming (`206` con `Range`), sin `Content-Disposition: attachment`.

Ningún reproductor web puede impedir al 100 % que alguien capture el audio que suena; esto protege el archivo original y la descarga directa.

## Puerto

Por defecto `4321`. Puedes cambiarlo con `DARKWAVES_PORT`:

```bash
DARKWAVES_PORT=5000 npm run dev
```
