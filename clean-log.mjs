#!/usr/bin/env node
// clean-log — convierte un transcript en bruto (CR_TRANSCRIPT) en texto legible.
//
// El transcript que genera claude-retry en modo interactivo guarda los bytes TAL
// CUAL salen del PTY: una "pelicula" de la pantalla llena de codigos ANSI y ordenes
// de movimiento de cursor (subir lineas, borrar, repintar el spinner...). Leerlo en
// crudo es imposible. Este script alimenta esos bytes a un emulador de terminal real
// (@xterm/headless, el mismo motor de VS Code), deja que aplique todos los repintados
// y luego extrae el TEXTO FINAL que quedaria en pantalla (incluido el scrollback).
//
// Ademas corrige dos defectos tipicos de la captura con winpty en Windows:
//   - "mojibake": UTF-8 reinterpretado como Windows-1252 (→ sale como "â†'", "segÃºn").
//   - duplicados: el repintado en vivo deja copias de las mismas lineas en el
//     scrollback; se colapsan con una de-duplicacion por ventana.
//
// Uso:
//   node clean-log.mjs session.log                 -> imprime el texto limpio
//   node clean-log.mjs session.log session.txt     -> lo guarda en un archivo
//   node clean-log.mjs session.log --cols 160       -> ajusta el ancho del render
//
// Opciones:
//   --cols N      ancho de la terminal virtual (def 200; alto = respeta los saltos de
//                 linea originales de claude sin re-ajustar el texto a otro ancho)
//   --rows N      alto de la terminal virtual (def 30; debe parecerse al alto real del
//                 terminal al capturar para que el historial pase bien al scrollback)
//   --no-dedup    no colapsar las lineas repetidas por el repintado en vivo
//   --no-fix-enc  no intentar reparar el mojibake (UTF-8 leido como Windows-1252)
//   --raw-tail    no recortar el contenido tras el ultimo borrado de pantalla final
//                 (por defecto se descarta, p. ej. el mensaje "Resume this session...")

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// @xterm/headless se publica como CommonJS: importamos el default y extraemos Terminal.
import xterm from '@xterm/headless';
const { Terminal } = xterm;

function parseArgs(argv) {
  const opts = {
    cols: 200, rows: 30, input: null, output: null,
    dedup: true, fixEnc: true, trimTail: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cols') opts.cols = parseInt(argv[++i], 10) || opts.cols;
    else if (a === '--rows') opts.rows = parseInt(argv[++i], 10) || opts.rows;
    else if (a === '--no-dedup') opts.dedup = false;
    else if (a === '--no-fix-enc') opts.fixEnc = false;
    else if (a === '--raw-tail') opts.trimTail = false;
    else if (!opts.input) opts.input = a;
    else if (!opts.output) opts.output = a;
  }
  return opts;
}

// Una pantalla completa que se borra al final (ESC[2J / ESC[3J) suele ser el adios
// del CLI ("Resume this session with: claude --resume ..."), que ademas se lleva por
// delante la conversacion del viewport. Si tras el ultimo borrado queda poco texto,
// lo recortamos para conservar el ultimo frame real de la conversacion.
function trimTrailingClear(data) {
  const idx = Math.max(data.lastIndexOf('\x1b[2J'), data.lastIndexOf('\x1b[3J'));
  if (idx < 0) return data;
  const tail = data.length - idx;
  // Solo recorta si lo que sigue es una cola pequena (no media sesion tras un /clear).
  if (tail < 2000) return data.slice(0, idx);
  return data;
}

// Lee el buffer activo del emulador como texto. Con onlyViewport=true devuelve solo
// las ultimas `rows` lineas (lo que se ve en pantalla); si no, devuelve scrollback +
// viewport completo. translateToString(true) recorta el relleno de espacios del final.
function readBuffer(term, rows, onlyViewport) {
  const buf = term.buffer.active;
  const start = onlyViewport ? Math.max(0, buf.length - rows) : 0;
  const lines = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n');
}

