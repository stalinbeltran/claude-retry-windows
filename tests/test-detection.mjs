#!/usr/bin/env node
// Test de la deteccion de limite de uso. Ejecuta:  node tests/test-detection.mjs
// Cubre el caso real que fallo y un abanico de variantes + casos negativos
// (texto normal que NO debe disparar el reintento).

import { isRateLimited, rateLimitConfidence, parseResetMs } from '../claude-retry.mjs';

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

console.log('--- Casos POSITIVOS (deben detectarse como limite) ---');
const positives = [
  // El caso REAL que fallo en modo interactivo:
  "You've hit your session limit · resets 12:30pm (America/Panama)\n/upgrade to increase your usage limit.",
  'Claude usage limit reached. Your limit will reset at 3pm (America/New_York).',
  '5-hour limit reached ∙ resets 9am',
  "You've reached your usage limit.",
  'Weekly limit reached. Try again in 2 hours.',
  'You have hit your account limit. resets 15:00 (Europe/Madrid)',
  '{"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
  'HTTP 429 Too Many Requests',
  'Too many requests (429)',
  'Daily limit reached · resets 6:00am',
  'You exceeded your message limit for this plan. /upgrade to increase your usage limit.',
];
for (const t of positives) {
  check(JSON.stringify(t.slice(0, 55)), isRateLimited(t));
}

console.log('\n--- Casos NEGATIVOS (NO deben detectarse) ---');
const negatives = [
  'Here is a summary of the rate limit concepts you asked about.',
  'The function returns 429 as an arbitrary status code in this example.',
  'I will explain how usage limits work in general, conceptually.',
  'Your session was saved successfully. Reset the form to continue.',
  'This is a normal Claude response about quotas in mathematics.',
];
for (const t of negatives) {
  check(JSON.stringify(t.slice(0, 55)), !isRateLimited(t));
}

console.log('\n--- Parseo de hora de reinicio ---');
const r1 = parseResetMs('resets 12:30pm (America/Panama)');
check('resets 12:30pm con TZ -> valor positivo', r1 != null && r1 > 0);
const r2 = parseResetMs('Your limit will reset at 3pm');
check('reset at 3pm -> valor positivo', r2 != null && r2 > 0);
const r3 = parseResetMs('try again in 45 minutes');
check('in 45 minutes ~ 45min', r3 != null && Math.abs(r3 - 45 * 60e3) < 1000);
const r4 = parseResetMs('reset at 15:00');
check('reset at 15:00 (24h) -> valor positivo', r4 != null && r4 > 0);

console.log('\n--- Confianza estadistica (informativo) ---');
for (const t of positives.slice(0, 4)) {
  const { score, matched } = rateLimitConfidence(t);
  console.log(`  ${score.toFixed(2)}  ${JSON.stringify(t.slice(0, 45))}  [${matched.join(', ')}]`);
}

console.log(`\nRESULTADO: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
