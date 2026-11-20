// SPDX-License-Identifier: GPL-3.0-only
// lsdj/lsdj-kit.js and lsdj/lsdj-usage.js: kit slots in a ROM and the kit samples songs play, with a made-up
// ROM and made-up songs (node tests/lsdj-usage.mjs).
import assert from 'node:assert/strict';
import {kitSlots, parseKit, BANK, MAX_SAMPLE_SPACE} from '../lsdj/lsdj-kit.js';
import {kitUsage, usageAcross, romFit, bestRom, savKitCheck, savKitReport} from '../lsdj/lsdj-usage.js';
import {buildSav, SAV_SIZE} from '../lsdj/lsdj-sav.js';

/* a kit bank: name, and samples of the given byte lengths named S0, S1, ... */
function kit(name, lengths) {
  const b = new Uint8Array(BANK).fill(0xff);
  b[0] = 0x60; b[1] = 0x40;
  let at = 0x4060;
  for (let k = 0; k <= 15; k++) { const v = k === 0 ? at : k <= lengths.length ? (at += lengths[k - 1]) : 0; b[2 * k] = v & 255; b[2 * k + 1] = v >> 8; }
  for (let k = 0; k < 15; k++) b.set([...(k < lengths.length ? `S${k.toString(16)}-` : '\0--')].map(c => c.charCodeAt(0)), 0x22 + 3 * k);
  b.set([...name.padEnd(6)].map(c => c.charCodeAt(0)), 0x52);
  return b;
}
/* ROM: code banks 0-7, kits in 8 and 9, code in A, an empty slot in B, a kit in C */
const rom = new Uint8Array(16 * BANK);
rom.set(kit('DRUMS', [0x100, 0x200, 0x40]), 8 * BANK);
rom.set(kit('VOX', [0x800]), 9 * BANK);
rom.fill(0x11, 10 * BANK, 11 * BANK);
rom.fill(0xff, 11 * BANK, 12 * BANK);
rom.set(kit('BASS', [0x10, 0x10]), 12 * BANK);

const slots = kitSlots(rom);
assert.deepEqual(slots.map(s => [s.number, s.bank, s.empty, s.kit?.name ?? null]), [[0, 8, false, 'DRUMS'], [1, 9, false, 'VOX'], [2, 11, true, null], [3, 12, false, 'BASS']]);
const drums = parseKit(rom.subarray(8 * BANK, 9 * BANK));
assert.deepEqual(drums.samples.map(s => [s.index, s.name, s.bytes]), [[0, 'S0-', 0x100], [1, 'S1-', 0x200], [2, 'S2-', 0x40]]);
assert.equal(drums.used, 0x340); assert.equal(drums.free, MAX_SAMPLE_SPACE - 0x340);
assert.equal(parseKit(new Uint8Array(BANK)), null);

/* songs */
function song() {
  const s = new Uint8Array(0x8000);
  s.fill(0xff, 0x1290, 0x1290 + 1024);       /* song table: no chains */
  s.fill(0xff, 0x2080, 0x2080 + 2048);       /* chains: no phrases */
  s.fill(0xff, 0x7000, 0x7000 + 0xff0);      /* phrase steps: no instrument */
  return s;
}
const instr = (s, i, type, b2 = 0, b9 = 0, b6 = 0) => { s[0x2040 + i] = 1; s[0x3080 + i * 16] = type; s[0x3080 + i * 16 + 2] = b2; s[0x3080 + i * 16 + 9] = b9; s[0x3080 + i * 16 + 6] = b6; };
const step = (s, ph, k, note, ins = 0xff) => { s[ph * 16 + k] = note; s[0x7000 + ph * 16 + k] = ins; };

