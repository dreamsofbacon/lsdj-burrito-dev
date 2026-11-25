// SPDX-License-Identifier: GPL-3.0-only
// lsdj/link.js and firmware 0.9.98's DJ link (node tests/link-dj.mjs): LIVE read at every length the
// firmware has sent (11 effect words, 17, + battery, + the 0.9.98 bytes), VOLUME_SET, SEQ_SET and SONG_ROWS,
// and what older firmware (status 1) gives. A pretend FM-1; no device.
import assert from 'node:assert/strict';
import {Link, OP, resetCause} from '../lsdj/link.js';

function fake(answer) {
  const sent = [];
  const input = {onmidimessage: null};
  const output = {send(m) {
    const op = m[4], body = [];
    for (let i = 5; i + 1 < m.length - 1; i += 2) body.push(m[i] | (m[i + 1] & 1) << 7);
    sent.push({op, body});
    const [status, data] = answer(op, body);
    queueMicrotask(() => input.onmidimessage({data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
  }};
  return {link: new Link(input, output), sent};
}
const head = [2, 3, 170, 0, 5, 1, 0xF];   /* page, cursor, bpm 170, mute, freeze, playing */
const fx = n => Array.from({length: 4 * n}, (_, i) => i & 255);

/* LIVE: each length */
for (const [name, d, words, batt] of [
  ['before alpha 66', [...head, ...fx(11)], 11, null],
  ['alpha 66', [...head, ...fx(17)], 17, null],
  ['FM-1_979: battery', [...head, ...fx(17), 0x82], 17, {bars: 2, usb: true}],
]) {
  const {link} = fake(() => [0, d]);
  const l = await link.live();
  assert.equal(l.bpm, 170, name); assert.equal(l.fx.length, words, name); assert.deepEqual(l.battery, batt, name);
  assert.equal(l.rows, null, `${name}: no rows`); assert.equal(l.sync, null); assert.equal(l.level, null);
}
{ const {link} = fake(() => [0, [...head, ...fx(17), 0x03, 3, 7, 11, 15, 0x10, 0x11, 0xFF, 0x13, 3, 1, 100]]);
  const l = await link.live();
  assert.equal(l.fx.length, 17, '0.9.98: still 17 effect words'); assert.equal(l.fx[16], (64 | 65 << 8 | 66 << 16 | 67 << 24) >>> 0);
  assert.deepEqual(l.battery, {bars: 3, usb: false});
  assert.deepEqual(l.rows, [3, 7, 11, 15]); assert.deepEqual(l.songRows, [0x10, 0x11, null, 0x13]);
  assert.equal(l.sync, 'midi'); assert.equal(l.live, true); assert.equal(l.level, 100); }
{ const {link} = fake(() => [0, [...head, ...fx(17), 0xFF, ...Array(11).fill(0xFF)]]);
  const l = await link.live();
  assert.deepEqual(l.rows, [null, null, null, null], 'unknown addresses: null'); assert.equal(l.sync, null); assert.equal(l.live, null); assert.equal(l.level, null); }

/* VOLUME_SET, SEQ_SET, SONG_ROWS */
{ const song = Array.from({length: 1024}, (_, i) => i % 5 ? i & 0x7F : 0xFF);
  const {link, sent} = fake((op, b) => op === OP.SONG_ROWS ? [0, [b[0], ...Array.from({length: 64}, (_, i) => b[0] * 4 + i < 1024 ? song[b[0] * 4 + i] : 0xFF)]] : [0, []]);
  assert.equal(await link.volumeSet(64), true); assert.deepEqual(sent.at(-1), {op: OP.VOLUME_SET, body: [64]});
  await link.volumeSet(300); assert.deepEqual(sent.at(-1).body, [127], 'clamped');
  await link.volumeSet(-3); assert.deepEqual(sent.at(-1).body, [0]);
  assert.equal(await link.seqSet(true), true); assert.deepEqual(sent.at(-1), {op: OP.SEQ_SET, body: [1]});
  const rows = await link.songRows(0x20);
  assert.equal(rows.length, 16); assert.deepEqual(rows[0], [128, 129, 130, 131].map(i => i % 5 ? i & 0x7F : null));
  assert.deepEqual(rows[15], [188, 189, 190, 191].map(i => i % 5 ? i & 0x7F : null));
  assert.deepEqual(sent.at(-1), {op: OP.SONG_ROWS, body: [0x20]}); }
{ const {link} = fake(() => [1, []]);   /* 0.9.97 and older */
  assert.equal(await link.volumeSet(10), false); assert.equal(await link.seqSet(false), false); assert.equal(await link.songRows(0), null); }
/* SYNC_SET (0.9.98-dev.2): KEYBD 5, MIDI 3; 'playing' (status 2), 'no' (status 1: older firmware, unknown LSDj) */
{ let status = 0;
  const {link, sent} = fake(() => [status, []]);
  assert.equal(await link.syncSet('keybd'), 'ok'); assert.deepEqual(sent.at(-1), {op: OP.SYNC_SET, body: [5]});
  assert.equal(await link.syncSet('midi'), 'ok'); assert.deepEqual(sent.at(-1), {op: OP.SYNC_SET, body: [3]});
  status = 2; assert.equal(await link.syncSet('keybd'), 'playing');
  status = 1; assert.equal(await link.syncSet('keybd'), 'no');
  await assert.rejects(link.syncSet('lsdj'), /KEYBD or MIDI only/); }

/* IDENTIFY (0.9.98-dev.19): the FM-1's number big on its screen for seconds; older firmware: status 1 -> false */
{ const {link, sent} = fake(() => [0, []]);
  assert.equal(OP.IDENTIFY, 0x3C);
  assert.equal(await link.identify(2, 12), true);
  assert.equal(await link.identify(99, 0), true);
  assert.deepEqual(sent.map(s => [s.op & 0x3f, s.body.slice(-2)]), [[0x3C, [2, 12]], [0x3C, [99, 0]]]);
  for (const [n, s] of [[0, 5], [100, 5], [1, 61], [1, -1], [1.5, 5]]) await assert.rejects(link.identify(n, s), /IDENTIFY/);
  assert.equal(sent.length, 2, 'nothing sent for a number or time out of range'); }
{ const {link} = fake(() => [1, []]);
  assert.equal(await link.identify(1, 12), false); }

/* RESTART (0.9.98-dev.19): why the last run ended, the crash record, the reset cause; older firmware: null */
{ const w = [2, 3, 0x0200ABCD, 0x02001234, 5, 6, 0x01C10000, 812345, 0, 0x44, 0x20];
  const le = v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24];
  const {link, sent} = fake(() => [0, [1, ...w.flatMap(le)]]);
  assert.equal(OP.RESTART, 0x3D);
  assert.deepEqual(await link.restartInfo(), {why: 'crash', crash: {count: 2, vec: 3, pc: 0x0200ABCD, rets: 0x02001234, emu: 5, dbg: 6, sp: 0x01C10000, uptimeMs: 812345, early: 0, load: null}, p3: 0x44, rst: 0x20, cpu1: null});
  assert.deepEqual(sent.map(s => [s.op & 0x3f, s.body.length <= 1]), [[0x3D, true]], 'no arguments (a tag at most)'); }
{ const {link} = fake(() => [0, [2, ...Array(44).fill(0)]]);
  assert.deepEqual(await link.restartInfo(), {why: 'watchdog', crash: null, p3: 0, rst: 0, cpu1: null}); }
{ const {link} = fake(() => [0, [0, ...Array(44).fill(0), 0x01, 0x01, 0x01, 0x00]]);   /* dev.21: CPU1 runs, R1 left from before?, try 1 */
  assert.deepEqual((await link.restartInfo()).cpu1, {running: true, reason: 1, tries: 1, guard: false, p33: 0}); }
{ const {link} = fake(() => [0, [0, ...Array(44).fill(0), 0x00, 0x00, 0x00, 0x01]]);
  assert.deepEqual((await link.restartInfo()).cpu1, {running: false, reason: 0, tries: 0, guard: true, p33: 0}, 'R0: the crash guard');
{ const {link} = fake(() => [0, [0, ...Array(44).fill(0), 0x01, 0x00, 0x01, 0x07 << 1]]);
  assert.equal((await link.restartInfo()).cpu1.p33, 7, 'P33 timeouts since boot'); } }
{ const {link} = fake(() => [0, [0, ...Array(44).fill(0)]]);
  assert.equal((await link.restartInfo()).why, null); }
{ const {link} = fake(() => [1, []]);
  assert.equal(await link.restartInfo(), null); }
{ const {link} = fake(() => [0, [1, 2, 3]]);
  await assert.rejects(link.restartInfo(), /Invalid restart/); }

/* resetCause: the reset cause in words (stability, 2026-11-21: FM-1s restarted on their own, back with CPU1 off) */
/* LAST_RESTART (0.9.98-dev.22): the kept record; none kept or older firmware: null */
{ const le = v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24];
  const w = [0x52030507, 0x0200ABCD, 0x103, 637000, 0xFE | 0x04 << 8 | 116 << 16, 3323746907];
  const {link, sent} = fake(() => [0, w.flatMap(le)]);
  assert.equal(OP.LAST_RESTART, 0x3F);
  assert.deepEqual(await link.lastRestart(), {kind: 'hang', count: 7, p33: 5, pc: 0x0200ABCD, rets: 0x103, uptimeMs: 637000, vec: 254, p3: 4, passes: 116, build: 3323746907, load: null});
  assert.deepEqual(sent.map(s => s.op & 0x3f), [0x3F]); }
/* (0.9.98-dev.23, a hang: 0x53, its load in words 2 and 3, the uptime in seconds) */
{ const le = v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24];
  const w = [0x53030001, 0x0200EFFA, (0x100 | 0x34) | 998 << 12 | 40 << 22 | 1 << 29, 848 | 0 << 18 | 9 << 24, 0xFE | 0x40 << 8, 932226441];
  const {link} = fake(() => [0, w.flatMap(le)]);
  assert.deepEqual(await link.lastRestart(), {kind: 'hang', count: 1, p33: 0, pc: 0x0200EFFA, rets: 0x134, uptimeMs: 848000, vec: 254, p3: 0x40, passes: 0, build: 932226441,
    load: {share: 99.8, ring: 40, rxPend: true, overflow: false, moves: 0, scanUs: 180, audUs: null, irqs: null, sx: null}}); }
{ const {link} = fake(() => [1, []]); assert.equal(await link.lastRestart(), null, 'none kept / older firmware'); }
{ const {link} = fake(() => [0, [1, 2, 3]]); await assert.rejects(link.lastRestart(), /Invalid kept restart/); }
assert.equal(resetCause(null), null);
assert.equal(resetCause({why: null, p3: 0x01, rst: 0}).kind, 'on');
assert.equal(resetCause({why: null, p3: 0x02, rst: 0}).kind, 'power', 'VDDIO low');
assert.equal(resetCause({why: null, p3: 0x21, rst: 0}).kind, 'power', '1.2 V low with power-on');
assert.equal(resetCause({why: null, p3: 0x40, rst: 0}).kind, 'restart');
assert.equal(resetCause({why: null, p3: 0x00, rst: 0x20}).kind, 'planned');
assert.equal(resetCause({why: null, p3: 0x10, rst: 0}).kind, 'button');
assert.equal(resetCause({why: 'crash', p3: 0x40, rst: 0}).kind, 'crash');
assert.equal(resetCause({why: 'watchdog', p3: 0x04, rst: 0}).kind, 'watchdog');
assert.equal(resetCause({why: 'watchdog', p3: 0x04, rst: 0x20}).kind, 'planned', 'an install after a watchdog restart: the core reset is the latest');
assert.equal(resetCause({why: null, p3: 0, rst: 0}).kind, 'unknown');
assert.equal(resetCause({why: 'hang', p3: 0x40, rst: 0}).kind, 'hang', '0.9.98-dev.20: the hang recorder');
{ const {link} = fake(() => [0, [3, ...Array(44).fill(0)]]);
  assert.equal((await link.restartInfo()).why, 'hang'); }
