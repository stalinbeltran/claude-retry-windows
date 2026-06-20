#!/usr/bin/env node
// Test E2E de la VERIFICACION anti falso positivo (modo interactivo / PTY).
// Lanza el wrapper real (claude-retry.mjs) apuntando CR_CLAUDE_BIN al claude falso
// INTERACTIVO (tests/fake-claude-interactive.cmd) y comprueba que:
//
//   1) reallimit  -> tras la sonda el banner REAPARECE -> se confirma limite real.
//   2) falsepos   -> tras la sonda claude responde normal -> se descarta (sigue).
//   3) verify-off -> con CR_VERIFY=0 se corta de inmediato (sin sonda).
//
// Requiere node-pty instalado (npm install). Ejecuta:  node tests/test-verify.mjs

import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', 'claude-retry.mjs');
const fakeCmd = join(here, 'fake-claude-interactive.cmd');

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

// Lanza el wrapper en modo interactivo (sin -p) con stdin por tuberia (no TTY: el
// wrapper no entra en raw mode). Resuelve cuando aparece `expect` en la salida, o
// cuando el wrapper termina, o por timeout. `reject`, si aparece, marca fallo.
function runScenario({ scenario, env = {}, expect, reject, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const child = spawn('node', [wrapper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CR_CLAUDE_BIN: fakeCmd,
        FAKE_SCENARIO: scenario,
        CR_AUTO_CONFIRM: '0',
        CR_VERIFY_IDLE_MS: '600',
        CR_VERIFY_WINDOW_MS: '4000',
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
      if (reject && buf.includes(reject)) finish({ ok: false, reason: `apareció frase prohibida: "${reject}"` });
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
    title: 'reallimit: el banner reaparece tras la sonda -> limite confirmado',
    scenario: 'reallimit',
    // maxRetries=0: al confirmar el limite, el bucle sale de inmediato sin esperar.
    env: { CR_VERIFY: '1', CR_MAX_RETRIES: '0' },
    expect: 'limite real',
    reject: 'falso positivo',
  },
  {
    title: 'falsepos: claude responde normal tras la sonda -> se continua',
    scenario: 'falsepos',
    env: { CR_VERIFY: '1' },
    expect: 'falso positivo',
    reject: 'limite real',
  },
  {
    title: 'verify-off: CR_VERIFY=0 corta de inmediato (sin sonda)',
    scenario: 'reallimit',
    env: { CR_VERIFY: '0', CR_MAX_RETRIES: '0' },
    expect: 'Maximo de reintentos',
    reject: 'verificando con una sonda',
  },
];

(async () => {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    process.stdout.write(`\n[caso] ${c.title}\n`);
    const r = await runScenario(c);
    if (r.ok) {
      pass++;
      console.log(`  ok`);
    } else {
      fail++;
      console.log(`  FAIL: ${r.reason}`);
      console.log('  --- salida capturada ---');
      console.log(r.buf.split('\n').map((l) => '  | ' + l).join('\n'));
    }
  }
  console.log(`\nRESULTADO E2E: ${pass} ok, ${fail} fallos`);
  process.exit(fail ? 1 : 0);
})();