const a = song();
instr(a, 0, 2, 0x40 | 0, 1);                 /* KIT: DRUMS (half speed bit set) + VOX */
instr(a, 1, 2, 3, 3, 0x20 | 2);              /* KIT: BASS + BASS, table 2 on */
instr(a, 2, 1);                              /* a WAVE instrument */
instr(a, 5, 2, 1, 1);                        /* a KIT instrument nothing plays */
a.set([0x41, 0x4f, 0x4e, 0x00, 0x00], 0x1e7a);   /* instrument 0 named "AON" */
a[0x1290 + 2] = 0;  a[0x1290 + 4 * 3 + 2] = 1;   /* WAV channel: row 0 chain 0, row 3 chain 1 */
a[0x2080] = 0x10; a[0x2081] = 0x11;              /* chain 0: phrases 10, 11 */
a[0x2080 + 16] = 0x12; a[0x2880 + 16] = 2;       /* chain 1: phrase 12, transposed */
step(a, 0x10, 0, 0x12, 0);                       /* DRUMS S0 + VOX S1 */
step(a, 0x10, 1, 0x30);                          /* no instrument: still 0 -> DRUMS S2 */
step(a, 0x11, 0, 0x01, 2);                       /* WAVE: not a kit */
step(a, 0x11, 1, 0x20, 0);                       /* DRUMS S1 */
step(a, 0x11, 2, 0x11, 1);                       /* BASS: table 2 has no transposes -> sure */
step(a, 0x12, 0, 0x20, 0);                       /* chain transposed: DRUMS S1 maybe (already sure) */
step(a, 0x12, 1, 0x05, 0);                       /* VOX S4 maybe */
step(a, 0x40, 0, 0x22, 0);                       /* a phrase no chain plays: not counted */
const ua = kitUsage(a);
const view = u => Object.fromEntries([...u.kits].map(([k, v]) => [k, {sure: [...v.samples].sort(), maybe: [...v.maybe].sort()}]));
assert.deepEqual(view(ua), {0: {sure: [0, 1, 2], maybe: []}, 1: {sure: [1], maybe: [4]}, 3: {sure: [0], maybe: []}});
assert.deepEqual(ua.kitInstruments.map(k => [k.label, k.kit1, k.kit2]), [['00 AON', 0, 1], ['01', 3, 3], ['05', 1, 1]]);
assert.ok(ua.kits.get(0).instruments.has('00 AON'));

/* a table with transposes makes the instrument's notes maybe */
a[0x3480 + 2 * 16 + 3] = 12;
assert.deepEqual(view(kitUsage(a))[3], {sure: [], maybe: [0]});

/* across songs */
const b = song();
instr(b, 0, 2, 1, 0);
b[0x1290 + 2] = 0; b[0x2080] = 0; step(b, 0, 0, 0x50, 0);        /* VOX S4 sure; DRUMS: nothing (low digit 0) */
const across = usageAcross([{name: 'A', song: a}, {name: 'B', song: b}]);
const songsFor = (k, smp) => { const e = across.get(k)?.get(smp); return e && {songs: [...e.songs], maybe: [...e.maybe]}; };
assert.deepEqual(songsFor(1, 4), {songs: ['B'], maybe: ['A']});
assert.deepEqual(songsFor(0, 1), {songs: ['A'], maybe: []});
assert.equal(songsFor(0, 4), undefined);

