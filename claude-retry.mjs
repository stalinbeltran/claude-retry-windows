#!/usr/bin/env node
// claude-retry — equivalente Windows-nativo de claude-auto-retry (Nivel 1: modo no interactivo)
//
// Reintenta automaticamente `claude -p ...` cuando se alcanza el limite de uso.
// No necesita tmux ni bash: corre en Node nativo en Windows.
//
// Uso:
//   node claude-retry.mjs -p "tu prompt aqui"
//   node claude-retry.mjs -p "..."  --append-system-prompt "..."   (cualquier flag de claude)
//
// Config por variables de entorno (todas opcionales):
//   CR_MAX_RETRIES        (def 5)     intentos maximos tras detectar limite
//   CR_MARGIN_SECONDS     (def 30)    segundos extra de margen tras la hora de reinicio
//   CR_FALLBACK_HOURS     (def 5)     espera si no se logra parsear la hora de reinicio
//   CR_CLAUDE_BIN         (def auto)  ruta al binario de claude
//   CR_AUTO_CONFIRM       (def off)   auto-responde prompts de confirmacion (modo interactivo)
//   CR_AUTO_CONFIRM_KEY   (def Enter) tecla a enviar al auto-confirmar ("enter", "1", "y"...)
//   CR_CONTINUE_ON_RETRY  (def off)   anade --continue al reintentar tras el limite

import { spawn, execFile } from 'node:child_process';

const CFG = {
  maxRetries: int(process.env.CR_MAX_RETRIES, 5),
  marginSeconds: int(process.env.CR_MARGIN_SECONDS, 30),
  fallbackHours: num(process.env.CR_FALLBACK_HOURS, 5),
  claudeBin: process.env.CR_CLAUDE_BIN || resolveClaudeBin(),
  autoConfirm: bool(process.env.CR_AUTO_CONFIRM, false),
  autoConfirmKey: parseKey(process.env.CR_AUTO_CONFIRM_KEY, '\r'),
  continueOnRetry: bool(process.env.CR_CONTINUE_ON_RETRY, false),
};

// --- Deteccion de limite de uso -------------------------------------------
// IMPORTANTE: estos patrones se escanean sobre TODA la salida de claude, incluido
// el texto normal de la conversacion. Por eso deben ser especificos del MENSAJE DE
// ERROR real del CLI y no frases de uso comun. Patrones amplios como /rate limit/i
// o /try again later/i producen falsos positivos (claude mencionando esos terminos
// en una respuesta normal dispara una espera de horas que no corresponde).
const RATE_LIMIT_PATTERNS = [
  /usage limit reached/i, // "Claude usage limit reached. Your limit will reset at ..."
  /claude usage limit/i, // variante del banner de suscripcion
  /\b\d+\s*-?\s*hour limit reached/i, // "5-hour limit reached ∙ resets ..."
  /you'?ve reached your.*usage limit/i,
  /rate_limit_error/i, // tipo de error en el JSON del 429 de la API
  /\b429\b[^\n]*too many requests/i, // linea explicita de HTTP 429
  /too many requests[^\n]*\b429\b/i,
];

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

// --- Deteccion de prompts de permiso/confirmacion -------------------------
// Solo aplica al modo interactivo (PTY): claude dibuja un prompt con una pregunta
// "Do you want to ...?" y una lista de opciones donde la 1a ("Yes") aparece
// resaltada con "❯". En modo -p/--print no hay estos prompts; alli usa los flags
// nativos --permission-mode acceptEdits o --dangerously-skip-permissions.
const CONFIRM_PATTERNS = [
  /Do you want to (proceed|make this edit|create|run|allow|continue)\b/i,
  /❯\s*1\.\s*Yes\b/, // selector con la opcion por defecto ("Yes") resaltada
];

function isConfirmPrompt(text) {
  return CONFIRM_PATTERNS.some((re) => re.test(text));
}

