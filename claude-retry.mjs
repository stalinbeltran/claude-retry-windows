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
//   CR_AUTO_CONFIRM       (def on)    auto-responde prompts de confirmacion (modo interactivo); CR_AUTO_CONFIRM=0 lo apaga
//   CR_AUTO_CONFIRM_KEY   (def Enter) tecla a enviar al auto-confirmar ("enter", "1", "y"...)
//   CR_CONTINUE_ON_RETRY  (def off)   anade --continue al reintentar tras el limite
//   CR_TRANSCRIPT         (def off)   ruta de archivo donde volcar TODA la salida
//                                     (util para revisar la sesion completa cuando el
//                                     scrollback del terminal no conserva el texto que
//                                     se desborda; p. ej. con winpty en VSCode)
//   CR_DETECTION_PRECISION (def 70)   precision requerida (0-100, o 0-1) para la
//                                     deteccion ESTADISTICA de limites no catalogados.
//                                     Es el umbral de confianza minimo para disparar el
//                                     reintento por puntuacion ponderada. Mas alto = mas
//                                     estricto (menos falsos positivos, puede perder
//                                     variantes debiles); mas bajo = mas sensible.
//   CR_DETECT_DEBUG       (def off)   imprime en stderr la puntuacion y las senales que
//                                     casaron en cada deteccion (para ajustar la precision)