// Frontera de "frame": secuencias con las que la TUI vuelve arriba para REPINTAR la
// region visible — cursor-up (\x1b[<N>A), home (\x1b[H / \x1b[1;1H) o borrado total
// (\x1b[2J). Conservamos el delimitador al inicio de cada segmento para no perder bytes.
const FRAME_BOUNDARY = /(\x1b\[\d{0,3}A|\x1b\[H|\x1b\[1;1H|\x1b\[2J)/;

// Renderiza el transcript a texto reconstruyendo TODA la conversacion.
//
// Problema: la TUI de claude no hace scroll real; repinta su region "en el sitio"
// subiendo el cursor (\x1b[<N>A) y reescribiendo cada linea. Por eso el emulador
// nunca manda el historial al scrollback: cada frame sobreescribe al anterior y, al
// final, el buffer solo contiene el ULTIMO frame visible (la ultima parte de la
// conversacion). Leer solo el buffer final pierde todo lo anterior.
//
// Solucion: alimentamos los bytes a un solo emulador persistente, pero partimos el
// stream en sus frames y, tras aplicar cada uno, tomamos un snapshot del viewport
// ANTES de que el siguiente lo sobreescriba. Concatenando los snapshots en orden
// (mas un volcado final del buffer completo, por si hubo scroll real) y dejando que
// la de-duplicacion colapse las lineas repetidas entre frames, se reconstruye la
// conversacion entera, no solo lo ultimo visible.
function renderToText(data, { cols, rows }) {
  const term = new Terminal({
    cols,
    rows,
    // Scrollback enorme: conserva el historial que SI llegue a desplazarse de verdad.
    scrollback: 100000,
    allowProposedApi: true,
    logLevel: 'off', // silencia los "Parsing error" del parser ante secuencias raras
  });

  // Parte el stream conservando los delimitadores (split con grupo de captura los
  // intercala) y descarta los segmentos vacios.
  const parts = data.split(FRAME_BOUNDARY).filter((s) => s.length);
  const writeChunk = (chunk) => new Promise((res) => term.write(chunk, res));

  return (async () => {
    const snapshots = [];
    for (const part of parts) {
      await writeChunk(part);
      // Tras cerrar un frame (el segmento empieza con una frontera), captura el
      // viewport actual: son las lineas a punto de ser repintadas por el siguiente.
      if (FRAME_BOUNDARY.test(part)) snapshots.push(readBuffer(term, rows, true));
    }
    // Volcado final completo (incluye cualquier scrollback real acumulado).
    snapshots.push(readBuffer(term, rows, false));
    return snapshots.join('\n');
  })();
}

// --- Reparacion de mojibake (UTF-8 leido como Windows-1252) ----------------
// winpty entrega los bytes UTF-8 de claude reinterpretados byte a byte como cp1252
// y al guardarlos se re-codifican en UTF-8, produciendo "â†'" donde iba "→". Para
// revertirlo mapeamos cada caracter de vuelta a su byte cp1252 y decodificamos UTF-8.
const CP1252 = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F };

function unmojibake(s) {
  let out = '';
  let bytes = [];
  const flush = () => {
    if (bytes.length) { out += Buffer.from(bytes).toString('utf8'); bytes = []; }
  };
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xFF) bytes.push(cp);
    else if (CP1252[cp] != null) bytes.push(CP1252[cp]);
    else { flush(); out += ch; } // caracter no-cp1252 (no era mojibake): se respeta
  }
  flush();
  return out;
}

// Solo reparamos si el texto REALMENTE parece mojibake: aplicar la reversion a texto
// correcto lo estropearia. Buscamos las firmas tipicas (Ã, â€, â”, Â) con densidad.
function looksMojibake(s) {
  const m = s.match(/Ã.|â€|â”|â–|â•|Â./g);
  return m && m.length > 20;
}

// --- De-duplicacion de lineas repetidas por el repintado en vivo -----------
// Mientras claude transmite la respuesta, la TUI repinta y hace scroll, dejando
// copias de las mismas lineas ya completadas en el scrollback. Colapsamos una linea
// si su texto ya aparecio entre las ultimas WINDOW lineas no vacias emitidas. Las
// lineas cortas (separadores, numeracion) se dejan pasar para no perder estructura.
function dedup(text, { window = 400, minLen = 12 } = {}) {
  const out = [];
  const recent = []; // cola de las ultimas lineas largas emitidas
  const recentSet = new Map(); // texto -> conteo en la ventana
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length >= minLen) {
      if (recentSet.get(t)) continue; // ya visto en la ventana: es un repintado
      recent.push(t);
      recentSet.set(t, 1);
      if (recent.length > window) {
        const old = recent.shift();
        recentSet.delete(old);
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

// Colapsa rachas de 3+ lineas en blanco a una sola y recorta el blanco de los bordes.
function tidy(text) {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    process.stderr.write(
      'Uso: node clean-log.mjs <transcript> [salida.txt] [--cols N] [--rows N] ' +
        '[--no-dedup] [--no-fix-enc] [--raw-tail]\n'
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(opts.input, 'utf8');
  } catch (e) {
    process.stderr.write(`No se pudo leer ${opts.input}: ${e.message}\n`);
    process.exit(1);
  }

  if (opts.trimTail) raw = trimTrailingClear(raw);
  let text = await renderToText(raw, opts);
  if (opts.fixEnc && looksMojibake(text)) text = unmojibake(text);
  if (opts.dedup) text = dedup(text);
  text = tidy(text);

  if (opts.output) {
    writeFileSync(opts.output, text, 'utf8');
    process.stderr.write(`Texto legible escrito en ${opts.output}\n`);
  } else {
    process.stdout.write(text);
  }
}

// Exporta las piezas para poder probarlas de forma aislada (p. ej. la reconstruccion
// de la conversacion completa a partir de un transcript que repinta en el sitio).
export { renderToText, dedup, tidy, unmojibake, looksMojibake, trimTrailingClear };

// Solo ejecuta el CLI cuando el script se invoca directamente (no al importarlo en un test).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
