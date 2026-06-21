#!/usr/bin/env node
// Test de los helpers del modo multi-turno (-a). Ejecuta: node tests/test-multiturn.mjs
// Cubre el parseo de -a, la reconstruccion del comando de respuesta (reusando flags y
// anadiendo --continue) y la heuristica de "esto parece una pregunta".

import {
  extractAnswer,
  stripPrompt,
  stripContinueFlags,
  buildAnswerArgs,
  looksLikeQuestion,
} from '../claude-retry.mjs';

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('--- extractAnswer ---');
check('-a "texto" -> isAnswer + text', eq(extractAnswer(['-a', 'usa JWT']), { isAnswer: true, text: 'usa JWT', rest: [] }));
check('--answer=texto', eq(extractAnswer(['--answer=hola']), { isAnswer: true, text: 'hola', rest: [] }));
check('-a con flags extra van a rest', eq(extractAnswer(['-a', 'x', '--model', 'opus']), { isAnswer: true, text: 'x', rest: ['--model', 'opus'] }));
check('sin -a -> isAnswer false, todo a rest', eq(extractAnswer(['-p', 'tarea']), { isAnswer: false, text: '', rest: ['-p', 'tarea'] }));
check('-a sin valor -> text vacio', extractAnswer(['-a']).isAnswer === true && extractAnswer(['-a']).text === '');

console.log('\n--- stripPrompt / stripContinueFlags ---');
check('quita -p y su valor', eq(stripPrompt(['-p', 'hola', '--permission-mode', 'acceptEdits']), ['--permission-mode', 'acceptEdits']));
check('quita --print y su valor', eq(stripPrompt(['--print', 'hola', '--model', 'opus']), ['--model', 'opus']));
check('quita --continue', eq(stripContinueFlags(['-p', 'x', '--continue']), ['-p', 'x']));
check('quita --resume y su id', eq(stripContinueFlags(['--resume', 'abc123', '--model', 'opus']), ['--model', 'opus']));

console.log('\n--- buildAnswerArgs ---');
check('reusa flags + anade -p respuesta + --continue', eq(buildAnswerArgs(['--permission-mode', 'acceptEdits'], 'usa JWT'), ['--permission-mode', 'acceptEdits', '-p', 'usa JWT', '--continue']));
check('no duplica --continue si ya estaba', eq(buildAnswerArgs(['--continue', '--model', 'opus'], 'si'), ['--model', 'opus', '-p', 'si', '--continue']));
check('quita el prompt viejo antes de anadir el nuevo', eq(buildAnswerArgs(['-p', 'viejo', '--model', 'opus'], 'nuevo'), ['--model', 'opus', '-p', 'nuevo', '--continue']));

console.log('\n--- looksLikeQuestion: POSITIVOS ---');
const q = [
  'Listo. ¿Uso JWT o cookies?',
  'Which option do you prefer?',
  'Puedo hacerlo de dos formas:\n1) JWT\n2) Cookies de sesion',
  'I can do that. Should I proceed with the migration?',
  'Dime cual prefieres antes de seguir.',
];
for (const t of q) check(JSON.stringify(t.slice(0, 45)), looksLikeQuestion(t));

console.log('\n--- looksLikeQuestion: NEGATIVOS ---');
const nq = [
  'Tarea completada con exito. TODO OK.',
  'He creado el archivo app.py con el servidor.',
  'El resultado es 429 como codigo de ejemplo.',
];
for (const t of nq) check(JSON.stringify(t.slice(0, 45)), !looksLikeQuestion(t));

console.log(`\nRESULTADO MULTI-TURNO: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