import { spawn, execFile } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Carga variables desde un archivo .env (en el cwd) sin dependencias externas.
// No sobreescribe variables ya presentes en el entorno. Permite configurar p. ej.
// CR_DETECTION_PRECISION=85 sin tener que exportarla a mano en cada sesion.
function loadDotEnv() {
  let txt;
  try {
    txt = readFileSync('.env', 'utf8');
  } catch {
    return; // no hay .env: nada que cargar
  }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const CFG = {
  maxRetries: int(process.env.CR_MAX_RETRIES, 5),
  marginSeconds: int(process.env.CR_MARGIN_SECONDS, 30),
  fallbackHours: num(process.env.CR_FALLBACK_HOURS, 5),
  claudeBin: process.env.CR_CLAUDE_BIN || resolveClaudeBin(),
  autoConfirm: bool(process.env.CR_AUTO_CONFIRM, true),
  autoConfirmKey: parseKey(process.env.CR_AUTO_CONFIRM_KEY, '\r'),
  continueOnRetry: bool(process.env.CR_CONTINUE_ON_RETRY, false),
  transcript: process.env.CR_TRANSCRIPT || '',
  detectionPrecision: parsePrecision(process.env.CR_DETECTION_PRECISION, 0.7),
  detectDebug: bool(process.env.CR_DETECT_DEBUG, false),
};

// --- Transcripcion a archivo (opcional) -----------------------------------
// Cuando CR_TRANSCRIPT apunta a un archivo, recogemos TODO lo que claude envia a
// la pantalla (en modo -p y en modo interactivo, incluyendo los reintentos tras
// el limite) y lo escribimos en bruto. Esto permite revisar la sesion completa
// aunque la TUI redibuje en vivo y el scrollback del terminal pierda el texto que
// se desborda (caso tipico de winpty en el terminal de VSCode). El stream se abre
// una sola vez por invocacion (trunca al inicio y va acumulando los reintentos).
let _transcript;
function writeTranscript(data) {
  if (!CFG.transcript) return;
  if (_transcript === undefined) {
    try {
      _transcript = createWriteStream(CFG.transcript, { flags: 'w' });
      _transcript.write(`# claude-retry transcript — ${new Date().toISOString()}\n`);
    } catch (e) {
      process.stderr.write(`[claude-retry] no se pudo abrir el transcript: ${e.message}\n`);
      _transcript = null; // marca el fallo para no reintentar abrirlo en cada chunk
    }
  }
  if (_transcript) _transcript.write(data);
}

// --- Deteccion de limite de uso -------------------------------------------
// IMPORTANTE: estos patrones se escanean sobre TODA la salida de claude, incluido
// el texto normal de la conversacion. La deteccion tiene DOS capas:
//
//   1) PATRONES DEFINITIVOS (STRONG_PATTERNS): frases inequivocas del banner de
//      error real del CLI/API. Si cualquiera casa -> limite, sin mas analisis.
//
//   2) DETECCION ESTADISTICA (rateLimitConfidence): para variantes NO catalogadas,
//      suma pesos de muchas "senales" parciales y obtiene una confianza 0..1. Si la
//      confianza alcanza el umbral CR_DETECTION_PRECISION -> limite. Asi una frase
//      nueva como "You've hit your session limit · resets 12:30pm" se detecta por la
//      combinacion de senales (hit your limit + session limit + resets+hora + upgrade)
//      aunque ningun patron definitivo la describa palabra por palabra.
//
// Subir la precision = exigir mas evidencia (menos falsos positivos). Bajarla = mas
// sensible (capta variantes mas debiles, con mas riesgo de falso positivo).

// Capa 1: frases definitivas. Cubren todas las variantes conocidas del limite,
// tanto de la suscripcion (session/usage/weekly/5-hour) como de la API (429).
const STRONG_PATTERNS = [
  /usage limit reached/i, // "Claude usage limit reached. Your limit will reset at ..."
  /claude usage limit/i, // banner clasico de suscripcion
  /\b\d+\s*-?\s*hour limit reached/i, // "5-hour limit reached ∙ resets ..."
  /\b(?:session|weekly|daily|account|message|opus|plan)\s+limit\s+reached/i,
  /you'?ve\s+(?:hit|reached|used up|exceeded)\s+your\b[^.\n]{0,40}\blimit/i, // "You've hit your session limit"
  /\b(?:hit|reached|exceeded)\s+your\s+(?:session|usage|weekly|daily|account|message|plan)\s+limit/i,
  /your\s+limit\s+will\s+reset/i, // "Your limit will reset at ..."
  /upgrade\s+to\s+increase\s+your\s+usage\s+limit/i, // pie del banner de limite
  /rate_limit_error/i, // tipo de error en el JSON del 429 de la API
  /\b429\b[^\n]*too many requests/i, // linea explicita de HTTP 429
  /too many requests[^\n]*\b429\b/i,
];

// Capa 2: senales ponderadas para deteccion estadistica de variantes nuevas.
// Cada senal aporta su peso a la confianza (que se satura en 1.0). Los pesos estan
// calibrados para que una sola senal ambigua ("rate limit" suelto en una respuesta
// normal) NO alcance el umbral por defecto, pero la combinacion de varias (el patron
// real de un banner de limite) lo supere con holgura.
const WEIGHTED_SIGNALS = [
  { name: 'limit-reached', weight: 0.6, re: /\blimit\s+reached\b/i },
  { name: 'limit-will-reset', weight: 0.7, re: /\blimit\b[^.\n]{0,30}\breset/i },
  { name: 'session-limit', weight: 0.55, re: /\bsession\s+limit\b/i },
  { name: 'usage-limit', weight: 0.55, re: /\busage\s+limit\b/i },
  { name: 'rate-limit', weight: 0.45, re: /\brate[\s_-]?limit\b/i },
  { name: 'weekly-daily-limit', weight: 0.55, re: /\b(?:weekly|daily|monthly|plan|account)\s+limit\b/i },
  { name: 'hour-limit', weight: 0.6, re: /\b\d+\s*-?\s*hour\s+limit\b/i },
  { name: 'hit-reached-your', weight: 0.55, re: /\b(?:hit|reached|exceeded|used\s+up)\s+your\b[^.\n]{0,40}\blimit/i },
  { name: 'resets-at-time', weight: 0.5, re: /\breset[s]?\b[^.\n]{0,24}?\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i },
  { name: 'upgrade', weight: 0.4, re: /\/upgrade\b|\bupgrade\s+(?:to|your)\b/i },
  { name: 'too-many-requests', weight: 0.45, re: /\btoo many requests\b/i },
  { name: 'http-429', weight: 0.35, re: /\b429\b/ },
  { name: 'quota-exceeded', weight: 0.55, re: /\bquota\b[^.\n]{0,20}\b(?:exceed|reached|exhaust)/i },
  { name: 'out-of', weight: 0.4, re: /\bout of\b[^.\n]{0,20}\b(?:usage|credits?|messages?|tokens?|quota)\b/i },
  { name: 'try-again-later', weight: 0.3, re: /\btry again (?:later|in|at)\b/i },
  { name: 'come-back', weight: 0.35, re: /\b(?:come back|check back|available again)\b[^.\n]{0,20}\b(?:later|in|at|reset)/i },
  { name: 'limit-of-your-plan', weight: 0.5, re: /\blimit\b[^.\n]{0,20}\b(?:plan|subscription|tier)\b/i },
];

// Calcula la confianza estadistica (0..1) de que el texto sea un mensaje de limite,
// junto con la lista de senales que casaron (para depuracion). La confianza se satura
// en 1.0 por mas senales que sumen.
function rateLimitConfidence(text) {
  let score = 0;
  const matched = [];
  for (const sig of WEIGHTED_SIGNALS) {
    if (sig.re.test(text)) {
      score += sig.weight;
      matched.push(`${sig.name}(+${sig.weight})`);
    }
  }
  return { score: Math.min(score, 1), matched };
}

// Decision final de deteccion (capa 1 OR capa 2). Devuelve true si hay limite.
// Si CR_DETECT_DEBUG esta activo, registra por que (patron definitivo o puntuacion).
function isRateLimited(text) {
  for (const re of STRONG_PATTERNS) {
    if (re.test(text)) {
      if (CFG.detectDebug) {
        process.stderr.write(`[claude-retry][detect] patron definitivo: ${re}\n`);
      }
      return true;
    }
  }
  const { score, matched } = rateLimitConfidence(text);
  const hit = score >= CFG.detectionPrecision;
  if (CFG.detectDebug && (hit || matched.length)) {
    process.stderr.write(
      `[claude-retry][detect] confianza=${score.toFixed(2)} ` +
        `umbral=${CFG.detectionPrecision.toFixed(2)} -> ${hit ? 'LIMITE' : 'no'} ` +
        `| senales: ${matched.join(', ') || '(ninguna)'}\n`
    );
  }
  return hit;
}

// --- Deteccion de prompts de permiso/confirmacion -------------------------
// Solo aplica al modo interactivo (PTY): claude dibuja un prompt con una pregunta
// "Do you want to ...?" y una lista de opciones donde la 1a ("Yes") aparece
// resaltada con "❯". En modo -p/--print no hay estos prompts; alli usa los flags
// nativos --permission-mode acceptEdits o --dangerously-skip-permissions.
const CONFIRM_PATTERNS = [
  /Do you want to\b/i, // "Do you want to create/proceed/run/make this edit ...?"
  /❯\s*1\.\s*Yes\b/i, // selector con la opcion por defecto ("Yes") resaltada
];

// Elimina secuencias de escape ANSI (colores y movimiento de cursor). La TUI de
// claude intercala estos codigos dentro del texto del prompt; si no los quitamos,
// patrones como /Do you want to/ pueden no casar.
const ANSI_RE =
  /[][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|[A-Za-z])/g;
function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

function isConfirmPrompt(text) {
  const clean = stripAnsi(text);
  return CONFIRM_PATTERNS.some((re) => re.test(clean));
}

// --- Parseo de la hora de reinicio ----------------------------------------
// Soporta:
//   "resets at 3pm", "reset at 15:00", "try again at 4:30 PM"   (con "at")
//   "resets 12:30pm", "resets 3pm (America/Panama)"             (sin "at" + TZ)
//   "reset in 2 hours", "try again in 45 minutes"               (duracion relativa)
// Si el banner trae una zona horaria IANA entre parentesis (p. ej. "(America/Panama)")
// la hora se interpreta EN ESA ZONA y se convierte al instante real, para no esperar
// de mas/menos cuando la maquina esta en otro huso.
function parseResetMs(text) {
  // 1) "in X hours / minutes"
  let m = text.match(
    /(?:reset[s]?|try again|expires?|available again)\D{0,24}?in\s+(\d+)\s*(hour|hr|minute|min)/i
  );
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    return unit.startsWith('h') ? n * 3600e3 : n * 60e3;
  }

  // Zona horaria opcional: "(America/Panama)", "(Europe/Madrid)", etc.
  const tzMatch = text.match(/\(([A-Za-z]+(?:\/[A-Za-z_]+)+)\)/);
  const tz = tzMatch ? tzMatch[1] : null;

  // 2) hora absoluta. Aceptamos "at"/"by" opcionales; cuando NO hay "at" exigimos
  //    am/pm o minutos (HH:MM) para no confundir con cualquier numero suelto.
  //    a) con am/pm:  "resets 12:30pm", "reset at 3 PM"
  m = text.match(
    /(?:reset[s]?|try again|expires?|available again)\b[^0-9\n]{0,24}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
  );
  //    b) 24h con minutos: "reset at 15:00", "resets 09:30"
  if (!m) {
    m = text.match(
      /(?:reset[s]?|try again|expires?|available again)\b[^0-9\n]{0,24}?(\d{1,2}):(\d{2})\b/i
    );
    if (m) m = [m[0], m[1], m[2], undefined]; // normaliza a [full, hh, mm, ap]
  }
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null; // hora invalida -> fallback

    if (tz) {
      const ms = zonedFutureMs(hour, minute, tz);
      if (ms != null) return ms;
      // TZ no soportada por el runtime: caemos a hora local.
    }
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1); // ya paso -> manana
    return target.getTime() - now.getTime();
  }
  return null; // no se pudo parsear
}

