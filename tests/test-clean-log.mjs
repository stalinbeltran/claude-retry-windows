#!/usr/bin/env node
// Test de clean-log: reconstruccion de la conversacion COMPLETA. Ejecuta:
//   node tests/test-clean-log.mjs
//
// Reproduce el defecto reportado: "session.txt solo presenta la ultima parte de la
// conversacion". La TUI de claude no hace scroll real; repinta su region "en el sitio"
// (sube el cursor con \x1b[<N>A / \x1b[H y reescribe las lineas), asi que el emulador
// nunca manda el historial al scrollback. Leer solo el frame final pierde todo lo
// anterior. clean-log debe capturar los frames intermedios y reconstruir el dialogo
// entero, no solo lo ultimo visible.

import { renderToText, dedup, tidy } from '../clean-log.mjs';

let pass = 0;
let fail = 0;
function check(desc, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${desc}`);
  } else {
    fail++;
    console.log(`  FAIL ${desc}`);
  }
}

const ESC = '\x1b';
const HOME = `${ESC}[H`; // cursor arriba-izquierda: la TUI vuelve aqui para repintar
const ERASE = `${ESC}[K`; // borra el resto de la linea antes de reescribirla

// Sintetiza un transcript que imita el repintado en el sitio de la TUI de claude.
// La "conversacion" son `total` lineas distintas; en pantalla solo caben `windowH`
// a la vez. Cada frame avanza una linea (scroll simulado) repintando la ventana
// completa tras volver al home. El resultado final solo muestra las ultimas
// `windowH` lineas: leer solo ese frame perderia el principio del dialogo.
function buildRepaintTranscript(lines, windowH) {
  let raw = '';
  for (let start = 0; start + windowH <= lines.length; start++) {
    raw += HOME; // frontera de frame: vuelve arriba para repintar
    for (let r = 0; r < windowH; r++) {
      raw += ERASE + lines[start + r] + '\r\n';
    }
  }
  return raw;
}

// Lineas suficientemente largas (>= minLen del dedup) y unicas para poder rastrearlas.
const convo = Array.from(
  { length: 12 },
  (_, i) => `TURNO-CONVERSACION-${String(i + 1).padStart(2, '0')} contenido unico`
);
const windowH = 5; // solo 5 de las 12 lineas caben en pantalla a la vez
const raw = buildRepaintTranscript(convo, windowH);

console.log('--- Reconstruccion de la conversacion completa ---');
const rendered = await renderToText(raw, { cols: 200, rows: windowH + 1 });
const text = tidy(dedup(rendered));

// 1) TODAS las lineas del dialogo deben estar presentes, no solo el ultimo frame.
let allPresent = true;
const missing = [];
for (const line of convo) {
  if (!text.includes(line)) {
    allPresent = false;
    missing.push(line);
  }
}
check(
  `recupera las ${convo.length} lineas (no solo las ultimas ${windowH})` +
    (missing.length ? ` — faltan: ${missing.join(', ')}` : ''),
  allPresent
);

// 2) En particular, la PRIMERA linea (la que el enfoque antiguo de "solo frame final"
//    perdia) tiene que aparecer.
check('conserva el INICIO de la conversacion (primera linea)', text.includes(convo[0]));

// 3) El orden cronologico se respeta: la primera aparece antes que la ultima.
check(
  'mantiene el orden (primera antes que la ultima)',
  text.indexOf(convo[0]) < text.indexOf(convo[convo.length - 1])
);

// 4) Sin duplicados: cada linea unica aparece una sola vez tras el dedup, pese a
//    haberse repintado en muchos frames.
let noDups = true;
for (const line of convo) {
  const n = text.split(line).length - 1;
  if (n !== 1) {
    noDups = false;
    console.log(`       "${line}" aparece ${n} veces`);
  }
}
check('el dedup colapsa los repintados (cada linea 1 sola vez)', noDups);

// 5) Guarda anti-regresion: confirma que el transcript SI ejercita el caso. El frame
//    final (lo unico que el render ingenuo conservaria) NO contiene la primera linea.
const finalFrameOnly = convo.slice(convo.length - windowH); // ultimas windowH lineas
check(
  'el caso es real: el frame final por si solo NO tiene la primera linea',
  !finalFrameOnly.includes(convo[0])
);

console.log(`\nRESULTADO: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
