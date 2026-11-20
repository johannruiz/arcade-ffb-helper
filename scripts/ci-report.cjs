'use strict';
// CI: turns the launcher self-test report into GitHub annotations (visible on the run page
// without signing in) and a job summary table. Usage: node scripts/ci-report.cjs <dir> [exitCode]
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
const exitCode = process.argv[3] || '?';
const clean = s => String(s ?? '').replace(/\r?\n/g, ' ').replace(/::/g, ': ').slice(0, 900);
const notice = m => console.log(`::notice title=Self-test::${clean(m)}`);
const error = m => console.log(`::error title=Self-test::${clean(m)}`);

let r = null;
try { r = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch {}

// Last lines the app printed (stderr), if any.
let tail = '';
try { tail = fs.readFileSync(path.join(dir, 'app-output.txt'), 'utf8').split(/\r?\n/).filter(l => l.trim() && !/^\[t\]/.test(l)).slice(-6).join(' | '); } catch {}

if (!r) {
  error(`No report (app exit code ${exitCode}). Output: ${tail || '(empty)'}`);
  process.exit(0);
}
if (r.fatal) error(`Self-test crashed (exit ${exitCode}): ${r.fatal}`);

const gpu = r.gpu?.devices?.find(d => d.active)?.name || r.gpu?.renderer || 'unknown';
notice(`${r.platform}/${r.arch} · GPU ${gpu} · SDL3 ${r.bridge?.version || 'not running'}${r.bridge?.missing ? ' (bridge missing: ' + r.bridge.missing + ')' : ''} · data ${r.data?.dir || '?'}`);
if (r.i18n) notice(`UI: en=${r.i18n.en?.play} es=${r.i18n.es?.play} missing keys=${(r.i18n.en?.missing || []).length + (r.i18n.es?.missing || []).length}`);
if (r.captureErrors?.length) notice(`Screenshots unavailable: ${r.captureErrors[0]}`);

const rows = [];
for (const [id, g] of Object.entries(r.games || {})) {
  if (g.error) { error(`${id}: ${g.error}`); rows.push(`| ${id} | ❌ ${clean(g.error)} | | | | |`); continue; }
  const ok = g.adapter && (id !== 'd1' || g.engine) && (id === 'd1' || g.coi);
  const line = `${id}: adapter=${g.adapter} engine=${g.engine} isolated=${g.coi} webgpu=${g.webgpu ? (g.webgpu.vendor || 'yes') + '/' + (g.webgpu.arch || '') : 'none'} version=${g.version || '?'} errors=${(g.consoleErrors || []).length}`;
  (ok ? notice : error)(line + ((g.consoleErrors || []).length ? ' first: ' + g.consoleErrors[0] : ''));
  rows.push(`| ${id} | ${ok ? '✅' : '❌'} | ${g.engine ? 'yes' : 'no'} | ${g.coi ? 'yes' : 'no'} | ${g.webgpu ? clean(g.webgpu.vendor || 'yes') : 'none'} | ${clean(g.version)} |`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Self-test (${r.platform}/${r.arch}, exit ${exitCode})`, '',
    `GPU: ${gpu} · SDL3: ${r.bridge?.version || 'not running'}`, '',
    '| Game | OK | Engine | Isolated | WebGPU | Version |', '|---|---|---|---|---|---|', ...rows, '',
  ].join('\n'));
}