// Devuelve cuantos ms faltan para la PROXIMA ocurrencia de la hora de pared
// hour:minute en la zona horaria IANA `tz`. Devuelve null si la zona no es valida
// para el runtime (Intl no la reconoce). Refina el offset una vez para respetar DST.
function zonedFutureMs(hour, minute, tz) {
  try {
    const now = new Date();
    // Offset (ms) de la zona en un instante dado: tz_wallclock = utc + offset.
    const offsetAt = (date) => {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const p = {};
      for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
      const h = p.hour === '24' ? 0 : p.hour; // algunos runtimes devuelven 24
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +h, +p.minute, +p.second);
      return asUTC - date.getTime();
    };
    // Fecha de calendario "hoy" en la zona.
    const dp = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)) {
      dp[part.type] = part.value;
    }
    const instantFor = (y, mo, d) => {
      const wall = Date.UTC(y, mo - 1, d, hour, minute, 0);
      let off = offsetAt(new Date(wall - 0));
      let inst = wall - off;
      off = offsetAt(new Date(inst)); // refina (cruces de DST)
      return wall - off;
    };
    let inst = instantFor(+dp.year, +dp.month, +dp.day);
    if (inst <= now.getTime()) {
      // Ya paso hoy en esa zona: usa el dia siguiente (en la zona).
      const tomorrow = new Date(now.getTime() + 24 * 3600e3);
      const tp = {};
      for (const part of new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(tomorrow)) {
        tp[part.type] = part.value;
      }
      inst = instantFor(+tp.year, +tp.month, +tp.day);
    }
    return inst - now.getTime();
  } catch {
    return null; // zona no reconocida
  }
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
      writeTranscript(d); // copia a archivo si CR_TRANSCRIPT esta activo
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
    let confirmTimer = null; // re-chequeo programado mientras dura el cooldown

    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isTTY);
    const onStdin = (d) => term.write(d.toString('utf8'));
    const onResize = () => term.resize(process.stdout.columns || 80, process.stdout.rows || 30);

    const cleanup = () => {
      if (confirmTimer) clearTimeout(confirmTimer);
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

    // Auto-confirmacion de prompts de permiso (opt-in, ON por defecto).
    // Se llama en cada chunk del PTY. Como la deteccion es por eventos, un prompt
    // que aparece DURANTE el cooldown se quedaria sin responder (claude se queda
    // quieto, no llega mas texto, y nunca se vuelve a evaluar). Para evitarlo, si
    // hay un prompt pero seguimos en cooldown, programamos un re-chequeo para
    // cuando el cooldown termine. Tras responder limpiamos el buffer para no
    // re-disparar sobre los redibujados del mismo prompt.
    const maybeAutoConfirm = () => {
      if (settled || !CFG.autoConfirm || !isConfirmPrompt(combined)) return;
      const since = Date.now() - lastConfirmAt;
      if (since < CONFIRM_COOLDOWN_MS) {
        if (!confirmTimer) {
          confirmTimer = setTimeout(() => {
            confirmTimer = null;
            maybeAutoConfirm();
          }, CONFIRM_COOLDOWN_MS - since + 50);
        }
        return;
      }
      term.write(CFG.autoConfirmKey);
      process.stderr.write(
        '[claude-retry] prompt de confirmacion detectado: respondido automaticamente.\n'
      );
      lastConfirmAt = Date.now();
      combined = '';
    };

    if (wasRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onStdin);
    process.stdout.on('resize', onResize);

    term.onData((d) => {
      process.stdout.write(d); // streaming en vivo (incluye secuencias de la TUI)
      writeTranscript(d); // copia a archivo si CR_TRANSCRIPT esta activo
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
      maybeAutoConfirm();
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
// Interpreta CR_DETECTION_PRECISION. Acepta 0..1 (0.85) o 0..100 (85, "85%") y lo
// normaliza al rango 0..1. Valores fuera de rango se acotan; vacio/invalido -> default.
function parsePrecision(v, d) {
  if (v == null || v === '') return d;
  const n = parseFloat(String(v).replace('%', '').trim());
  if (!Number.isFinite(n)) return d;
  const frac = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, frac));
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

// Exporta las funciones de deteccion/parseo para poder probarlas de forma aislada
// (p. ej. desde un test) sin lanzar claude.
export { isRateLimited, rateLimitConfidence, parseResetMs, calculateWaitMs, parsePrecision };

// Solo arranca el bucle cuando el script se ejecuta directamente (no al importarlo
// como modulo en un test).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