// --- Parseo de la hora de reinicio ----------------------------------------
// Soporta: "resets at 3pm", "reset at 15:00", "try again at 4:30 PM",
//          "reset in 2 hours", "try again in 45 minutes".
function parseResetMs(text) {
  // 1) "in X hours / minutes"
  let m = text.match(/(?:reset|try again)\D{0,20}?in\s+(\d+)\s*(hour|hr|minute|min)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith('h') ? n * 3600e3 : n * 60e3;
    return ms;
  }
  // 2) "at 3pm" / "at 15:00" / "at 4:30 PM"
  m = text.match(/(?:reset|try again)\D{0,20}?at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1); // ya paso -> manana
    return target.getTime() - now.getTime();
  }
  return null; // no se pudo parsear
}

function calculateWaitMs(text) {
  const parsed = parseResetMs(text);
  if (parsed != null && parsed > 0) return parsed + CFG.marginSeconds * 1000;
  return CFG.fallbackHours * 3600e3; // fallback
}

// --- Lanzar claude con streaming en vivo ----------------------------------
// La salida se reenvia a la terminal en cuanto llega (para no romper el modo
// interactivo ni ocultar preguntas de aclaracion), y en paralelo se escanea el
// texto acumulado EN VIVO: en cuanto aparece el patron de limite de uso se mata
// el proceso y se resuelve, sin esperar al exit. Asi el reintento se dispara
// aunque la sesion no termine por si sola.
//
// Para evitar reaccionar ante un patron partido entre dos chunks, la deteccion
// se hace sobre una ventana final (cola) del texto combinado.
const DETECT_WINDOW = 4096; // bytes de cola sobre los que se escanea en vivo
const CONFIRM_COOLDOWN_MS = 1500; // evita re-disparar el auto-confirm sobre el mismo prompt

// Despachador: elige como lanzar claude segun el modo.
//   - Modo -p/--print  -> tuberias (capturamos la salida, claude no es TUI).
//   - Modo interactivo -> pseudo-terminal (node-pty) para darle un TTY real Y a
//     la vez poder leer la salida y detectar el limite. Si node-pty no esta
//     instalado, caemos a un passthrough transparente (sin deteccion).
async function runClaude(args) {
  const interactive = !(args.includes('-p') || args.includes('--print'));
  if (!interactive) return runClaudePipe(args);

  const pty = await loadPty();
  if (pty) return runClaudePty(pty, args);

  process.stderr.write(
    '[claude-retry] node-pty no esta instalado: el modo interactivo correra SIN\n' +
      'deteccion de limite ni reintento. Para habilitarlos ejecuta: npm install\n'
  );
  return runClaudeInherit(args);
}

// Implementacion por tuberias (modo no interactivo / -p).
function runClaudePipe(args) {
  return new Promise((resolve) => {
    const child = spawnClaude(args, [stdinModeFor(args), 'pipe', 'pipe']);
    const out = [];
    const err = [];
    let combined = ''; // texto acumulado (ambos streams) para deteccion en vivo
    let settled = false; // evita resolver dos veces (deteccion en vivo + exit/kill)

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Acumula el chunk, lo reenvia en vivo y dispara el reintento si detecta limite.
    const onChunk = (stream, store) => (d) => {
      stream.write(d); // streaming en vivo
      store.push(d); // acumula para el resultado final
      combined += d.toString();
      if (combined.length > DETECT_WINDOW) combined = combined.slice(-DETECT_WINDOW);
      if (isRateLimited(combined)) {
        killTree(child); // corta la sesion (y su arbol) para poder reintentar
        settle({
          code: 1,
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
          rateLimited: true,
        });
      }
    };

    child.stdout.on('data', onChunk(process.stdout, out));
    child.stderr.on('data', onChunk(process.stderr, err));
    child.on('error', (e) => settle({ code: 1, stdout: '', stderr: String(e.message) }));
    child.on('exit', (code) =>
      settle({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      })
    );
  });
}

// Carga node-pty de forma perezosa y tolerante: si no esta instalado, devuelve
// null en vez de lanzar, para que el wrapper siga funcionando sin el.
let _ptyModule;
async function loadPty() {
  if (_ptyModule !== undefined) return _ptyModule;
  try {
    const mod = await import('node-pty');
    _ptyModule = mod.default ?? mod;
  } catch {
    _ptyModule = null;
  }
  return _ptyModule;
}

