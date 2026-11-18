/**
 * Token del repositorio compartido por todo el sitio (opcional).
 *
 * Si `SHARED_TOKEN` tiene valor, cualquier cuenta del panel que entre desde
 * cualquier navegador puede administrar sin pegar nada: el panel usa este token
 * automáticamente.
 *
 * OJO: este archivo se publica en GitHub Pages. Cualquiera que abra el sitio
 * puede leer el token, así que SOLO debe ser un token fine-grained limitado a
 * este repositorio con el permiso `Contents: Read and write`. Nunca un token
 * clásico con permisos de cuenta (repo + admin / workflow / delete_repo…):
 * con uno de esos, quien lo lea puede borrar tus repositorios.
 *
 * Se rellena con:  node tools/set-shared-token.mjs <token>
 * El valor va ofuscado en base64 invertido (no es cifrado, solo evita que un
 * grep casual lo encuentre).
 */

export const SHARED_OWNER = "profilebiome";
export const SHARED_REPO = "DarkWaves-Links-Prod";
export const SHARED_BRANCH = "main";

/** Vacío = nadie comparte token; cada administrador pega el suyo una vez. */
export const SHARED_TOKEN = "";
