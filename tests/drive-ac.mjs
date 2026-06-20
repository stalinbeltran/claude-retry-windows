// Driver de prueba para el auto-confirm del wrapper.
// Lanza `node claude-retry.mjs` (interactivo) con stdin por tuberia y le inyecta
// el prompt y, por SEPARADO tras una pausa, la tecla Enter — para que la TUI de
// claude no trate el envio como un "pegado" (que insertaria el salto de linea como
// texto en vez de enviar). Mantiene la sesion viva un tiempo y luego mata el arbol.
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// El wrapper vive en la raiz del repo (un nivel por encima de tests/).
const wrapper = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-retry.mjs');

const PROMPT =
  'Crea un archivo de texto llamado auto-confirm-ok.txt cuyo unico contenido sea ' +
  'la palabra HOLA. Hazlo directamente.';

const env = { ...process.env, CR_AUTO_CONFIRM: '1' };
// stdin por pipe (asi el wrapper no entra en raw mode y reenvia lo que escribimos);
// stdout/stderr heredados para que su salida fluya al log que abre PowerShell.
const child = spawn('node', [wrapper], { stdio: ['pipe', 'inherit', 'inherit'], env });

const t = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await t(5000); // deja que la TUI de claude termine de iniciar
  child.stdin.write(PROMPT); // 1) escribe el prompt (sin Enter)
  await t(2500); // 2) pausa: cierra la ventana de deteccion de "pegado"
  child.stdin.write('\r'); // 3) Enter por separado -> envia
  await t(75000); // 4) deja trabajar a claude y al auto-confirm
  // 5) mata el arbol (la sesion interactiva no termina sola)
  execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => process.exit(0));
})();
