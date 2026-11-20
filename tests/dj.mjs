// SPDX-License-Identifier: GPL-3.0-only
// lsdj/dj.js: the DJ layout's maths (node tests/dj.mjs).
import assert from 'node:assert/strict';
import {BEAT, BAR, position, offset, syncBend, nextOn, START_ON, startUnit, startTime, chainEnd, chainStart, countIn, crossfade, level, djFilter, tapper, clockMeter, SYNC_MAX_BEND, SYNC_MIN_MS} from '../lsdj/dj.js';
import {PPQN} from '../lsdj/midiclock.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* where in the bar */
assert.equal(BEAT, 24); assert.equal(BAR, 96);
assert.deepEqual(position(0), {bar: 0, beat: 0, frac: 0});
assert.deepEqual(position(96 + 36), {bar: 1, beat: 1, frac: 0.5});
assert.equal(position(null), null);
assert.deepEqual(position(-5), {bar: 0, beat: 0, frac: 0}, 'before the first clock: the start');

/* how far from the master, half a bar either way */
assert.equal(offset(10, 10), 0);
assert.equal(offset(10, 16), 6, 'behind by a row');
assert.equal(offset(16, 10), -6, 'ahead by a row');
assert.equal(offset(95, 1), 2, 'across the bar line');
assert.equal(offset(1, 95), -2);
assert.equal(offset(0, 48), -48, 'half a bar: either way, one answer');
assert.equal(offset(1000 * BAR + 3, 7), 4, 'bars apart do not matter');
assert.equal(offset(null, 3), null);

/* Sync: a bend that makes up the gap, gently */
{ assert.deepEqual(syncBend(0, 120), {factor: 1, ms: 0});
  const clock = 60000 / (120 * PPQN);
  for (const gap of [1, 6, -6, 47, -48]) {
    const {factor, ms} = syncBend(gap, 120);
    assert.ok(ms >= SYNC_MIN_MS && Math.abs(factor - 1) <= SYNC_MAX_BEND + 1e-9, `gap ${gap}: within the limits`);
    assert.ok(near((factor - 1) * ms / clock, gap, 1e-6), `gap ${gap}: made up exactly`);
    assert.equal(Math.sign(factor - 1), Math.sign(gap), 'behind: faster; ahead: slower');
  } }

/* the master's next beat / bar */
{ const clock = 60000 / (120 * PPQN);
  assert.ok(near(nextOn(90, 120, 1000), 1000 + 6 * clock));
  assert.ok(near(nextOn(96 * 3, 120, 1000), 1000), 'on the bar: now');
  assert.ok(near(nextOn(30, 120, 0, BEAT), 18 * clock), 'the next beat');
  assert.equal(nextOn(null, 120, 50), 50, 'no master: now'); }

