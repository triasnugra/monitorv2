import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/browser/session.js';
import { runScrape } from '../src/scrapers/base.js';

const never = () => new Promise(() => {});
const cfg = { url: 'u', scanButtonText: 'Pindai ulang', gotoTimeoutMs: 50, scanTimeoutMs: 30, quietMs: 5, stepGraceMs: 40 };
const page = (over = {}) => ({
  on() {},
  goto: async () => ({ status: () => 200 }),
  getByText: () => ({ first: () => ({ click: async () => {} }) }),
  evaluate: async (fn) => (fn.name === 'waitForDomQuiet' ? { stable: true, waitedMs: 1 } : { text: '', html: '' }),
  ...over,
});
const timed = async (p) => { const t = Date.now(); const r = await p; return { r, ms: Date.now() - t }; };

test('withTimeout: promise yang tidak pernah selesai ditolak dengan STEP_TIMEOUT', async () => {
  await assert.rejects(withTimeout(never(), 30, 'x'), (e) => e.code === 'STEP_TIMEOUT' && /x/.test(e.message));
  assert.equal(await withTimeout(Promise.resolve(7), 30, 'ok'), 7);
});

test('halaman memblokir saat menunggu DOM tenang -> FAILED/SCAN_TIMEOUT, bukan menggantung', async () => {
  const { r, ms } = await timed(runScrape(page({ evaluate: never }), cfg, () => ({ items: [], meta: {} })));
  assert.equal(r.status, 'FAILED');
  assert.ok(r.diagnostics.errors.some((e) => e.startsWith('SCAN_TIMEOUT')), r.diagnostics.errors.join('|'));
  assert.ok(ms < 1000, `selesai dalam ${ms}ms`);
});

test('snapshot macet -> FAILED/SNAPSHOT_ERROR dalam batas waktu', async () => {
  const p = page({ evaluate: (fn) => (fn.name === 'waitForDomQuiet' ? Promise.resolve({ stable: true }) : never()) });
  const { r, ms } = await timed(runScrape(p, cfg, () => ({ items: [], meta: {} })));
  assert.equal(r.status, 'FAILED');
  assert.ok(r.diagnostics.errors.some((e) => e.startsWith('SNAPSHOT_ERROR')));
  assert.ok(ms < 1000);
});

test('ekstraksi macet -> FAILED/EXTRACT_ERROR dalam batas waktu', async () => {
  const extract = () => ({ items: [], meta: {} });
  const p = page({ evaluate: (fn) => (fn === extract ? never() : fn.name === 'waitForDomQuiet' ? Promise.resolve({ stable: true }) : Promise.resolve({ text: '', html: '' })) });
  const { r, ms } = await timed(runScrape(p, cfg, extract));
  assert.equal(r.status, 'FAILED');
  assert.ok(r.diagnostics.errors.some((e) => e.startsWith('EXTRACT_ERROR')));
  assert.ok(ms < 1000);
});