// Implementacion interactiva con pseudo-terminal (node-pty).
// claude recibe un TTY real (puede dibujar su interfaz), y nosotros leemos lo que
// pasa por el PTY para reenviarlo a la pantalla y escanear el limite en vivo. El
// teclado del usuario se reenvia al PTY en modo raw.
function runClaudePty(pty, args) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // En Windows claude es un .cmd: hay que invocarlo a traves de cmd.exe.
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : CFG.claudeBin;
    const spawnArgs = isWin ? ['/c', CFG.claudeBin, ...args] : args;

    const term = pty.spawn(file, spawnArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: process.cwd(),
      env: process.env,
      // En Windows usamos el backend winpty en vez de ConPTY: ConPTY lanza un
      // proceso auxiliar (conpty_console_list_agent) que falla con "AttachConsole"
      // al matar un proceso que ya termino, ensuciando la salida.
      useConpty: false,
    });

    let combined = '';
    let settled = false;
    let lastConfirmAt = 0; // marca temporal del ultimo auto-confirm (cooldown)

    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isTTY);
    const onStdin = (d) => term.write(d.toString('utf8'));
    const onResize = () => term.resize(process.stdout.columns || 80, process.stdout.rows || 30);

    const cleanup = () => {
      stdin.removeListener('data', onStdin);
      process.stdout.removeListener('resize', onResize);
      if (wasRaw) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignorado */
        }
      }
      stdin.pause();
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    if (wasRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onStdin);
    process.stdout.on('resize', onResize);

    term.onData((d) => {
      process.stdout.write(d); // streaming en vivo (incluye secuencias de la TUI)
      combined += d;
      if (combined.length > DETECT_WINDOW) combined = combined.slice(-DETECT_WINDOW);
      if (isRateLimited(combined)) {
        try {
          term.kill();
        } catch {
          /* ignorado */
        }
        settle({ code: 1, stdout: '', stderr: '', rateLimited: true });
        return;
      }
      // Auto-confirmacion de prompts de permiso/confirmacion (opt-in).
      // El cooldown evita re-disparar mientras el texto del prompt sigue en el buffer.
      if (
        CFG.autoConfirm &&
        Date.now() - lastConfirmAt > CONFIRM_COOLDOWN_MS &&
        isConfirmPrompt(combined)
      ) {
        term.write(CFG.autoConfirmKey);
        process.stderr.write(
          '[claude-retry] prompt de confirmacion detectado: respondido automaticamente.\n'
        );
        lastConfirmAt = Date.now();
        combined = ''; // limpia el buffer para no re-disparar sobre el mismo prompt
      }
    });
    term.onExit(({ exitCode }) => settle({ code: exitCode ?? 0, stdout: '', stderr: '' }));
  });
}

// Fallback sin node-pty: cede el control total de la terminal a claude
// (stdio heredado). El modo interactivo funciona, pero NO podemos leer la salida,
// asi que no hay deteccion de limite ni reintento en este camino.
function runClaudeInherit(args) {
  return new Promise((resolve) => {
    const child = spawnClaude(args, 'inherit');
    child.on('error', (e) => {
      process.stderr.write(`[claude-retry] Error al lanzar claude: ${e.message}\n`);
      resolve({ code: 1, stdout: '', stderr: '' });
    });
    child.on('exit', (code) => resolve({ code: code ?? 0, stdout: '', stderr: '' }));
  });
}