/* Play's start (Start on): every N bars of a reference, now, or no reference; the count-in */
{ const clock = 60000 / (120 * PPQN);
  assert.equal(startUnit('now'), 0); assert.equal(startUnit('beat'), BEAT); assert.equal(startUnit('8'), 8 * BAR);
  assert.equal(startUnit('nonsense'), BAR, 'unknown: the next bar');
  /* Next chain (0.9.98-dev.12): the deck's bar line nearest where LIVE says its chain ends */
  assert.equal(startUnit('chain'), BAR);
  const bar = 2000, T = 10000;   /* 120 BPM: a phrase is 2 s, a row 125 ms */

  /* phrase 1 of 4, row 8 read now: 7.5 rows of it + 3 more phrases = 55.5 rows left */
  assert.ok(near(chainEnd(0, 4, 8, T, 120, T), T + 55.5 * 125), 'phrase 1 of 4, row 8: 55.5 rows left');
  assert.ok(near(chainEnd(0, 4, 8, T - 500, 120, T), T + 51.5 * 125), 'read 0.5 s (4 rows) ago');
  assert.ok(near(chainEnd(3, 4, 15, T - 1000, 120, T), T + (0.5 - 8 + 64) * 125), 'past the chain end: the next one, as long');
  assert.equal(chainEnd(null, 4, 3, T, 120, T), null); assert.equal(chainEnd(1, null, 3, T, 120, T), null); assert.equal(chainEnd(1, 4, 3, null, 120, T), null);
  /* the start is on a bar line when one is within 1.5 rows (187 ms) of the chain's end as LIVE says it ... */
  for (const err of [-180, -60, 0, 60, 180]) {
    const end = T + 700 + 6 * bar + err, got = chainStart(T + 700, 120, end);
    assert.ok(near(got, T + 700 + 6 * bar), `chain ends 6 bars after the next line, estimated ${err} ms off: its 6th bar line (${got})`);
  }
  /* ... else it is the end itself (grids apart: never a phrase out, never sliding from bar to bar) */
  for (const err of [-900, -400, 400, 900]) {
    const end = T + 700 + 6 * bar + err;
    assert.ok(near(chainStart(T + 700, 120, end), end), `phrases ${err} ms off the clock's bars: the end itself`);
  }
  { let prev = null;   /* the estimate wandering 0.5 bar to and fro doesn't move the start by a bar */
    for (let w = 0; w < 40; w++) { const end = T + 700 + 6 * bar + 1000 + (w % 2 ? 40 : -40), got = chainStart(T + 700, 120, end);
      assert.ok(Math.abs(got - end) < 1e-6, 'half a bar off: the end, whichever way it rounds'); } }
  assert.ok(near(chainStart(T + 700, 120, T + 100), T + 100), 'an end before the next bar (grids apart): the end itself');
  assert.ok(near(chainStart(T + 700, 120, null), T + 700), 'not known: the next bar');
  /* a chain of 2 on its last row of phrase 1: its end is 16.5 rows (2.06 s) on. The clock's line a little before or
     after the row's own idea of the phrase end (62 ms) must still mean "the phrase after": a bar after that line */
  for (const lineAt of [0, 62.5, 150]) {
    const end = chainEnd(0, 2, 15, T, 120, T);
    assert.ok(near(chainStart(T + lineAt, 120, end), T + lineAt + bar), `row 15 of 2, the clock's line ${lineAt} ms on: the next phrase's end`);
  }
  assert.ok(near(chainStart(T + 600, 120, chainEnd(0, 2, 15, T, 120, T)), T + 2062.5), 'a clock line 540 ms from the phrase end: the end itself');
  assert.ok(START_ON.every(([k, t, u]) => typeof k === 'string' && t && u === startUnit(k)));
  assert.ok(near(startTime(BAR * 5.5, 120, 1000, 8 * BAR), 1000 + BAR * 2.5 * clock), 'bar 5.5 of 8: its bar 8');
  assert.ok(near(startTime(BAR * 4, 120, 1000, 4 * BAR), 1000), 'on its 4 bars: now');
  assert.ok(near(startTime(0x0A * 6, 120, 0, BAR), 6 * 6 * clock), 'its LSDj at row 0A: 6 rows later (row 00)');
  assert.equal(startTime(null, 120, 50, BAR), 50, 'nothing plays: now');
  assert.equal(startTime(30, 120, 50, 0), 50, 'Now: now');
  assert.deepEqual(countIn(2000, 120, 0), {beats: 4, bars: 1}, '2 s at 120: 4 beats, a bar');
  assert.deepEqual(countIn(2100, 120, 0), {beats: 5, bars: 2});
  assert.deepEqual(countIn(400, 120, 0), {beats: 1, bars: 1}, 'the last beat: 1');
  assert.deepEqual(countIn(0, 120, 10), {beats: 0, bars: 0}, 'past: 0'); }

/* crossfader */
assert.deepEqual(crossfade(0, 'linear'), [1, 0]); assert.deepEqual(crossfade(1, 'linear'), [0, 1]);
{ const [a, b] = crossfade(0.5); assert.ok(near(a * a + b * b, 1), 'smooth: constant power'); assert.ok(near(a, b)); }
assert.deepEqual(crossfade(0.5, 'cut'), [1, 1]); assert.deepEqual(crossfade(0, 'cut'), [1, 0]); assert.deepEqual(crossfade(1, 'cut'), [0, 1]);
assert.deepEqual(crossfade(-3, 'linear'), [1, 0], 'clamped');
assert.equal(level(1), 127); assert.equal(level(0), 0); assert.equal(level(2), 127);

/* DJ filter: off in the middle, LP closing to the left, HP opening to the right */
assert.deepEqual(djFilter(0), {type: 0, cutoff: 0, reso: 0}); assert.deepEqual(djFilter(2), {type: 0, cutoff: 0, reso: 0});
{ const l1 = djFilter(-10), l2 = djFilter(-60), r1 = djFilter(10), r2 = djFilter(63);
  assert.ok(l1.type === 1 && l2.type === 1 && l1.cutoff > l2.cutoff, 'left: low-pass, darker further');
  assert.ok(r1.type === 2 && r2.type === 2 && r1.cutoff < r2.cutoff && r2.cutoff === 127, 'right: high-pass, thinner further');
  assert.equal(djFilter(-64).cutoff, 0);
  for (const v of [-64, -30, 5, 63, 200, -200]) { const f = djFilter(v); assert.ok(f.cutoff >= 0 && f.cutoff <= 127 && f.reso >= 0 && f.reso <= 127); } }

/* tap tempo */
{ const t = tapper();
  assert.equal(t.tap(0), null);
  assert.equal(t.tap(500), 120);
  t.tap(1000); assert.equal(t.tap(1500), 120);
  assert.equal(t.tap(4000), null, 'a long pause starts over');
  assert.equal(t.tap(4400), 150); }

/* an outside clock's tempo */
{ const m = clockMeter(), clock = 60000 / (128 * PPQN); let r = null;
  for (let i = 0; i <= 24; i++) r = m.feed(i * clock);
  assert.equal(r, 128);
  assert.equal(m.feed(24 * clock + 2000), null, 'stopped: starts over'); }

console.log('PASS DJ maths: bar position, offset to the master, Sync bend, next beat / bar, crossfader curves, DJ filter, tap tempo, clock tempo');
