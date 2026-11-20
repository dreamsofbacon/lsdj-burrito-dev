// SPDX-License-Identifier: GPL-3.0-only
// lsdj/lsdj-sets.js: song sets (an LSDj + .sav made for chosen songs), with made-up ROMs and songs only
// (node tests/lsdj-sets.mjs).
import assert from 'node:assert/strict';
import {BANK, kitSlots, parseKit, buildKit, kitSampleNibbles} from '../lsdj/lsdj-kit.js';
import {parseSav, songBytes, BLOCK_COUNT} from '../lsdj/lsdj-sav.js';
import {planRom} from '../lsdj/lsdj-rom.js';
import * as S from '../lsdj/lsdj-sets.js';

/* a sound: n frames of a pattern (seed changes it) */
const sound = (frames, seed) => Uint8Array.from({length: frames * 32}, (_, i) => (i * seed + (i >> 3)) % 16);
const kitOf = (name, sizes, rotate, seed = 1) => buildKit({name, rotate,
  samples: sizes.map((f, i) => ({name: `${name[0]}${i}`, nibbles: sound(f, seed + i)}))});
/* an LSDj ROM: header "LSDj-vX", code banks 0-7, then kit slots (kits given, the rest empty) up to 32 banks */
function lsdj(version, kits, slotCount = 8) {
  const rom = new Uint8Array(32 * BANK).fill(0xff);
  for (let b = 0; b < 8; b++) rom.fill(b + 1, b * BANK, (b + 1) * BANK);
  rom.fill(0x20, 0x134, 0x144);
  rom.set([...`LSDj-v${version}`].map(c => c.charCodeAt(0)), 0x134);
  rom[0x143] = 0; rom[0x147] = 0x1b; rom[0x148] = 4; rom[0x149] = 4;
  kits.forEach((k, i) => k && rom.set(k, (8 + i) * BANK));
  for (let b = 8 + slotCount; b < 32; b++) rom.fill(0x30 + b, b * BANK, (b + 1) * BANK);   /* code after the slots */
  let h = 0; for (let i = 0x134; i < 0x14d; i++) h = (h - rom[i] - 1) & 0xff; rom[0x14d] = h;
  return rom;
}
/* a song: kit instruments [{ins, k1, k2}], and on the wave channel one phrase of notes played by instrument ins0 */
function song(instruments, notes, ins0 = instruments[0]?.ins ?? 0) {
  const s = new Uint8Array(0x8000);
  s.fill(0xff, 0x1290, 0x1290 + 1024); s.fill(0xff, 0x2080, 0x2080 + 2048); s.fill(0xff, 0x7000, 0x7000 + 0xff0);
  for (const {ins, k1, k2 = 0, type = 2} of instruments) { s[0x2040 + ins] = 1; s[0x3080 + ins * 16] = type; s[0x3082 + ins * 16] = 0x40 | k1; s[0x3089 + ins * 16] = 0x80 | k2; }
  s[0x1290 + 2] = 0; s[0x2080] = 0;
  notes.forEach((n, i) => { s[i] = n; s[0x7000 + i] = i ? 0xff : ins0; });
  return s;
}

/* ---- trimming and converting kits ---- */
{
  const k = kitOf('DRUMS', [4, 6, 3], true);
  const t = S.trimKit(k, new Set([1]), true);
  assert.deepEqual(parseKit(t).samples.map(s => [s.index, s.name, s.bytes]), [[0, 'D0-', 16], [1, 'D1-', 6 * 16], [2, 'D2-', 16]]);
  assert.deepEqual(kitSampleNibbles(t, 1), kitSampleNibbles(k, 1));                   /* kept: the same sound */
  assert.ok(kitSampleNibbles(t, 0).every(v => v === 8));                              /* dropped: one silent frame */
  assert.equal(parseKit(t).name, 'DRUMS'); assert.equal(t[0x5f], 1);
  assert.ok(S.storedLength(t) < S.storedLength(k));
  assert.equal(S.storedLength(t), 0x60 + 16 + 96 + 16);
  assert.equal(S.trimmedSize(k, new Set([1])), S.storedLength(t));
  /* an older LSDj's kit (frames not rotated) into a 9.2+ LSDj, and back */
  const old = kitOf('DRUMS', [4, 6, 3], false), conv = S.trimKit(old, new Set([0, 1, 2]), true);
  assert.equal(conv[0x5f], 1);
  for (const i of [0, 1, 2]) assert.deepEqual(kitSampleNibbles(conv, i), kitSampleNibbles(old, i));
  assert.deepEqual(conv.subarray(0, S.storedLength(conv)), k.subarray(0, S.storedLength(k)));
  const back = S.trimKit(k, new Set([0, 1, 2]), false);
  assert.deepEqual(back.subarray(0, S.storedLength(back)), old.subarray(0, S.storedLength(old)));
  /* the same kit is the same kit whichever way it is stored; another kit is not */
  assert.equal(S.kitKey(old), S.kitKey(k));
  assert.notEqual(S.kitKey(kitOf('DRUMS', [4, 6, 3], true, 5)), S.kitKey(k));
}