// --- Bucle principal ------------------------------------------------------
async function main() {
  const baseArgs = process.argv.slice(2);

  let currentArgs = baseArgs;
  let attempt = 0;
  while (true) {
    const result = await runClaude(currentArgs);
    const combined = result.stdout + '\n' + result.stderr;

    // result.rateLimited viene de la deteccion en vivo; si no, se escanea el total.
    if (!result.rateLimited && !isRateLimited(combined)) {
      // La salida ya se imprimio en vivo durante el streaming.
      process.exit(result.code);
    }

    attempt++;
    if (attempt > CFG.maxRetries) {
      process.stderr.write(`[claude-retry] Maximo de reintentos (${CFG.maxRetries}) alcanzado.\n`);
      process.exit(1);
    }

    // En los reintentos tras el limite, retomamos la conversacion en vez de
    // reiniciarla (si esta habilitado), para no perder el contexto.
    currentArgs = retryArgs(baseArgs);

    const waitMs = calculateWaitMs(combined);
    const when = new Date(Date.now() + waitMs).toLocaleTimeString();
    process.stderr.write(
      `[claude-retry] Limite de uso detectado. Esperando ${Math.round(waitMs / 1000)}s ` +
        `(reintento ${attempt}/${CFG.maxRetries} ~ ${when})...\n`
    );
    await sleep(waitMs);
  }
}

// Construye los argumentos del reintento. Con CR_CONTINUE_ON_RETRY, anade
// --continue para que claude retome la ultima conversacion del directorio en
// vez de empezar de cero (salvo que ya se haya pasado --continue/--resume).
function retryArgs(args) {
  if (!CFG.continueOnRetry) return args;
  const resume = ['--continue', '-c', '--resume', '-r'];
  if (args.some((a) => resume.includes(a))) return args;
  return [...args, '--continue'];
}

// --- utilidades -----------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function num(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
}
// Interpreta el valor de CR_AUTO_CONFIRM_KEY. Acepta alias ("enter") o un literal
// ("1", "y") que se envia tal cual al PTY. En la TUI de claude pulsar el numero de
// una opcion la selecciona y confirma; Enter confirma la opcion por defecto ("Yes").
function parseKey(v, d) {
  if (v == null || v === '') return d;
  const lower = v.toLowerCase();
  if (lower === 'enter' || lower === 'return' || lower === 'cr') return '\r';
  return v;
}
function resolveClaudeBin() {
  // En Windows el binario suele ser claude.cmd; spawn con shell:true lo resuelve por PATH.
  return 'claude';
}
// Entrecomilla un argumento para la linea de comando del shell de Windows.
// Sin esto, los valores con espacios (p. ej. -p "varias palabras") se parten en
// tokens y claude solo recibe la primera palabra.
function quoteArg(a) {
  if (a === '') return '""';
  if (/[\s"&|<>^()%!]/.test(a)) {
    return '"' + a.replace(/"/g, '\\"') + '"';
  }
  return a;
}

// Decide que hacer con el stdin del proceso hijo.
// En modo -p/--print claude no necesita entrada interactiva; si ademas stdin es
// una TTY (no hay datos canalizados), lo ignoramos para que claude no espere ~3s
// por entrada. Si stdin es un pipe (no TTY) lo dejamos pasar por si se estan
// canalizando datos, p. ej. `type archivo | claude-retry -p "..."`.
function stdinModeFor(args) {
  const printMode = args.includes('-p') || args.includes('--print');
  if (printMode && process.stdin.isTTY) return 'ignore';
  return 'inherit';
}

// Lanza el proceso claude de forma portable.
// En Windows pasamos UNA sola linea de comando ya entrecomillada con shell:true
// (necesario para resolver claude.cmd). Al NO pasar un array de args junto a
// shell:true evitamos el DeprecationWarning DEP0190. En el resto de plataformas
// usamos spawn sin shell con el array de args tal cual.
function spawnClaude(args, stdio) {
  if (process.platform === 'win32') {
    const cmdline = [quoteArg(CFG.claudeBin), ...args.map(quoteArg)].join(' ');
    return spawn(cmdline, { stdio, shell: true });
  }
  return spawn(CFG.claudeBin, args, { stdio, shell: false });
}
// Mata el proceso hijo Y todos sus descendientes.
// En Windows, con shell:true, child.kill() solo mata el cmd que lo lanzo y deja
// a claude (y a sus hijos) huerfanos; taskkill /T /F mata el arbol completo.
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Si taskkill falla (p. ej. el proceso ya murio), intentamos el kill normal.
      try {
        child.kill();
      } catch {
        /* ignorado */
      }
    });
  } else {
    child.kill();
  }
}

main();
