/**
 * Cambios del panel sin servidor (GitHub Pages).
 *
 * El sitio publicado no puede escribir en el repositorio, así que el panel deja
 * un archivo pequeño en `shared/_pending/` o `music/_pending/` usando el editor
 * de GitHub con el contenido ya rellenado. Al pulsar "Commit changes", la Action
 * `.github/workflows/apply-panel.yml` aplica el cambio y publica el sitio.
 *
 * Sin tokens, sin cuentas nuevas y sin servidores: todo dentro de GitHub.
 */

export const REPO = { owner: "profilebiome", repo: "DarkWaves-Links-Prod", branch: "main" };

const slug = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
};

/** URL del editor de GitHub con el archivo nuevo ya escrito. */
export function pendingUrl(target, payload) {
  const file = `${target.replace(/\/+$/, "")}/${slug()}.json`;
  const value = JSON.stringify(payload, null, 2);
  const base = `https://github.com/${REPO.owner}/${REPO.repo}/new/${REPO.branch}`;
  return `${base}/${file}?filename=${encodeURIComponent(file.split("/").pop())}&value=${encodeURIComponent(value)}`;
}

export function openPending(target, payload) {
  const url = pendingUrl(target, payload);
  window.open(url, "_blank", "noopener");
  return url;
}

/** Página de GitHub para subir archivos a music/ a mano. */
export function uploadPageUrl() {
  return `https://github.com/${REPO.owner}/${REPO.repo}/upload/${REPO.branch}/music`;
}

export const PENDING_MESSAGE =
  "Se abrió GitHub con el cambio preparado: pulsa «Commit changes» y en ~1 minuto se aplica en el sitio.";
