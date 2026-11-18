/**
 * Backend del panel (Cloudflare Worker).
 *
 * El token de GitHub vive en el Worker: el navegador solo envía usuario y
 * contraseña, y el panel del dominio puede subir música, editar pistas y
 * gestionar usuarios sin pasar por GitHub.
 */
export const PANEL_ENDPOINT = "https://darkwaves-panel.profilebio-me.workers.dev";