/* ---- versions ---- */
assert.deepEqual(S.lsdjVersion(lsdj('9.3.9', [])), [9, 3, 9]);
/* a label: the version, else "before 4.3" for the old "LSDJ" title, else the title */
assert.equal(S.lsdjLabel(lsdj('9.3.9', [])), '9.3.9');
{ const r = lsdj('9.3.9', []); r.fill(0, 0x134, 0x144); r.set([..."LSDJ"].map(c => c.charCodeAt(0)), 0x134); assert.equal(S.lsdjLabel(r), 'before 4.3');
  r.fill(0, 0x134, 0x144); r.set([..."MYGAME"].map(c => c.charCodeAt(0)), 0x134); assert.equal(S.lsdjLabel(r), '"MYGAME"');
  r.fill(0, 0x134, 0x144); assert.equal(S.lsdjLabel(r), 'unknown version'); }
assert.equal(S.wantsRotated(lsdj('9.3.9', [])), true);
assert.equal(S.wantsRotated(lsdj('5.7.8', [])), false);
assert.ok(S.compareVersions([5, 7, 8], [9, 3, 9]) < 0);

/* ---- renumbering touches only kit instruments' kit numbers ---- */
{
  const s = song([{ins: 1, k1: 2, k2: 3}, {ins: 2, k1: 2, type: 0}], [0x11]);
  const r = S.renumberSong(s, new Map([[2, 5]]), 7);
  assert.equal(r[0x3082 + 16], 0x40 | 5); assert.equal(r[0x3089 + 16], 0x80 | 7);    /* high bits (half speed etc.) kept */
  assert.equal(r[0x3082 + 32], s[0x3082 + 32]);                                         /* not a kit instrument */
  for (let i = 0; i < 0x8000; i++) if (![0x3082 + 16, 0x3089 + 16].includes(i)) assert.equal(r[i], s[i]);
}

/* ---- matching songs to LSDj files, and missing kits ---- */
const drums = kitOf('DRUMS', [40, 40, 40], true, 1), vox = kitOf('VOX', [60, 60], true, 2), bass = kitOf('BASS', [200, 200], true, 3);
const romA = lsdj('9.3.9', [drums]);
const romB = lsdj('9.3.9', [drums, vox]);
const romOld = lsdj('5.7.8', [null, null, S.trimKit(bass, new Set([0, 1]), false)]);
const roms = [{id: 'a', name: 'a.gb', rom: romA}, {id: 'b', name: 'b.gb', rom: romB}, {id: 'old', name: 'old.gb', rom: romOld}];
const songs = [
  {id: 'x1', name: 'ONE', group: 'x', song: song([{ins: 0, k1: 0, k2: 1}], [0x11, 0x20])},   /* DRUMS 0+1, VOX 0 */
  {id: 'x2', name: 'TWO', group: 'x', song: song([{ins: 0, k1: 0}], [0x30])},               /* DRUMS 2 */
  {id: 'y1', name: 'LOW', group: 'y', song: song([{ins: 0, k1: 2}], [0x10])},               /* kit 2 = BASS in old.gb, sample 0 */
  {id: 'z1', name: 'LOST', group: 'z', song: song([{ins: 0, k1: 9}], [0x10])},             /* kit 9: nowhere */
];
const res = S.resolveSongs(songs, roms);
assert.deepEqual(res.map(r => r.rom?.id), ['b', 'b', 'old', 'a']);
assert.deepEqual(res[0].kits.map(k => [k.number, k.name, [...k.samples]]), [[0, 'DRUMS', [0, 1]], [1, 'VOX', [0]]]);
assert.deepEqual(res[3].missing, [9]);
/* the user's picks: another LSDj for a song, a kit file for a missing kit, or none */
{
  const kitFiles = [{id: 'k', name: 'mine.kit', bank: vox}];
  const r = S.resolveSongs(songs, roms, kitFiles, {madeWith: {x2: 'a'}, kitPick: {'z1:9': 'kit:k', 'x1:1': 'none'}});
  assert.equal(r[1].rom.id, 'a'); assert.equal(r[1].auto, false);
  assert.deepEqual(r[3].missing, []); assert.equal(r[3].kits[0].name, 'VOX');
  assert.deepEqual(r[0].missing, [1]);
}

