/**
 * Proxy del panel (Cloudflare Worker).
 *
 * Si tiene una URL, el panel deja de pedir tokens: manda usuario y contraseña
 * al Worker, que guarda el token de GitHub en el servidor y hace los commits.
 *
 * Se rellena cuando el Worker está desplegado:
 *   export const PANEL_ENDPOINT = "https://darkwaves-panel.TU-USUARIO.workers.dev";
 */
export const PANEL_ENDPOINT = "";