/* (0.9.98-dev.23: 17 words; a hang's (vector 254) load figures from psr and the ETM words; a crash's: none) */
{ const le = v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24];
  const w = [1, 254, 0x0200EFFA, 0, 0, 0, 0x469D8402, 848000, 0, 0x40, 0, 0, 995, 2400 | 4800 << 16, 60 | 1 << 8 | 1 << 10 | 3 << 16, 0, 10500];
  const {link} = fake(() => [0, [3, ...w.flatMap(le)]]);
  assert.deepEqual((await link.restartInfo()).crash.load, {share: 99.5, scanUs: 100, audUs: 200, ring: 60, rxPend: true, overflow: false, usb: true, sx: 3, moves: 0, irqs: 10500, history: null});
  /* (0.9.98-dev.24: 25 words, the hang's last 8 seconds of speed test; seconds not yet timed (bit 31 clear) left out) */
  const sp = (50 | 46 << 7 | 31 << 13 | 21 << 19 | 41 << 25 | 1 << 31) >>> 0;
  const want = {share: 50, audUs: 2560, spinUs: 8, sramUs: 1.3, flashUs: 42.7};
  const f3 = fake(() => [0, [3, ...[...w, 0, 0, 0, sp, sp, sp, sp, sp].flatMap(le)]]);
  assert.deepEqual((await f3.link.restartInfo()).crash.load.history, Array(5).fill(want));
  { const f4 = fake(() => [0, [...head, ...fx(17), 0x03, ...Array(19).fill(0xFF), ...le(sp)]]);
    assert.deepEqual((await f4.link.live()).speed, want, 'LIVE (dev.24): the newest second of the speed test');
    const f5 = fake(() => [0, [...head, ...fx(17), 0x03, ...Array(19).fill(0xFF), 0, 0, 0, 0]]);
    assert.equal((await f5.link.live()).speed, null, 'none yet');
    const f6 = fake(() => [0, [...head, ...fx(17), 0x03, ...Array(19).fill(0xFF)]]);
    assert.equal((await f6.link.live()).speed, null, 'older firmware'); }
  w[1] = 3; const f2 = fake(() => [0, [1, ...w.flatMap(le)]]);
  assert.equal((await f2.link.restartInfo()).crash.load, null, 'a crash: psr and the ETM trace are its own'); }
assert.match(resetCause({why: null, p3: 0x02, rst: 0x1}).text, /brown-out.*VDDIO low \(P3_RST_SRC 0x02, RST_SRC 0x1\)/);
assert.match(resetCause({why: null, p3: 0x02, rst: 0x20}).text, /planned restart.*VDDIO low, core reset/, 'a dip long ago, then an install');

console.log('PASS link DJ: LIVE at every length (11 / 17 words, battery, 0.9.98 rows, song rows, SYNC, SEQ, volume), VOLUME_SET, SEQ_SET, SONG_ROWS, SYNC_SET (ok, playing, no), IDENTIFY, RESTART and its reset cause, older firmware');
