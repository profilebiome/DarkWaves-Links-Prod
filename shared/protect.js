/**
 * Deterrentes de captura de pantalla / grabación de pantalla.
 *
 * Ningún navegador permite bloquear de verdad una grabación: el sistema
 * operativo (Win+PrtScn, Recortes, Cmd+Shift+5, OBS, Game Bar) o el grabador
 * nativo de un móvil pueden capturar la pantalla sin avisar a la página, y una
 * cámara apuntando al monitor no se puede detectar de ninguna forma. En iOS y
 * Android la grabación ni siquiera dispara un evento.
 *
 * Lo que sí hace este módulo:
 *   1. Encarece la copia directa (menú, atajos, arrastre, imprimir, portapapeles).
 *   2. Inutiliza las APIs de captura dentro de la propia página
 *      (getDisplayMedia, MediaRecorder sobre el audio, picture-in-picture).
 *   3. Tapa el contenido y pausa el audio cuando la pestaña se oculta o la
 *      ventana pierde el foco, que es el momento en que el usuario lanza un
 *      grabador o cambia de app.
 *   4. Deja una marca de agua con dominio y hora: no impide grabar, pero hace
 *      rastreable la copia.
 *
 * Es disuasión, no una barrera criptográfica.
 */

const GUARD_DELAY = 350; // ms de gracia antes de tapar por pérdida de foco
const MARK_INTERVAL = 30_000;

const CSS = `
  body.dw-protected {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  body.dw-protected input,
  body.dw-protected textarea,
  body.dw-protected select {
    -webkit-user-select: text;
    user-select: text;
  }
  canvas, audio, video { -webkit-user-drag: none; }

  /* Contenido tapado mientras la pestaña está oculta o sin foco. */
  body.dw-guard main,
  body.dw-guard .dw-guard-target {
    filter: blur(26px) saturate(0.4);
    transition: none;
  }
  .dw-guard-note {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: none;
    place-content: center;
    text-align: center;
    padding: 24px;
    background: #05070d;
    color: #cfe0ff;
    font: 600 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.04em;
  }
  body.dw-guard .dw-guard-note { display: grid; }
  .dw-guard-note small {
    display: block;
    margin-top: 10px;
    font-weight: 400;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #6f86b8;
  }

  /* Marca de agua: identifica la sesión si la grabación se filtra. */
  .dw-mark {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 2147482000;
    pointer-events: none;
    font: 500 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #dbe7ff;
    opacity: 0.22;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
    white-space: nowrap;
  }
  body.dw-guard .dw-mark { display: none; }
`;

function stamp() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);
  return `${date} ${time}`;
}