/* does an LSDj fit the songs? kits it lacks (made with another LSDj) vs notes on empty sample slots */
{
  const U = (entries) => new Map(entries.map(([k, smp]) => [k, new Map(smp.map(([i, sure, maybe = []]) => [i, {songs: new Set(sure), maybe: new Set(maybe)}]))]));
  const usage = U([[0, [[0, ['A']]]], [2, [[0, ['B']]]], [5, [[0, ['C']]]], [1, [[3, ['D']]]], [3, [[1, [], ['E']]]]]);
  const fit = romFit(slots, usage);
  assert.deepEqual(fit.kits.map(m => [m.kit, m.why, m.songs]), [[2, 'empty', ['B']], [5, 'no kit', ['C']]]);
  assert.deepEqual(fit.empty.map(m => [m.kit, m.sample, m.songs]), [[1, 3, ['D']]]);
  assert.equal(fit.played, 4); assert.equal(fit.ok, false);   /* maybe-only samples don't count */
  assert.equal(romFit(slots, U([[0, [[2, ['A']]]], [1, [[3, ['D']]]]])).ok, true);   /* an empty sample slot alone: fits */
  /* several ROMs: the one with fewest missing kits wins */
  const rom2 = rom.slice(); rom2.set(kit('PADS', [0x20]), 11 * BANK);
  const {best, fits} = bestRom([{name: 'one', slots}, {name: 'two', slots: kitSlots(rom2)}], usage);
  assert.equal(best.name, 'two'); assert.deepEqual(fits.map(f => [f.name, f.fit.kits.length]), [['two', 1], ['one', 2]]);
}


/* songs alone to an FM-1 (Import a .sav…): the kits they play that its LSDj doesn't have, and the LSDj files that do */
{
  const c = song();
  instr(c, 0, 2, 2, 7);                                           /* KIT: slot 2 (empty) + kit 7 (none) */
  c[0x1290] = 0; c[0x2080] = 0; step(c, 0, 0, 0x11, 0);
  const songs = [{name: 'A', song: a}, {name: 'B', song: b}];
  const r1 = savKitCheck(songs, slots);
  assert.deepEqual(r1.problems.map(p => [p.kit, p.why, p.last, p.samples, p.songs]), [[1, 'short', 0, [1, 4], ['A', 'B']]]);   /* VOX has 1 sample */
  const rom3 = rom.slice(); rom3.set(kit('VOX', [0x10, 0x10, 0x10, 0x10, 0x10]), 9 * BANK);
  assert.deepEqual(savKitCheck(songs, slots, [{name: 'one', slots}, {name: 'five', slots: kitSlots(rom3)}]).fits, ['five']);
  assert.deepEqual(savKitCheck([{name: 'C', song: c}], slots).problems.map(p => [p.kit, p.why, p.songs]), [[2, 'empty', ['C']], [7, 'no kit', ['C']]]);
  assert.deepEqual(savKitCheck([{name: 'A', song: a}], kitSlots(rom3)).problems, []);   /* every kit and sample there */

  /* a whole .sav: B open, A saved (the open song checked as it is) */
  const blank = new Uint8Array(SAV_SIZE); blank[0x813e] = 0x6a; blank[0x813f] = 0x6b;
  const sav = buildSav(blank, b, [{slot: 0, name: 'BEATS', song: b}, {slot: 1, name: 'ACID', song: a}], 0);
  const rep = savKitReport(sav, {name: 'My LSDj', bytes: rom, kits: [8, 9, 12]}, [{name: 'Five', bytes: rom3}]);
  assert.match(rep.ask, /other kits than the FM-1's LSDj \(My LSDj\)/);
  assert.match(rep.ask, /• kit 01 VOX has 1 sample; they play more: BEATS, ACID\n/);
  assert.match(rep.ask, /Five \(one of your LSDj files\) has every kit they play/);
  assert.match(rep.note, /; Five has them\.$/);
  /* VOX not installed (left out of the FM-1): empty there */
  assert.match(savKitReport(sav, {name: 'My LSDj', bytes: rom, kits: [8, 12]}).ask, /• kit 01 is empty on it: BEATS, ACID\n\nA \.sav holds no samples/);
  assert.deepEqual(savKitReport(sav, {name: 'Five', bytes: rom3, kits: [8, 9, 12]}), {ask: null, note: ' Every kit its songs play is on the FM-1 (Five).'});
}
console.log('PASS lsdj-usage: kit slots (empty slots counted), kit samples, songs -> KIT1/KIT2 samples, last instrument kept, transposes and tables maybe, unplayed phrases ignored, across songs, LSDj fit and best of several, the kits of a .sav checked against an FM-1 (Import a .sav…)');