/* ---- planning: room for the base LSDj and two kits, not three ---- */
const base = lsdj('9.3.9', [kitOf('STOCK', [10], true, 9)]);
const roomy = S.setContext(base, 0x200000);
assert.equal(roomy.slotCount, 8); assert.equal(roomy.rotate, true);
assert.equal(roomy.baseNeeded, planRom(base.map((b, i) => i >= 8 * BANK && i < 16 * BANK ? 0xff : b), [], 0x200000).needed);
{
  const one = S.planSplit(res, roomy);
  assert.equal(one.length, 1); assert.deepEqual(one[0].entries.map(e => e.name), ['ONE', 'TWO', 'LOW', 'LOST']);
}
const sizeOf = keys => roomy.baseNeeded + keys.reduce((n, k) => n + 8 + S.trimmedSize(k.bank, k.samples), 0);
const all = [...S.planSplit(res, roomy)[0].kits.values()];
const tight = {...roomy, capacity: sizeOf(all) - 1};
{
  const sets = S.planSplit(res, tight);
  assert.equal(sets.length, 2);
  const placed = sets.flatMap(s => s.entries.map(e => e.name)).sort();
  assert.deepEqual(placed, ['LOST', 'LOW', 'ONE', 'TWO']);                     /* every song, once */
  for (const s of sets) { assert.ok(s.bytes <= tight.capacity); assert.deepEqual(s.lost, []); }
}
{
  const m = S.planMost(res, tight);
  assert.equal(m.entries.length, 4); assert.ok(m.bytes <= tight.capacity);
  assert.equal(m.kits.size, all.length - 1);
  assert.ok(m.kits.has(res[0].kits[0].key));                                  /* DRUMS: played by two songs, kept */
  assert.equal(m.lost.length, 1);
}
/* a .sav holds 191 blocks: songs that don't fit are left out of the one set, and split into more sets */
{
  const many = Array.from({length: 40}, (_, i) => ({...res[1], id: 'm' + i, name: 'M' + i, blocks: 10}));
  const m = S.planMost(many, roomy);
  assert.equal(m.entries.length, Math.floor(BLOCK_COUNT / 10) > 32 ? 32 : Math.floor(BLOCK_COUNT / 10));
  assert.equal(m.entries.length + m.leftOut.length, 40);
  const sets = S.planSplit(many, roomy);
  assert.equal(sets.reduce((n, s) => n + s.entries.length, 0), 40);
  for (const s of sets) assert.ok(s.blocks <= BLOCK_COUNT && s.entries.length <= 32);
}