export function protectMedia(root = document.body) {
  const scope = root || document.body;
  const cleanups = [];
  const guardedMedia = new Set();
  let hiddenTimer = 0;

  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  scope.classList.add("dw-protected");

  /* ---------- CSS propio (no depende del CSS de cada página) ---------- */
  const style = document.createElement("style");
  style.dataset.dwProtect = "styles";
  style.textContent = CSS;
  document.head.appendChild(style);
  cleanups.push(() => style.remove());

  /* ---------- Aviso al tapar el contenido ---------- */
  const note = document.createElement("div");
  note.className = "dw-guard-note";
  note.setAttribute("role", "status");
  note.innerHTML =
    "Contenido oculto mientras la ventana está en segundo plano" +
    "<small>Vuelve a la ventana para continuar</small>";
  document.body.appendChild(note);
  cleanups.push(() => note.remove());

  /* ---------- Marca de agua ---------- */
  const mark = document.createElement("div");
  mark.className = "dw-mark";
  mark.setAttribute("aria-hidden", "true");
  document.body.appendChild(mark);
  cleanups.push(() => mark.remove());

  const paintMark = () => {
    const user = document.body.dataset.dwUser || "";
    const host = window.location.hostname || "local";
    mark.textContent = [host, user, stamp()].filter(Boolean).join(" · ");
  };
  paintMark();
  const markTimer = window.setInterval(paintMark, MARK_INTERVAL);
  cleanups.push(() => window.clearInterval(markTimer));

  /* ---------- Captura de elementos de audio/vídeo creados por JS ---------- */
  // El reproductor crea `new Audio()` fuera del DOM, así que no basta con
  // querySelectorAll: se registra cada media en cuanto empieza a sonar.
  const Media = window.HTMLMediaElement;
  if (Media) {
    const nativePlay = Media.prototype.play;
    Media.prototype.play = function patchedPlay(...args) {
      guardedMedia.add(this);
      return nativePlay.apply(this, args);
    };
    cleanups.push(() => {
      Media.prototype.play = nativePlay;
    });
  }

  const pauseAll = () => {
    for (const element of guardedMedia) {
      if (element && !element.paused) {
        element.dataset.dwWasPlaying = "1";
        element.pause();
      }
    }
  };

  const resumeAll = () => {
    for (const element of guardedMedia) {
      if (element && element.dataset.dwWasPlaying === "1") {
        delete element.dataset.dwWasPlaying;
        element.play().catch(() => {});
      }
    }
  };

  const conceal = () => {
    if (document.body.classList.contains("dw-guard")) return;
    pauseAll();
    document.body.classList.add("dw-guard");
    paintMark();
  };

  const reveal = () => {
    window.clearTimeout(hiddenTimer);
    hiddenTimer = 0;
    if (!document.body.classList.contains("dw-guard")) return;
    document.body.classList.remove("dw-guard");
    resumeAll();
  };

  /* ---------- Pestaña oculta: tapar de inmediato ---------- */
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      conceal();
    } else {
      reveal();
    }
  };
  on(document, "visibilitychange", onVisibility);

  /* ---------- Ventana sin foco: tapar con una pausa corta ---------- */
  const onBlur = () => {
    if (document.visibilityState === "hidden") return;
    window.clearTimeout(hiddenTimer);
    hiddenTimer = window.setTimeout(conceal, GUARD_DELAY);
  };
  const onFocus = () => reveal();
  on(window, "blur", onBlur);
  on(window, "focus", onFocus);
  on(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") reveal();
  });

  /* ---------- Copia directa: menú, arrastre, selección, impresión ---------- */
  const blockMenu = (event) => {
    const inPlayer =
      event.target && event.target.closest
        ? event.target.closest(".wave, .list, .transport, .title-block, canvas, audio")
        : null;
    if (inPlayer) event.preventDefault();
  };

  const blockDrag = (event) => event.preventDefault();

  const blockSelect = (event) => {
    if (event.target && event.target.closest && event.target.closest(".wave, .list")) {
      event.preventDefault();
    }
  };

  const blockKeys = (event) => {
    const meta = event.ctrlKey || event.metaKey;
    const key = String(event.key || "").toLowerCase();
    // Imprimir / guardar la página y ver el código fuente.
    if (meta && (key === "p" || key === "s")) {
      event.preventDefault();
      return;
    }
    if (key === "printscreen") {
      event.preventDefault();
      return;
    }
    if (event.key === "F12" || (meta && event.shiftKey && ["i", "j", "c"].includes(key))) {
      event.preventDefault();
    }
  };

  // El atajo de captura ya copió la imagen: la vaciamos en cuanto se suelta.
  const clearClipboard = (event) => {
    if (String(event.key || "").toLowerCase() !== "printscreen") return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText("").catch(() => {});
    }
  };

  const noCopy = (event) => {
    const target = event.target;
    // Copiar dentro de un campo de texto (buscador, formularios) sigue funcionando.
    if (target && target.closest && target.closest("input, textarea, select")) return;
    const selection = String(window.getSelection && window.getSelection());
    if (!selection.trim()) return;
    event.preventDefault();
    if (event.clipboardData) event.clipboardData.setData("text/plain", "");
  };

  on(document, "contextmenu", blockMenu);
  on(document, "dragstart", blockDrag);
  on(document, "selectstart", blockSelect);
  on(document, "keydown", blockKeys, true);
  on(document, "keyup", clearClipboard, true);
  on(document, "copy", noCopy);

  on(window, "beforeprint", () => document.documentElement.classList.add("dw-printing"));
  on(window, "afterprint", () => document.documentElement.classList.remove("dw-printing"));

  /* ---------- APIs de captura dentro de la página ---------- */
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getDisplayMedia === "function") {
    const nativeDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
    try {
      mediaDevices.getDisplayMedia = () =>
        Promise.reject(new Error("La captura de pantalla está deshabilitada en este reproductor"));
      cleanups.push(() => {
        mediaDevices.getDisplayMedia = nativeDisplayMedia;
      });
    } catch {
      /* API de solo lectura en algunos navegadores: se ignora. */
    }
  }

  if (Media) {
    for (const name of ["captureStream", "mozCaptureStream"]) {
      if (typeof Media.prototype[name] !== "function") continue;
      const nativeCapture = Media.prototype[name];
      Media.prototype[name] = function patchedCapture() {
        throw new Error("La captura del audio está deshabilitada en este reproductor");
      };
      cleanups.push(() => {
        Media.prototype[name] = nativeCapture;
      });
    }

    // Picture-in-picture deja la ventana flotando lista para grabarse aparte.
    if ("requestPictureInPicture" in Media.prototype) {
      const nativePip = Media.prototype.requestPictureInPicture;
      Media.prototype.requestPictureInPicture = function patchedPip() {
        return Promise.reject(new Error("Picture-in-picture deshabilitado"));
      };
      cleanups.push(() => {
        Media.prototype.requestPictureInPicture = nativePip;
      });
    }
  }

  return () => {
    for (const undo of cleanups.reverse()) undo();
    window.clearTimeout(hiddenTimer);
    document.body.classList.remove("dw-guard");
    scope.classList.remove("dw-protected");
  };
}
