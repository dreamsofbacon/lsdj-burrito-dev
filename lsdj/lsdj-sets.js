// SPDX-License-Identifier: GPL-3.0-only
// Song sets: an LSDj ROM and a .sav made for chosen songs, holding the kit samples they play. Pure: no DOM.
// Copies only: the user's own files are never changed. Tested in node (tests/lsdj-sets.mjs).
//
// A song names kits only by number (instrument bytes 2 and 9, & 3F); the samples are in the LSDj it was made
// with. So each song is matched to an LSDj ("made with": the best fit, lsdj-usage.js bestRom), which says what
// each kit number is. A set then gets a copy of a base LSDj with its kit slots emptied, the kits its songs need
// put in (each kit keeps its number when that slot is free, else the next free one), and each song's kit
// instruments pointed at the new numbers. Checked in LSDj 9.3.9 (emulator): a kit instrument pointed at another
// slot holding the kit plays and shows that slot's samples.
// Unplayed samples are dropped: each becomes one silent 32-sample frame (16 bytes), so every sample keeps its
// number and the notes in the songs stay as they are (checked in LSDj 9.3.9: the samples after a dropped one
// play as before; a dropped one plays silence). "Maybe" samples (a transpose or table may play them) are kept.
// Kits from LSDj 9.2.0 and later store each frame rotated by one (byte 5F = 1); a kit moved to an older LSDj,
// or the other way, is converted.
// The FM-1 stores each kit without its trailing FF bytes (lsdj-rom.js sparsePack), so a trimmed kit takes less
// room. Limits per set: the firmware slot (template.json cartridge_capacity), the base LSDj's kit slots,
// 32 songs and 191 blocks in the .sav.
import {crc32, planRom} from './lsdj-rom.js';
import {BANK, kitSlots, parseKit, kitSampleNibbles, fixChecksums} from './lsdj-kit.js';
import {kitUsage, usageAcross, bestRom} from './lsdj-usage.js';
import {compressSong, buildSav, nameBytes, SAV_SIZE, SLOTS, BLOCK_COUNT} from './lsdj-sav.js';

const INSTR = 0x3080, KIT = 2, DATA = 0x60, SILENT = 0x77;
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');