/* ---- building a set ---- */
{
  const [plan] = S.planSplit(res, roomy);
  const built = S.buildSet(plan, roomy);
  const slots = kitSlots(built.rom);
  assert.equal(slots.length, 8);
  /* each kit at its own number when free: DRUMS 0, VOX 1, BASS 2 (from the old LSDj, now rotated) */
  assert.deepEqual(slots.filter(s => !s.empty).map(s => [s.number, s.kit.name]), [[0, 'DRUMS'], [1, 'VOX'], [2, 'BASS']]);
  const bassBank = built.rom.subarray(slots[2].bank * BANK, (slots[2].bank + 1) * BANK);
  assert.equal(bassBank[0x5f], 1);
  assert.deepEqual(kitSampleNibbles(bassBank, 0), kitSampleNibbles(bass, 0));
  assert.ok(kitSampleNibbles(bassBank, 1).every(v => v === 8) && kitSampleNibbles(bassBank, 1).length === 32);   /* not played */
  assert.ok(built.plan.fits);
  assert.ok(built.plan.needed <= plan.bytes);                                                                     /* the estimate is an upper bound */
  /* the .sav: every song, the first one open; LOST's missing kit pointed at an empty slot */
  const sav = parseSav(built.sav);
  assert.deepEqual(sav.songs.map(s => s.name), ['ONE', 'TWO', 'LOW', 'LOST']);
  assert.equal(sav.active, 0);
  assert.equal(songBytes(sav, 3)[0x3082] & 0x3f, 3);
  assert.deepEqual(songBytes(sav, 0), songs[0].song);
  assert.ok(built.warnings.some(w => /LOST: kit 09 wasn't found/.test(w)));
  const text = S.setReport(built, 'Set 1', roomy);
  assert.match(text, /DRUMS/); assert.match(text, /LOW/); assert.match(text, /left out, not played: B1/);
  assert.match(S.setCsv(built, 'Set 1'), /"Set 1","02","BASS","old.gb kit 02","2","B1","no \(not played\)"/);
}
/* a kit whose number is taken moves to a free slot, and the song follows it */
{
  const clash = [{id: 'p', name: 'P', group: 'p', song: song([{ins: 0, k1: 0}], [0x10])},
    {id: 'q', name: 'Q', group: 'q', song: song([{ins: 0, k1: 0}], [0x10])}];
  const r = S.resolveSongs(clash, [{id: 'a', name: 'a.gb', rom: romA}, {id: 'c', name: 'c.gb', rom: lsdj('9.3.9', [vox])}],
    [], {madeWith: {p: 'a', q: 'c'}});
  const built = S.buildSet(S.planSplit(r, roomy)[0], roomy);
  const sav = parseSav(built.sav), slots = kitSlots(built.rom);
  const kitFor = i => slots[songBytes(sav, i)[0x3082] & 0x3f].kit.name;
  assert.deepEqual([kitFor(0), kitFor(1)], ['DRUMS', 'VOX']);
}
/* a base LSDj older than a song's: warned */
{
  const r = S.resolveSongs([songs[0]], roms);
  const ctx = S.setContext(lsdj('5.7.8', []), 0x200000);
  const built = S.buildSet(S.planSplit(r, ctx)[0], ctx);
  assert.ok(built.warnings.some(w => /older/.test(w)));
  assert.equal(built.rom[kitSlots(built.rom)[0].bank * BANK + 0x5f], 0);   /* frames for the old LSDj */
}
/* a lettered version's label: as its title writes it, not "before 4.3"; lsdjVersion stays numbers only */
{
  const titled = t => { const r = new Uint8Array(0x8000); [...t].forEach((c, i) => r[0x134 + i] = c.charCodeAt(0)); return r; };
  assert.equal(S.lsdjLabel(titled('LSDj-v9.2.L')), '9.2.L');
  assert.equal(S.lsdjLabel(titled('LSDj-v9.1.Caboy')), '9.1.Caboy');
  assert.equal(S.lsdjLabel(titled('LSDj-v9.3.9')), '9.3.9');
  assert.equal(S.lsdjLabel(titled('LSDJ')), 'before 4.3');
  assert.equal(S.lsdjVersion(titled('LSDj-v9.2.L')), null);
}
/* song formats -> the oldest LSDj that opens them (the dev.18 page), and back from a version */
{
  assert.equal(S.firstLsdjFor(22), '9.2.1');
  assert.equal(S.firstLsdjFor(21), '9.2.0');
  assert.equal(S.firstLsdjFor(4), '5.7.0');
  assert.equal(S.firstLsdjFor(6), '6.8.0', 'a format no build writes: the first LSDj of the next one opens it');
  assert.equal(S.firstLsdjFor(23), 'newer');
  assert.equal(S.firstLsdjFor(null), null);
  assert.equal(S.needsText(22), 'LSDj 9.2.1 or newer');
  assert.equal(S.needsText(23), 'an LSDj newer than 9.4.2 (song format 23)');
  assert.equal(S.needsText(null), null);
  assert.equal(S.formatOfVersion([9, 1, 4]), 19);
  assert.equal(S.formatOfVersion([9, 1, 5]), 20);
  assert.equal(S.formatOfVersion([9, 3, 9]), 22);
  assert.equal(S.formatOfVersion([5, 7, 8]), 4);
  assert.equal(S.formatOfVersion([5, 6, 0]), null, 'before 5.7.0: not all found');
  assert.equal(S.formatOfVersion([9, 5, 0]), null, 'after 9.4.2: not measured');
  for (const [f, v] of Object.entries(S.FORMAT_FIRST)) if (+f >= 4) assert.equal(S.formatOfVersion(v.split('.').map(Number)), +f, v);
}
console.log('lsdj-sets: ok');
