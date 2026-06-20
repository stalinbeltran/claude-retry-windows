// claude FALSO con VARIANTES de mensaje de limite, para probar claude-retry
// end-to-end sin gastar cuota real.
//
// La variante se elige con la variable de entorno FAKE_VARIANT (ver VARIANTS).
//   - 1er intento -> imprime el banner de limite de la variante y sale con codigo 1.
//   - 2do intento en adelante -> responde con exito y sale con 0.
// El contador se guarda por-variante para que cada prueba sea independiente.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Cada variante simula un banner real distinto. Las 4 primeras casan con patrones
// definitivos; "novel" NO casa con ninguno y obliga a la deteccion ESTADISTICA.
const VARIANTS = {
  // El caso REAL que fallaba (sesion interactiva, con zona horaria sin "at").
  real: "You've hit your session limit · resets 12:30pm (America/Panama)\n/upgrade to increase your usage limit.",
  usage: 'Claude usage limit reached. Your limit will reset at 3pm (America/New_York).',
  fivehour: '5-hour limit reached ∙ resets 9am',
  weekly: 'Weekly limit reached. Try again in 2 hours.',
  // Frase NO catalogada: ningun patron definitivo la describe; debe detectarse por
  // la suma de senales (out-of-messages + resets+hora).
  novel: "You're temporarily out of messages. Your access resets at 18:30 (Europe/Madrid).",
  // Sin hora -> fuerza el fallback (util para la prueba de bucle completo rapido).
  notime: 'Usage limit reached. Please try again later.',
};

const variant = process.env.FAKE_VARIANT || 'real';
const message = VARIANTS[variant] || VARIANTS.real;

const here = dirname(fileURLToPath(import.meta.url));
const counterFile = join(here, `.rl-counter-${variant}`);

let n = 0;
if (existsSync(counterFile)) n = parseInt(readFileSync(counterFile, 'utf8'), 10) || 0;
n += 1;
writeFileSync(counterFile, String(n), 'utf8');

if (n === 1) {
  console.log(`[fake-claude:${variant}] intento ${n}:`);
  console.log(message);
  process.exit(1);
} else {
  console.log(`[fake-claude:${variant}] intento ${n}: trabajo completado con exito. TODO OK.`);
  process.exit(0);
}
