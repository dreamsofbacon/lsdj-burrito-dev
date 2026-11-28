// SPDX-License-Identifier: GPL-3.0-only
// lsdj/midiclock.js: the page as the MIDI clock for the FM-1s, and one FM-1 leading (node tests/midiclock.mjs).
import assert from 'node:assert/strict';
import {startClock, startRelay, workerTimer, clockMs, clampBpm, PPQN, CLOCK, START, CONTINUE, STOP,
  LOOKAHEAD_MS, START_LEAD_MS, MIN_BPM, MAX_BPM} from '../lsdj/midiclock.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const out = (log = []) => ({log, send(d, ts) { log.push([d[0], ts]); }});
const fake = () => {   /* a clock and a timer the test turns by hand */
  const s = {t: 1000, f: null, cancelled: false};
  s.now = () => s.t;
  s.timer = (f, ms) => { assert.equal(ms, 25); s.f = f; return () => { s.cancelled = true; }; };
  s.run = ms => { for (let i = 0; i < ms; i += 5) { s.t += 5; s.f(); } };
  return s;
};

/* tempo */
assert.equal(clampBpm(10), MIN_BPM); assert.equal(clampBpm(999), MAX_BPM); assert.equal(clampBpm('x'), 120);
assert.ok(near(clockMs(120), 500 / PPQN));   /* 24 a beat: 20.83 ms at 120 */

/* start: Start ahead by START_LEAD_MS, then clocks every clockMs, timestamped, never more than LOOKAHEAD_MS ahead */
{
  const f = fake(), a = out(), b = out(), states = [];
  const c = startClock({bpm: 120, targets: [a, b], now: f.now, timer: f.timer, onState: s => states.push(s)});
  f.run(100); assert.equal(a.log.length, 0);                   /* nothing before start */
  c.start(); c.start();                                         /* twice: one Start */
  assert.deepEqual(a.log[0], [START, 1100 + START_LEAD_MS]);
  assert.equal(a.log.filter(([x]) => x === START).length, 1);
  f.run(1000);
  const clocks = a.log.filter(([x]) => x === CLOCK).map(([, ts]) => ts);
  assert.equal(clocks[0], 1100 + START_LEAD_MS);                /* the first clock with the Start */
  for (let i = 1; i < clocks.length; i++) assert.ok(near(clocks[i] - clocks[i - 1], clockMs(120)));
  assert.ok(clocks.at(-1) < f.t + LOOKAHEAD_MS && clocks.at(-1) >= f.t);
  assert.equal(new Set(clocks).size, clocks.length);            /* none twice */
  assert.deepEqual(b.log, a.log);                               /* every target the same */
  assert.equal(c.ticks, clocks.length);
  assert.deepEqual(states, [true]);
  /* tempo change: from the next clock scheduled */
  const n = a.log.length; c.setTempo(240); f.run(500);
  const later = a.log.slice(n).map(([, ts]) => ts);
  for (let i = 2; i < later.length; i++) assert.ok(near(later[i] - later[i - 1], clockMs(240)));
  assert.equal(c.setTempo(1000), MAX_BPM); assert.equal(c.bpm, MAX_BPM);
  /* stop: Stop at once (no timestamp), then no more clocks */
  c.setTempo(120); c.stop();
  assert.deepEqual(a.log.at(-1), [STOP, undefined]);
  const m = a.log.length; f.run(1000); assert.equal(a.log.length, m);
  assert.deepEqual(states, [true, false]);
  c.stop(); assert.equal(a.log.length, m + 1); assert.deepEqual(states, [true, false]);   /* a 2nd Stop: no state change */
  /* continue: Continue, clocks again, the beat count kept; a new start counts from 0 */
  const ticks = c.ticks; c.cont(); assert.deepEqual(a.log[m + 1], [CONTINUE, f.t + START_LEAD_MS]); f.run(200);
  assert.ok(c.ticks > ticks); c.stop(); c.start(); assert.ok(c.ticks <= Math.ceil((START_LEAD_MS + LOOKAHEAD_MS) / clockMs(120)) + 1);
  c.close(); assert.ok(f.cancelled); assert.equal(a.log.at(-1)[0], STOP);
  const k = a.log.length; c.start(); f.run(100); assert.equal(a.log.length, k);   /* closed: nothing */
}

/* a frozen page (a hidden tab, a long task): carries on from now; never a burst of late clocks */
{
  const f = fake(), a = out();
  const c = startClock({bpm: 120, targets: [a], now: f.now, timer: f.timer});
  c.start(); f.run(200);
  const n = a.log.length; f.t += 3000; f.f();   /* 3 s with no wake-up */
  const after = a.log.slice(n).map(([, ts]) => ts);
  assert.ok(after.every(ts => ts >= f.t));
  assert.ok(after.length <= Math.ceil(LOOKAHEAD_MS / clockMs(120)) + 1);
  c.close();
}

/* targets: added later join at the next clock; one that throws is skipped, not dropped; untimed ones get each message when due */
{
  const f = fake(), a = out(), late = out(), v = out(), bad = {send() { throw Error('port closed'); }};
  const c = startClock({bpm: 120, targets: [a, bad], now: f.now, timer: f.timer});
  c.addTarget(v, {timed: false});
  c.start(); f.run(50);
  assert.ok(a.log.length > 3);
  c.addTarget(late); f.run(200);
  assert.ok(late.log.length > 0 && late.log.every(([x, ts]) => x === CLOCK && ts > 1050));   /* no Start: it joins */
  /* untimed: no timestamps, and nothing sent before its time */
  assert.ok(v.log.length > 0 && v.log.every(([, ts]) => ts === undefined));
  assert.equal(v.log[0][0], START);
  const due = a.log.filter(([, ts]) => ts <= f.t).length;
  assert.equal(v.log.length, due);
  c.removeTarget(a); const n = a.log.length; f.run(100); assert.equal(a.log.length, n);
  c.stop(); assert.deepEqual(v.log.at(-1), [STOP, undefined]);
  const m = v.log.length; f.run(300); assert.equal(v.log.length, m);   /* scheduled clocks after Stop never reach it */
  c.close();
}

