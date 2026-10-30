import test from 'node:test'; import assert from 'node:assert/strict';
import { parseNumberDetailed, parseNumber } from '../src/util/num.js';
import { toWib, parseTime } from '../src/util/time.js';

test('parse harga desimal & persen', () => {
  assert.equal(parseNumber('1.144'), 1.144);
  assert.equal(parseNumber('$1,234.56'), 1234.56);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('0,0123'), 0.0123);
  assert.equal(parseNumber('2.5%'), 2.5);
  assert.equal(parseNumber('64.250 USDT'), 64.25);
  assert.equal(parseNumber('1,234,567'), 1234567);
  assert.equal(parseNumber('abc'), null); assert.equal(parseNumber(''), null); assert.equal(parseNumber(null), null);
});
test('koma tunggal 3 digit ditandai ambigu', () => assert.deepEqual(parseNumberDetailed('1,144'), { value: 1144, ambiguous: true }));
test('UTC -> WIB', () => {
  assert.equal(toWib('2026-10-08T01:47:00Z'), '2026-10-08 08:47');
  assert.equal(toWib('2026-10-08T18:00:00Z'), '2026-10-09 01:00'); // lintas hari
  assert.equal(toWib('bukan tanggal'), null);
});
test('parseTime hanya menerima zona eksplisit', () => {
  assert.equal(parseTime('2026-10-08 08:47 WIB'), Date.parse('2026-10-08T01:47:00Z'));
  assert.equal(parseTime('2026-10-08 01:47 UTC'), Date.parse('2026-10-08T01:47:00Z'));
  assert.equal(parseTime('2026-10-08 08:47'), null);
});
