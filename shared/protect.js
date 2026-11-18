/**
 * Deterrentes de captura de pantalla / grabación de pantalla.
 *
 * Ningún navegador permite bloquear de verdad una captura: el sistema
 * operativo o un móvil pueden capturar la pantalla sin avisar a la página.
 * Estas medidas encarecen el intento (atajos, clic derecho, arrastre,
 * impresión, copia de texto y limpieza del portapapeles tras PrintScreen),
 * pero no son una barrera criptográfica.
 */
export function protectMedia(root = document.body) {
  const scope = root || document.body;
  scope.classList.add("dw-protected");

  const blockMenu = (event) => {
    const inPlayer = event.target && event.target.closest
      ? event.target.closest(".wave, .list, .transport, .title-block, canvas, audio")
      : null;
    if (inPlayer) event.preventDefault();
  };

  const blockDrag = (event) => event.preventDefault();

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

  const blockSelect = (event) => {
    if (event.target && event.target.closest && event.target.closest(".wave, .list")) {
      event.preventDefault();
    }
  };

  document.addEventListener("contextmenu", blockMenu);
  document.addEventListener("dragstart", blockDrag);
  document.addEventListener("selectstart", blockSelect);
  document.addEventListener("keydown", blockKeys, true);
  document.addEventListener("keyup", clearClipboard, true);
  document.addEventListener("copy", noCopy);

  window.addEventListener("beforeprint", () => {
    document.documentElement.classList.add("dw-printing");
  });
  window.addEventListener("afterprint", () => {
    document.documentElement.classList.remove("dw-printing");
  });

  return () => {
    scope.classList.remove("dw-protected");
    document.removeEventListener("contextmenu", blockMenu);
    document.removeEventListener("dragstart", blockDrag);
    document.removeEventListener("selectstart", blockSelect);
    document.removeEventListener("keydown", blockKeys, true);
    document.removeEventListener("keyup", clearClipboard, true);
    document.removeEventListener("copy", noCopy);
  };
}
