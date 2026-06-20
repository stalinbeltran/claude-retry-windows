// claude FALSO para probar claude-retry sin gastar cuota real.
// 1a invocacion -> imprime un mensaje de limite de uso y sale con codigo 1.
// 2a invocacion en adelante -> responde con exito.
// Lleva la cuenta en un archivo contador junto a este script.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const counterFile = join(here, '.rl-counter');

let n = 0;
if (existsSync(counterFile)) n = parseInt(readFileSync(counterFile, 'utf8'), 10) || 0;
n += 1;
writeFileSync(counterFile, String(n), 'utf8');

if (n === 1) {
  // Mensaje que coincide con los patrones de rate limit del wrapper.
  console.log(`[fake-claude] intento ${n}: Error 429 — usage limit reached. Please try again later.`);
  process.exit(1);
} else {
  console.log(`[fake-claude] intento ${n}: trabajo completado con exito. TODO OK.`);
  process.exit(0);
}
