#!/usr/bin/env node
// Test E2E del bucle de reintento en modo NO interactivo (-p). Lanza el wrapper real
// (claude-retry.mjs) apuntando CR_CLAUDE_BIN al claude falso de un disparo
// (tests/fake-claude.cmd), que simula un limite en la 1a llamada y responde con exito
// en la 2a. Comprueba que el wrapper detecta el limite, espera (con CR_FALLBACK_HOURS
// minimo) y reintenta hasta completar con exito. No gasta cuota real.
//
// Ejecuta:  node tests/test-retry.mjs

import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', 'claude-retry.mjs');
const fakeCmd = join(here, 'fake-claude.cmd');
const counter = join(here, '.rl-counter');

function killTree(pid) {
  return new Promise((res) => {
    if (pid == null) return res();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => res());
    } else {
      try { process.kill(pid); } catch { /* ignorado */ }
      res();
    }
  });
}

// Lanza el wrapper en modo -p. Resuelve cuando aparece `expect` en la salida, o
// cuando el wrapper termina, o por timeout.
function runScenario({ env = {}, expect, reject, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const child = spawn('node', [wrapper, '-p', 'tarea de prueba'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CR_CLAUDE_BIN: fakeCmd,
        CR_FALLBACK_HOURS: '0.0006', // ~2s en vez de horas
        CR_TRANSCRIPT: '', // no ensuciar con archivos
        ...env,
      },
    });

    let buf = '';
    let done = false;
    const finish = async (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      await killTree(child.pid);
      resolve({ ...result, buf });
    };

    const onData = (d) => {
      buf += d.toString();
      if (reject && buf.includes(reject)) finish({ ok: false, reason: `aparecio frase prohibida: "${reject}"` });
      else if (buf.includes(expect)) finish({ ok: true });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish({ ok: false, reason: `spawn error: ${e.message}` }));
    child.on('exit', () => finish({ ok: buf.includes(expect), reason: buf.includes(expect) ? '' : 'el wrapper termino sin la frase esperada' }));

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
  });
}

const cases = [
  {
    title: 'detecta el limite en la 1a llamada y lo anuncia',
    expect: 'Limite de uso detectado',
  },
  {
    title: 'reintenta y completa con exito en la 2a llamada',
    expect: 'trabajo completado con exito',
    reject: 'Maximo de reintentos',
  },
];

(async () => {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    try { rmSync(counter, { force: true }); } catch { /* ignorado */ }
    process.stdout.write(`\n[caso] ${c.title}\n`);
    const r = await runScenario(c);
    if (r.ok) {
      pass++;
      console.log('  ok');
    } else {
      fail++;
      console.log(`  FAIL: ${r.reason}`);
      console.log('  --- salida capturada ---');
      console.log(r.buf.split('\n').map((l) => '  | ' + l).join('\n'));
    }
  }
  try { rmSync(counter, { force: true }); } catch { /* ignorado */ }
  console.log(`\nRESULTADO E2E: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})();
