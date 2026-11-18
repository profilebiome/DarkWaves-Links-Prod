/**
 * Backend del panel (Cloudflare Worker).
 *
 * Si tiene una URL, el panel del sitio publicado funciona completo desde el
 * dominio: subir música, editar pistas, claves y usuarios. El token de GitHub
 * vive en el Worker; el navegador solo envía usuario y contraseña.
 *
 * Se rellena al desplegar:
 *   export const PANEL_ENDPOINT = "https://darkwaves-panel.TU-USUARIO.workers.dev";
 */
export const PANEL_ENDPOINT = "";
