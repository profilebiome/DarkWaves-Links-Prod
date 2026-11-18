/**
 * Bloqueo de captura / grabación del reproductor.
 *
 * LÍMITE REAL: ningún navegador puede impedir que el sistema operativo capture
 * la pantalla (Win+PrtScn, Recortes, Cmd+Shift+3/4/5, OBS, Game Bar, una
 * capturadora o el grabador nativo de Android/iOS). Lo que sí se puede —y es lo
 * que hace este módulo— es:
 *
 *   1. Bloquear las grabaciones hechas DESDE la página: `getDisplayMedia`
 *      (compartir pantalla), `captureStream` del audio, picture-in-picture.
 *   2. Detectar el momento en que se abre un grabador o se cambia de ventana
 *      (pierde el foco u oculta la pestaña): PAUSA el audio y TAPA el contenido
 *      con un aviso. Lo grabado en ese instante sale en negro y en silencio.
 *   3. Bloquear los atajos de captura e impresión: PrintScreen, Alt+PrintScreen,
 *      Cmd+Shift+3/4/5, Ctrl/Cmd+P, Ctrl/Cmd+S, F12 y herramientas de desarrollo,
 *      y vaciar el portapapeles tras PrintScreen.
 *
 * No dibuja nada permanente: la página se ve exactamente igual.
 */

const GUARD_DELAY = 250; // ms de gracia antes de tapar por pérdida de foco

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

  /* Al perder el foco o ocultarse la pestaña: contenido tapado. */
  body.dw-guard main,
  body.dw-guard .dw-guard-target {
    filter: blur(30px) saturate(0.2) brightness(0.35);
  }
  .dw-guard-note {
    position: fixed;
    inset: 0;
    z-index: 2147483600;
    display: none;
    place-content: center;
    text-align: center;
    padding: 24px;
    background: #04060b;
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
`;

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

  /* ---------------------------- estilos propios ---------------------------- */
  const style = document.createElement("style");
  style.dataset.dwProtect = "styles";
  style.textContent = CSS;
  document.head.appendChild(style);
  cleanups.push(() => style.remove());

  /* ------------------------ aviso al tapar el contenido -------------------- */
  const note = document.createElement("div");
  note.className = "dw-guard-note";
  note.setAttribute("role", "status");
  note.innerHTML =
    "Contenido bloqueado mientras la ventana no está activa" +
    "<small>Vuelve a la ventana para continuar</small>";
  document.body.appendChild(note);
  cleanups.push(() => note.remove());

  /* --------------- elementos de audio creados por el reproductor ----------- */
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
  };

  const reveal = () => {
    window.clearTimeout(hiddenTimer);
    hiddenTimer = 0;
    if (!document.body.classList.contains("dw-guard")) return;
    document.body.classList.remove("dw-guard");
    resumeAll();
  };

  /* ------------- perder el foco: es cuando se abre un grabador ------------- */
  const onVisibility = () => {
    if (document.visibilityState === "hidden") conceal();
    else reveal();
  };
  on(document, "visibilitychange", onVisibility);

  const onBlur = () => {
    if (document.visibilityState === "hidden") return;
    window.clearTimeout(hiddenTimer);
    hiddenTimer = window.setTimeout(conceal, GUARD_DELAY);
  };
  on(window, "blur", onBlur);
  on(window, "focus", () => reveal());
  on(window, "pagehide", () => conceal());
  on(document, "freeze", () => conceal());

  /* ------------------------- atajos y copia directa ----------------------- */
  const blockKeys = (event) => {
    const meta = event.ctrlKey || event.metaKey;
    const key = String(event.key || "").toLowerCase();

    // Capturas por teclado del sistema.
    if (key === "printscreen" || (event.altKey && key === "printscreen")) {
      event.preventDefault();
      return;
    }
    // macOS: Cmd+Shift+3 / 4 / 5 / 6 (captura y grabación de pantalla).
    if (event.metaKey && event.shiftKey && ["3", "4", "5", "6"].includes(key)) {
      event.preventDefault();
      return;
    }
    // Imprimir / guardar la página y herramientas de desarrollo.
    if (meta && (key === "p" || key === "s")) {
      event.preventDefault();
      return;
    }
    if (event.key === "F12" || (meta && event.shiftKey && ["i", "j", "c"].includes(key))) {
      event.preventDefault();
    }
  };

  const clearClipboard = (event) => {
    if (String(event.key || "").toLowerCase() !== "printscreen") return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText("").catch(() => {});
    }
  };

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

  const noCopy = (event) => {
    const target = event.target;
    if (target && target.closest && target.closest("input, textarea, select")) return;
    const selection = String(window.getSelection && window.getSelection());
    if (!selection.trim()) return;
    event.preventDefault();
    if (event.clipboardData) event.clipboardData.setData("text/plain", "");
  };

  on(document, "keydown", blockKeys, true);
  on(document, "keyup", clearClipboard, true);
  on(document, "contextmenu", blockMenu);
  on(document, "dragstart", blockDrag);
  on(document, "selectstart", blockSelect);
  on(document, "copy", noCopy);
  on(window, "beforeprint", () => document.documentElement.classList.add("dw-printing"));
  on(window, "afterprint", () => document.documentElement.classList.remove("dw-printing"));

  /* --------------------- capturas hechas desde la página ------------------- */
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
      /* API de solo lectura en algunos navegadores */
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