/* a port that closes for a moment (another FM-1 restarting renumbers the ports on Windows) gets the clock again once it
   opens: it was dropped for good, and its FM-1 stopped while the deck showed it playing (2026-11-27) */
{
  const f = fake(), log = [];
  let closed = false;
  const blink = {send(d, ts) { if (closed) throw Error('InvalidStateError: port disconnected'); log.push([d[0], ts]); }};
  const v = out(); let vClosed = false;
  const vBlink = {send(d) { if (vClosed) throw Error('gone'); v.send(d); }};
  const c = startClock({bpm: 120, targets: [blink], now: f.now, timer: f.timer});
  c.addTarget(vBlink, {timed: false});
  c.start(); f.run(300);
  const n = log.length, m = v.log.length; assert.ok(n > 5 && m > 5);
  closed = vClosed = true; f.run(500); assert.equal(log.length, n); assert.equal(v.log.length, m);
  closed = vClosed = false; f.run(300);
  assert.ok(log.length > n + 5 && log.slice(n).every(([x]) => x === CLOCK), 'clocks again after the port came back');
  assert.ok(v.log.length > m + 5, 'the untimed one too');
  c.close();
}

/* relay: the leader's clock and transport go on at once; anything else stays */
{
  const a = out(), b = out(), bad = {send() { throw Error('gone'); }};
  const r = startRelay({targets: [a, bad]});
  r.addTarget(b, {timed: false});
  assert.equal(r.feed(Uint8Array.of(START)), true);
  assert.equal(r.feed([CLOCK]), true);
  assert.equal(r.feed([0x90, 60, 100]), false);                      /* a note */
  assert.equal(r.feed([0xF0, 0x7D, 0x47, 0x44, 1, 0xF7]), false);    /* the page's own SysEx */
  assert.equal(r.feed([]), false); assert.equal(r.feed(null), false);
  r.feed([CONTINUE]); r.feed([STOP]);
  assert.deepEqual(a.log, [[START, undefined], [CLOCK, undefined], [CONTINUE, undefined], [STOP, undefined]]);
  assert.deepEqual(b.log, a.log);
  r.removeTarget(a); r.feed([CLOCK]); assert.equal(a.log.length, 4); assert.equal(b.log.length, 5);
  r.close(); assert.equal(r.feed([CLOCK]), false); assert.equal(b.log.length, 5);
}

/* the timer: a Worker when there is one (a hidden tab keeps its pace), setInterval otherwise */
{
  let made = null, revoked = null, terminated = false, calls = 0;
  class W { constructor(url) { made = url; } terminate() { terminated = true; } }
  const U = {createObjectURL: () => 'blob:x', revokeObjectURL: u => { revoked = u; }};
  const stop = workerTimer(() => calls++, 25, {Worker: W, Blob: class { constructor(p) { this.p = p; } }, URL: U});
  assert.equal(made, 'blob:x');
  stop(); assert.ok(terminated); assert.equal(revoked, 'blob:x');
  const stop2 = workerTimer(() => calls++, 25, {Worker: undefined});   /* no Worker: setInterval */
  await new Promise(r => setTimeout(r, 80)); stop2(); assert.ok(calls >= 1);
  const c = calls; await new Promise(r => setTimeout(r, 60)); assert.equal(calls, c);
}

/* the DJ layout's deck clocks: start on a given moment, bend the tempo for a while, read the position */
{
  const f = fake(), a = out();
  const c = startClock({bpm: 120, targets: [a], now: f.now, timer: f.timer});
  assert.equal(c.phase(), null, 'stopped: no position');
  c.start(1500);                                           /* the master's next bar, 400 ms from now */
  assert.deepEqual(a.log[0], [START, 1500]);
  assert.ok(near(c.phase(1500), 0) && near(c.phase(1500 + clockMs(120) * 12), 12), 'position in clocks from Start');
  assert.ok(c.phase(1400) < 0, 'before Start: negative');
  f.run(1000);                                             /* t = 2000 */
  assert.ok(near(c.phase(), 500 / clockMs(120), 1e-6));
  assert.equal(c.bend(1.04), 1.04); assert.equal(c.factor, 1.04);
  const n = a.log.length; f.run(500);
  const ts = a.log.slice(n + 1).map(([, t]) => t);
  for (let i = 1; i < ts.length; i++) assert.ok(near(ts[i] - ts[i - 1], clockMs(120) / 1.04), 'bent: 4 % faster');
  assert.equal(c.bpm, 120, 'the tempo itself stays');
  assert.equal(c.bend(9), 2); assert.equal(c.bend(0), 0.5); assert.equal(c.bend('x'), 1, 'clamped; nonsense: none');
  c.stop(); c.start(0); assert.ok(a.log.at(-1)[1] >= f.t + START_LEAD_MS, 'a moment in the past: as soon as it can');
  c.close();
}

console.log('PASS midiclock: the page as the clock (Start, 24 a beat ahead, tempo, Stop, Continue, frozen page, targets, untimed), the relay, the timer, deck clocks (start on a moment, bend, position)');
