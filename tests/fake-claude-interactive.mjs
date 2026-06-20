// claude FALSO INTERACTIVO para probar la verificacion anti falso positivo del
// wrapper (la maquina de estados del modo PTY). A diferencia de fake-claude.mjs
// (un solo disparo), este proceso SE MANTIENE VIVO leyendo stdin, para poder
// responder a la sonda "continue" que envia claude-retry al verificar.
//
// Escenario via FAKE_SCENARIO:
//   reallimit (def) -> imprime el banner de limite y, ante "continue", lo VUELVE a
//                      imprimir (sigue limitado). El wrapper debe confirmar limite.
//   falsepos        -> imprime texto que solo MENCIONA el limite (como al revisar
//                      este repo) y, ante "continue", responde con NORMALIDAD (sin
//                      banner) y termina. El wrapper debe descartarlo como falso
//                      positivo y dejar continuar la sesion.
//
// Uso directo:  FAKE_SCENARIO=falsepos node tests/fake-claude-interactive.mjs
// Normalmente lo lanza claude-retry via CR_CLAUDE_BIN -> fake-claude-interactive.cmd

const scenario = process.env.FAKE_SCENARIO || 'reallimit';

const BANNER = 'Claude usage limit reached. Your limit will reset at 3pm (America/New_York).';

// Salida inicial: en ambos casos el texto contiene el patron de limite (en falsepos
// solo como mencion dentro de una respuesta normal de revision).
if (scenario === 'falsepos') {
  console.log('[fake-interactive] Revisando el proyecto claude-auto-retry...');
  console.log(`[fake-interactive] El codigo cita el mensaje: "${BANNER}"`);
  console.log('[fake-interactive] (esto es solo una mencion, la sesion sigue viva)');
} else {
  console.log('[fake-interactive] ' + BANNER);
}

let answered = false;
let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.resume(); // mantiene vivo el proceso esperando la sonda
process.stdin.on('data', (chunk) => {
  buf += chunk;
  // La sonda del wrapper escribe "continue" + Enter. Detectamos la palabra.
  if (!/continue/i.test(buf)) return;
  buf = '';
  if (scenario === 'falsepos') {
    if (answered) return;
    answered = true;
    // Responde con NORMALIDAD (sin banner) y sigue vivo: deja que el wrapper
    // complete su ventana de verificacion y confirme el falso positivo.
    console.log('[fake-interactive] Claro, sigo con la revision. Todo correcto. TODO OK.');
  } else {
    // Sigue limitado: re-emite el banner ante cualquier intento.
    console.log('[fake-interactive] ' + BANNER);
  }
});