/* ---- LSDj versions ---- */
/* "LSDj-v9.3.9" in the ROM header -> [9, 3, 9], or null */
export function lsdjVersion(rom) {
  const t = String.fromCharCode(...rom.subarray(0x134, 0x144));
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(t);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
export const versionText = v => v ? v.join('.') : 'unknown version';
/* a ROM's LSDj for a label: its version, else what its title says. LSDj before 4.3 write only "LSDJ" in the header
   (no version: lsdj-rom.js identifyRom says the same); a crate card said "LSDj unknown version" (Colin's DJ test) */
export function lsdjLabel(rom) {
  const v = lsdjVersion(rom);
  if (v) return versionText(v);
  const t = String.fromCharCode(...rom.subarray(0x134, 0x144)).replace(/[^\x20-\x7e]/g, ' ').trim();
  return /^LSDJ\b/i.test(t) ? 'before 4.3' : t ? `"${t}"` : 'unknown version';
}
/* Song formats. A song's last byte (0x7FFF) is its format: the LSDj that last saved it writes its own number there
   (libLSDJ FORMAT_VERSION_OFFSET). An LSDj opens songs of its format and older (it upgrades them, writing its
   number), not newer ones: their data is read as its own older layout. Seen: LSDj 9.3.9 writes 22, 5.7.8 writes 4.
   An LSDj's own number is the one it passes to its save-RAM write for 0xBFFF in RAM bank 3 (the format byte of the
   working song): ld a,N; push af; inc sp; ld hl,$BFFF; push hl; ld a,3; push af; inc sp; call (found by trapping
   that write in the emulator: the same code in 5.7.8 and 9.3.9). null: not found (an LSDj written differently). */
export const songFormat = song => song?.length >= 0x8000 ? song[0x7fff] : null;
export function lsdjFormat(rom) {
  for (let i = 0; i + 13 <= rom.length; i++) {
    if (rom[i] !== 0x3e || rom[i + 2] !== 0xf5 || rom[i + 3] !== 0x33 || rom[i + 4] !== 0x21 || rom[i + 5] !== 0xff || rom[i + 6] !== 0xbf ||
        rom[i + 7] !== 0xe5 || rom[i + 8] !== 0x3e || rom[i + 9] !== 0x03 || rom[i + 10] !== 0xf5 || rom[i + 11] !== 0x33 || rom[i + 12] !== 0xcd) continue;
    return rom[i + 1];
  }
  return null;
}
/* the first LSDj that writes each song format, so the oldest that opens a song of it (the dev.18 page): measured with
   lsdjFormat on every LSDj build on littlesounddj.com (671 files; 4.4 to 5.6 write theirs another way, not found).
   A .sav doesn't say which LSDj saved it, only this: "needs LSDj 9.2.1 or newer". */
export const FORMAT_FIRST = {2: '4.2.9', 4: '5.7.0', 5: '6.3.0', 7: '6.8.0', 8: '7.1.0', 9: '7.4.4', 10: '7.9.8', 11: '8.1.0',
  12: '8.6.0', 13: '8.8.0', 14: '8.8.1', 15: '8.8.6', 16: '8.8.8', 17: '8.9.3', 18: '9.0.0', 19: '9.1.0', 20: '9.1.5', 21: '9.2.0', 22: '9.2.1'};
/* the oldest LSDj that opens a song format, as text ("9.2.1"). A format no measured build writes: the next one's
   first LSDj (it opens it); past the table: 'newer' (an LSDj after 9.4.2); null: unknown */
export function firstLsdjFor(format) {
  if (!Number.isInteger(format) || format < 0) return null;
  const known = Object.keys(FORMAT_FIRST).map(Number).sort((a, b) => a - b);
  const next = known.find(k => k >= format);
  return next == null ? 'newer' : FORMAT_FIRST[next];
}
/* the song format an LSDj version writes, from its version alone ([9, 1, 4] -> 20): only from 5.7.0 on (older
   builds were not all found) and up to 9.4.2 (the newest measured); else null */
export function formatOfVersion(v) {
  if (!v || compareVersions(v, [5, 7, 0]) < 0 || compareVersions(v, [9, 4, 2]) > 0) return null;
  let best = null;
  for (const [f, first] of Object.entries(FORMAT_FIRST)) if (compareVersions(v, first.split('.').map(Number)) >= 0) best = Math.max(best ?? 0, +f);
  return best;
}
/* "LSDj 9.2.1 or newer" (null: unknown) */
export function needsText(format) {
  const v = firstLsdjFor(format);
  return v == null ? null : v === 'newer' ? `an LSDj newer than 9.4.2 (song format ${format})` : `LSDj ${v} or newer`;
}
/* whether an LSDj (its format) opens a song (its format): unknown either way counts as yes (nothing to go on) */
export const opens = (lsdjFmt, songFmt) => lsdjFmt == null || songFmt == null || songFmt <= lsdjFmt;
export const compareVersions = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
/* whether this LSDj wants rotated kit frames (9.2.0 and later); unknown versions follow their own kits */
export function wantsRotated(rom) {
  const v = lsdjVersion(rom);
  if (v) return compareVersions(v, [9, 2, 0]) >= 0;
  const kits = kitSlots(rom).filter(s => !s.empty);
  return !kits.length || kits.filter(s => rom[s.bank * BANK + 0x5f] === 1).length * 2 >= kits.length;
}

/* ---- kits ---- */
const word = (b, k) => b[2 * k] | b[2 * k + 1] << 8;
/* the samples of a kit bank in order: [{index, start, end}] (offsets in the bank), up to the first missing one */
function sampleSpans(bank) {
  const out = [];
  for (let k = 0; k < 15; k++) {
    const start = word(bank, k), end = word(bank, k + 1);
    if (!start || !end || end <= start || end > 0x8000) break;
    out.push({index: k, start: start - 0x4000, end: end - 0x4000});
  }
  return out;
}
/* the bytes of a kit that the FM-1 stores (without trailing FF), as lsdj-rom.js counts them */
export function storedLength(bank) {
  let n = BANK;
  while (n > 1 && bank[n - 1] === 0xff) n--;
  return n;
}
/* a kit's identity: the same kit name, sample names and sounds = the same kit, whichever LSDj (rotated or not) */
export function kitKey(bank) {
  const spans = sampleSpans(bank), parts = [bank.subarray(0x22, 0x58)];
  for (const s of spans) parts.push(Uint8Array.of(s.index), kitSampleNibbles(bank, s.index));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
  return crc32(all).toString(16).padStart(8, '0') + ':' + all.length.toString(16);
}
/* bytes a trimmed kit takes, at most (exact: storedLength(trimKit(...))) */
export function trimmedSize(bank, keep) {
  return sampleSpans(bank).reduce((n, s) => n + (keep.has(s.index) ? s.end - s.start : 16), DATA);
}
function encode(nibbles, rotate) {
  const out = new Uint8Array(nibbles.length / 2);
  const pos = (f, p) => rotate ? nibbles[f + (p + 31) % 32] : nibbles[f + p];
  for (let f = 0; f < nibbles.length; f += 32)
    for (let p = 0; p < 32; p += 2) out[(f + p) / 2] = (15 - pos(f, p)) << 4 | (15 - pos(f, p + 1));
  return out;
}
/* A copy of a kit with only the samples in keep (the others one silent frame each), its frames rotated as rotate
   asks. Names and sample numbers stay. */
export function trimKit(bank, keep, rotate) {
  const out = new Uint8Array(BANK).fill(0xff);
  out.set(bank.subarray(0, DATA));
  out.fill(0, 2, 0x22);
  const from = bank[0x5f] === 1;
  let at = DATA;
  out[0] = 0x60; out[1] = 0x40;
  for (const s of sampleSpans(bank)) {
    let data;
    if (!keep.has(s.index)) data = new Uint8Array(16).fill(SILENT);
    else if (from === rotate || (s.end - s.start) % 16) data = bank.subarray(s.start, s.end);
    else data = encode(kitSampleNibbles(bank, s.index), rotate);
    out.set(data, at); at += data.length;
    const end = 0x4000 + at;
    out[2 * (s.index + 1)] = end & 0xff; out[2 * (s.index + 1) + 1] = end >> 8;
  }
  out[0] = 0x60; out[1] = 0x40;
  out[0x5f] = rotate ? 1 : 0;
  return out;
}

/* ---- matching songs to the LSDj they were made with ----
   songs: [{id, name, group, song}] (group: the file it came from); roms: [{id, name, rom}];
   kitFiles: [{id, name, bank}]; choices: {madeWith: {songId: romId}, kitPick: {'songId:kit': 'rom:romId:n' | 'kit:id' | 'none'}}
   -> [{...song, usage, rom (the made-with entry or null), auto, kits: [{number, samples, maybe, source, bank, name, key}],
       missing: [numbers]}] */
export function resolveSongs(songs, roms, kitFiles = [], {madeWith = {}, kitPick = {}} = {}) {
  const list = roms.map(r => ({...r, slots: r.slots ?? kitSlots(r.rom)}));
  const byId = new Map(list.map(r => [r.id, r]));
  const groupBest = new Map();
  for (const g of new Set(songs.map(s => s.group))) {
    const usage = usageAcross(songs.filter(s => s.group === g));
    groupBest.set(g, list.length ? bestRom(list, usage).best : null);
  }
  return songs.map(s => {
    const usage = kitUsage(s.song);
    let rom = byId.get(madeWith[s.id]) ?? null, auto = false;
    if (!rom && list.length) {
      auto = true;
      const {fits} = bestRom(list, usageAcross([s]));
      const g = groupBest.get(s.group), gFit = g && fits.find(f => f.id === g.id);
      rom = gFit && gFit.fit.kits.length === fits[0].fit.kits.length && gFit.fit.empty.length === fits[0].fit.empty.length ? byId.get(g.id) : byId.get(fits[0].id);
    }
    const kits = [], missing = [];
    for (const [number, u] of [...usage.kits].sort((a, b) => a[0] - b[0])) {
      const pick = kitPick[`${s.id}:${number}`];
      let source = null, bank = null;
      if (pick === 'none') source = null;
      else if (pick?.startsWith('kit:')) {
        const f = kitFiles.find(k => k.id === pick.slice(4));
        if (f) { source = {kind: 'kit', id: f.id, label: f.name}; bank = f.bank; }
      } else {
        const [, rid, n] = pick?.startsWith('rom:') ? pick.split(':') : [null, rom?.id, number];
        const r = byId.get(rid), slot = r?.slots[+n];
        if (slot && !slot.empty) { source = {kind: 'rom', id: r.id, number: +n, label: `${r.name} kit ${hex(+n)}`}; bank = r.rom.subarray(slot.bank * BANK, (slot.bank + 1) * BANK); }
      }
      const samples = new Set([...u.samples, ...u.maybe]);
      if (!bank) missing.push(number);
      kits.push({number, samples, maybe: u.maybe, source, bank, name: bank ? parseKit(bank).name : '', key: bank ? kitKey(bank) : null});
    }
    return {...s, usage, rom, auto, kits, missing};
  });
}

/* An .lsdprj's own kits (lsdj-sav.js readLsdprj) -> {map: kit number in the song -> index in kits, rule}. Which kit
   is which number isn't written in the file (unverified, from the files seen): as many kits as the song plays ->
   in the order of their numbers ('played'); more kits, every number the song plays among them -> by number
   ('number'); else the first ones in order, to be checked ('guess'). */
export function projectKits(song, kits) {
  const played = [...kitUsage(song).kits.keys()].sort((a, b) => a - b);
  if (!kits.length || !played.length) return {map: new Map(), rule: 'none'};
  if (kits.length === played.length) return {map: new Map(played.map((n, i) => [n, i])), rule: 'played'};
  if (played.every(n => n < kits.length)) return {map: new Map(played.map(n => [n, n])), rule: 'number'};
  return {map: new Map(played.slice(0, kits.length).map((n, i) => [n, i])), rule: 'guess'};
}

/* ---- planning ---- */
export const blocksOf = song => compressSong(song).length;
/* ctx: {base (the base LSDj), capacity} -> {baseNeeded, slotCount, rotate} */
export function setContext(base, capacity) {
  const cleared = clearedBase(base);
  return {base, capacity, rotate: wantsRotated(base), slotCount: kitSlots(base).length,
    baseNeeded: planRom(cleared, [], capacity).needed};
}
function clearedBase(base) {
  const rom = base.slice();
  for (const s of kitSlots(base)) rom.fill(0xff, s.bank * BANK, (s.bank + 1) * BANK);
  return rom;
}
/* the kits of some songs: key -> {bank, name, samples (union), songs, numbers (their numbers in the songs)} */
function kitsOf(entries) {
  const m = new Map();
  for (const e of entries) for (const k of e.kits) {
    if (!k.key) continue;
    if (!m.has(k.key)) m.set(k.key, {key: k.key, bank: k.bank, name: k.name, source: k.source, samples: new Set(), songs: new Set(), numbers: []});
    const x = m.get(k.key);
    k.samples.forEach(i => x.samples.add(i)); x.songs.add(e.id); x.numbers.push(k.number);
  }
  return m;
}
const kitCost = k => 8 + trimmedSize(k.bank, k.samples);
function measure(entries, ctx) {
  const kits = kitsOf(entries);
  let bytes = ctx.baseNeeded;
  for (const k of kits.values()) bytes += kitCost(k);
  return {kits, bytes, blocks: entries.reduce((n, e) => n + e.blocks, 0), songs: entries.length};
}
const fitsIn = (m, ctx) => m.bytes <= ctx.capacity && m.kits.size <= ctx.slotCount && m.songs <= SLOTS && m.blocks <= BLOCK_COUNT;
const withBlocks = resolved => resolved.map(e => ({...e, blocks: e.blocks ?? blocksOf(e.song)}));

/* Every song with all its samples, in as few sets as it takes (songs that share kits go together). A song too big
   for one set by itself gets its own set, with its most-played kits (planMost). -> [{entries, ...measure, lost}] */
export function planSplit(resolved, ctx) {
  const all = withBlocks(resolved);
  const alone = new Map(all.map(e => [e.id, measure([e], ctx).bytes]));
  const order = [...all].sort((a, b) => alone.get(b.id) - alone.get(a.id));
  const sets = [];
  for (const e of order) {
    let best = null, bestAdd = Infinity;
    for (const s of sets) {
      if (s.over) continue;
      const m = measure([...s.entries, e], ctx);
      if (fitsIn(m, ctx) && m.bytes - s.bytes < bestAdd) { best = s; bestAdd = m.bytes - s.bytes; }
    }
    if (best) Object.assign(best, measure(best.entries = [...best.entries, e], ctx));
    else {
      const m = measure([e], ctx);
      sets.push({entries: [e], ...m, over: !fitsIn(m, ctx)});
    }
  }
  const place = new Map(all.map((e, i) => [e.id, i]));
  for (const s of sets) s.entries.sort((a, b) => place.get(a.id) - place.get(b.id));
  return sets.map(s => s.over ? {...planMost(s.entries, ctx), over: true} : {...s, lost: [], leftOut: []});
}

/* One set: the songs that fit the .sav (in order), and the kits most songs play until the LSDj is full.
   -> {entries, kits, bytes, blocks, lost: [{song, kit, name, samples}], leftOut: [entries]} */
export function planMost(resolved, ctx) {
  const all = withBlocks(resolved), entries = [], leftOut = [];
  let blocks = 0;
  for (const e of all) {
    if (entries.length < SLOTS && blocks + e.blocks <= BLOCK_COUNT) { entries.push(e); blocks += e.blocks; }
    else leftOut.push(e);
  }
  const every = kitsOf(entries);
  const ranked = [...every.values()].sort((a, b) => b.songs.size - a.songs.size || b.samples.size - a.samples.size || kitCost(a) - kitCost(b));
  const kits = new Map();
  let bytes = ctx.baseNeeded;
  for (const k of ranked) {
    if (kits.size < ctx.slotCount && bytes + kitCost(k) <= ctx.capacity) { kits.set(k.key, k); bytes += kitCost(k); }
  }
  const lost = [];
  for (const e of entries) for (const k of e.kits) if (k.key && !kits.has(k.key))
    lost.push({song: e.name, kit: k.number, name: k.name, samples: [...k.samples].sort((a, b) => a - b)});
  return {entries, kits, bytes, blocks, songs: entries.length, lost, leftOut};
}

/* ---- building ---- */
/* points a song's kit instruments at new numbers; kits not in map go to fallback (an empty slot) when given */
export function renumberSong(song, map, fallback = null) {
  const out = song.slice();
  for (let i = 0; i < 64; i++) {
    const at = INSTR + i * 16;
    if (out[at] !== KIT) continue;
    for (const off of [2, 9]) {
      const n = out[at + off] & 0x3f, to = map.has(n) ? map.get(n) : fallback;
      if (to != null) out[at + off] = (out[at + off] & 0xc0) | to;
    }
  }
  return out;
}
const blankSav = () => { const s = new Uint8Array(SAV_SIZE); s[0x813e] = 0x6a; s[0x813f] = 0x6b; return s; };

/* plan (planSplit/planMost item) -> {rom, sav, plan (lsdj-rom planRom), kits: [{number, name, source, kept, dropped,
   bytes}], songs: [{name, lost}], warnings}. template: a .sav whose LSDj settings to keep (else a blank one). */
export function buildSet(plan, ctx, template = null) {
  const base = ctx.base, slots = kitSlots(base);
  const rom = clearedBase(base);
  const used = new Map();   /* number -> kit */
  const kits = [...plan.kits.values()];
  const wanted = k => { const c = new Map(); k.numbers.forEach(n => c.set(n, (c.get(n) ?? 0) + 1)); return [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(x => x[0]); };
  const later = [];
  for (const k of kits) {
    const n = wanted(k).find(n => n < slots.length && !used.has(n));
    if (n == null) later.push(k); else used.set(n, k);
  }
  for (const k of later) {
    const n = slots.findIndex((_, i) => !used.has(i));
    if (n < 0) throw Error('More kits than this LSDj has kit slots.');
    used.set(n, k);
  }
  const numberOf = new Map([...used].map(([n, k]) => [k.key, n]));
  const out = [];
  for (const [n, k] of used) {
    const bank = trimKit(k.bank, k.samples, ctx.rotate);
    rom.set(bank, slots[n].bank * BANK);
    const all = sampleSpans(k.bank).map(s => s.index);
    out.push({number: n, name: k.name, source: k.source?.label ?? '', kept: all.filter(i => k.samples.has(i)),
      dropped: all.filter(i => !k.samples.has(i)), names: parseKit(k.bank).samples, bytes: storedLength(bank)});
  }
  fixChecksums(rom);
  const free = slots.findIndex((_, i) => !used.has(i));
  const songs = plan.entries.map(e => {
    const map = new Map();
    for (const k of e.kits) if (k.key && numberOf.has(k.key)) map.set(k.number, numberOf.get(k.key));
    return {name: e.name, nameBytes: e.nameBytes ?? nameBytes(e.name), version: e.version ?? 0,
      song: renumberSong(e.song, map, free >= 0 ? free : null)};
  });
  const sav = buildSav(template ?? blankSav(), songs[0]?.song ?? new Uint8Array(0x8000), songs, songs.length ? 0 : null);
  const check = planRom(rom, [...used.keys()].map(n => slots[n].bank), ctx.capacity);
  const warnings = [];
  const baseV = lsdjVersion(base);
  for (const e of plan.entries) {
    const v = e.rom && lsdjVersion(e.rom.rom);
    if (v && baseV && compareVersions(v, baseV) > 0)
      warnings.push(`${e.name} matches LSDj ${versionText(v)}; this set's LSDj is ${versionText(baseV)} (older), which may not open it.`);
    for (const n of e.missing) warnings.push(`${e.name}: kit ${hex(n)} wasn't found in your LSDj files, so its notes are silent.`);
  }
  if (free < 0 && plan.lost?.length) warnings.push('No empty kit slot left: notes on left-out kits play whatever kit has that number.');
  if (!check.fits) warnings.push(`Too big for the FM-1: ${Math.ceil(check.needed / 1024)} of ${Math.floor(ctx.capacity / 1024)} KiB.`);
  return {rom, sav, plan: check, kits: out.sort((a, b) => a.number - b.number),
    songs: plan.entries.map(e => ({name: e.name, lost: (plan.lost ?? []).filter(l => l.song === e.name)})), warnings};
}

/* ---- the report (text and CSV) ---- */
const sampleName = (k, i) => (k.names.find(s => s.index === i)?.name ?? '').replace(/-+$/, '') || `#${i + 1}`;
export function setReport(built, title, ctx) {
  const L = [title, '='.repeat(title.length), ''];
  L.push(`LSDj: ${versionText(lsdjVersion(ctx.base))}; ${Math.ceil(built.plan.needed / 1024)} of ${Math.floor(ctx.capacity / 1024)} KiB on the FM-1.`, '');
  L.push('Songs:'); for (const s of built.songs) L.push(`  ${s.name}` + (s.lost.length ? ` (loses ${s.lost.map(l => `kit ${hex(l.kit)} ${l.name}`).join(', ')})` : ''));
  L.push('', 'Kits:');
  for (const k of built.kits) L.push(`  ${hex(k.number)} ${k.name.padEnd(6)} from ${k.source}: ${k.kept.map(i => sampleName(k, i)).join(' ') || 'none'}` +
    (k.dropped.length ? `  (left out, not played: ${k.dropped.map(i => sampleName(k, i)).join(' ')})` : ''));
  if (built.warnings.length) { L.push('', 'Notes:'); built.warnings.forEach(w => L.push('  ' + w)); }
  return L.join('\n') + '\n';
}
export function setCsv(built, title) {
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['set', 'kit', 'kit name', 'from', 'sample', 'sample name', 'kept']];
  for (const k of built.kits) for (const i of [...k.kept, ...k.dropped].sort((a, b) => a - b))
    rows.push([title, hex(k.number), k.name, k.source, i + 1, sampleName(k, i), k.kept.includes(i) ? 'yes' : 'no (not played)']);
  return rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}
