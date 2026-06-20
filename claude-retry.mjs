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
//   CR_MAX_RETRIES      (def 5)    intentos maximos tras detectar limite
//   CR_MARGIN_SECONDS   (def 30)   segundos extra de margen tras la hora de reinicio
//   CR_FALLBACK_HOURS   (def 5)    espera si no se logra parsear la hora de reinicio
//   CR_CLAUDE_BIN       (def auto) ruta al binario de claude

import { spawn, execFile } from 'node:child_process';

const CFG = {
  maxRetries: int(process.env.CR_MAX_RETRIES, 5),
  marginSeconds: int(process.env.CR_MARGIN_SECONDS, 30),
  fallbackHours: num(process.env.CR_FALLBACK_HOURS, 5),
  claudeBin: process.env.CR_CLAUDE_BIN || resolveClaudeBin(),
};

// --- Deteccion de limite de uso -------------------------------------------
const RATE_LIMIT_PATTERNS = [
  /usage limit reached/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /you'?ve reached your.*limit/i,
  /reset[s]? (?:at|in)/i,
  /try again (?:later|at|in)/i,
];

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
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

function runClaude(args) {
  return new Promise((resolve) => {
    const child = spawn(CFG.claudeBin, quoteArgsForShell(args), {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // permite resolver claude.cmd en Windows
    });
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

// --- Bucle principal ------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('-p') && !args.includes('--print')) {
    console.error(
      '[claude-retry] Aviso: este prototipo (Nivel 1) solo maneja el modo no interactivo.\n' +
        'Anade -p "tu prompt" para que el reintento automatico funcione.\n'
    );
  }

  let attempt = 0;
  while (true) {
    const result = await runClaude(args);
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

    const waitMs = calculateWaitMs(combined);
    const when = new Date(Date.now() + waitMs).toLocaleTimeString();
    process.stderr.write(
      `[claude-retry] Limite de uso detectado. Esperando ${Math.round(waitMs / 1000)}s ` +
        `(reintento ${attempt}/${CFG.maxRetries} ~ ${when})...\n`
    );
    await sleep(waitMs);
  }
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
function resolveClaudeBin() {
  // En Windows el binario suele ser claude.cmd; spawn con shell:true lo resuelve por PATH.
  return 'claude';
}
// Con shell:true en Windows, Node concatena los argumentos SIN entrecomillarlos,
// asi que un valor con espacios (p. ej. -p "varias palabras") se parte en tokens
// y claude solo recibe la primera palabra. Aqui entrecomillamos cada argumento
// que lo necesite para preservar el prompt completo.
function quoteArgsForShell(args) {
  if (process.platform !== 'win32') return args;
  return args.map((a) => {
    if (a === '') return '""';
    if (/[\s"&|<>^()%!]/.test(a)) {
      return '"' + a.replace(/"/g, '\\"') + '"';
    }
    return a;
  });
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
