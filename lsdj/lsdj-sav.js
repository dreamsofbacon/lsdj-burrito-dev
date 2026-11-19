// SPDX-License-Identifier: GPL-3.0-only
// LSDj save files (.sav, 128 KiB) and single songs (.lsdsng), read and written in the browser. Pure: no DOM.
// Layout and compression as in libLSDJ (sav.c, compression.c, project.c):
//   0x0000-0x7FFF  the working song (the one LSDj has open), uncompressed
//   0x8000         song names, 32 x 8 characters      0x8100  a save counter per song ("version")
//   0x813E         'jk' (LSDj has set the save up)    0x8140  the song open in LSDj (FF: none)
//   0x8141         block table, 191 bytes: the song slot each block belongs to, FF = free
//   0x8200         191 blocks of 0x200 bytes holding the songs, compressed:
//     C0 v n  v n times     C0 C0  one C0       E0 E0  one E0
//     E0 F0 n the default wave n times          E0 F1 n  the default instrument n times
//     E0 b    carry on in block b (1-based)     E0 FF    end of the song
// A song is 0x8000 bytes uncompressed. .lsdsng: name (8), version (1), then the song's blocks.
export const SAV_SIZE = 0x20000;
export const SONG_SIZE = 0x8000;
export const BLOCK_SIZE = 0x200;
export const BLOCK_COUNT = 191;
export const SLOTS = 32;
const NAMES = 0x8000, VERSIONS = 0x8100, INIT = 0x813e, ACTIVE = 0x8140, TABLE = 0x8141, BLOCKS = 0x8200;
const FREE = 0xff;
export const DEFAULT_WAVE = Uint8Array.of(0x8e, 0xcd, 0xcc, 0xbb, 0xaa, 0xa9, 0x99, 0x88, 0x87, 0x76, 0x66, 0x55, 0x54, 0x43, 0x32, 0x31);
export const DEFAULT_INSTRUMENT = Uint8Array.of(0xa8, 0, 0, 0xff, 0, 0, 3, 0, 0, 0xd0, 0, 0, 0, 0xf3, 0, 0);

export class SavError extends Error {}

/* LSDj's name characters as text: A-Z, 0-9, space, and 'x' for the rest LSDj can type (shown as it is). */
export function nameText(bytes) {
  let s = '';
  for (const b of bytes) { if (!b) break; s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?'; }
  return s.trimEnd();
}
/* A name typed on the page: up to 8 of A-Z, 0-9, space and x (LSDj's own name characters). */
export function nameBytes(text) {
  const t = String(text).toUpperCase().replace(/[^A-Z0-9 X]/g, '').slice(0, 8).trimEnd();
  if (!t) throw new SavError('A song name needs at least one letter or number.');
  const out = new Uint8Array(8);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
}

/* One compressed song from src starting at pos -> 0x8000 bytes. next(b): where block b (1-based) starts, or
   null for a stream with its blocks one after another (.lsdsng). Returns {song, blocks: [block numbers]}. */
function decompress(src, pos, next) {
  const song = new Uint8Array(SONG_SIZE);
  let o = 0, blockStart = pos;
  const blocks = [];
  const put = (b, n = 1) => {
    if (o + n > SONG_SIZE) throw new SavError('A song in this file is damaged (too long).');
    song.fill(b, o, o + n); o += n;
  };
  const putAll = (p, n) => {
    for (let k = 0; k < n; k++) { if (o + 16 > SONG_SIZE) throw new SavError('A song in this file is damaged (too long).'); song.set(p, o); o += 16; }
  };
  const byte = () => {
    if (pos >= src.length) throw new SavError('A song in this file is damaged (it runs past the end).');
    return src[pos++];
  };
  for (let guard = 0; guard < 0x40000; guard++) {
    const b = byte();
    if (b === 0xc0) {
      const v = byte();
      if (v === 0xc0) put(0xc0); else put(v, byte());
    } else if (b === 0xe0) {
      const x = byte();
      if (x === 0xe0) put(0xe0);
      else if (x === 0xf0) putAll(DEFAULT_WAVE, byte());
      else if (x === 0xf1) putAll(DEFAULT_INSTRUMENT, byte());
      else if (x === 0xff) {
        if (o !== SONG_SIZE) throw new SavError('A song in this file is damaged (too short).');
        return {song, blocks};
      } else {
        blocks.push(x);
        if (next) { const at = next(x); if (at === null) throw new SavError('A song in this file is damaged (a missing block).'); pos = blockStart = at; }
        else pos = blockStart = blockStart + BLOCK_SIZE;
      }
    } else put(b);
  }
  throw new SavError('A song in this file is damaged.');
}

/* A song (0x8000 bytes) -> compressed blocks, numbered from first (1-based) on. Greedy, as libLSDJ. */
export function compressSong(song, first = 1) {
  if (!(song instanceof Uint8Array) || song.length !== SONG_SIZE) throw new SavError('A song is 32 KiB.');
  const blocks = [];
  let block = [], i = 0, number = first;
  const same16 = (p, at) => { for (let k = 0; k < 16; k++) if (song[at + k] !== p[k]) return false; return true; };
  const flush = (tail) => {
    const b = new Uint8Array(BLOCK_SIZE); b.set([...block, ...tail]); blocks.push(b); block = [];
  };
  const emit = (ev) => {
    if (block.length + ev.length + 2 >= BLOCK_SIZE) { number++; flush([0xe0, number]); }
    block.push(...ev);
  };
  while (i < SONG_SIZE) {
    let n = 0;
    while (n < 255 && i + 16 * (n + 1) <= SONG_SIZE && same16(DEFAULT_WAVE, i + 16 * n)) n++;
    if (n) { emit([0xe0, 0xf0, n]); i += 16 * n; continue; }
    while (n < 255 && i + 16 * (n + 1) <= SONG_SIZE && same16(DEFAULT_INSTRUMENT, i + 16 * n)) n++;
    if (n) { emit([0xe0, 0xf1, n]); i += 16 * n; continue; }
    const v = song[i];
    let run = 1;
    while (run < 255 && i + run < SONG_SIZE && song[i + run] === v) run++;
    if (run >= 4 && v !== 0xc0) { emit([0xc0, v, run]); i += run; continue; }   /* (C0 C0 is one C0: no runs of C0) */
    emit(v === 0xc0 ? [0xc0, 0xc0] : v === 0xe0 ? [0xe0, 0xe0] : [v]);
    i++;
  }
  flush([0xe0, 0xff]);
  return blocks;
}

/* A save as some emulators and flash carts write it: the 128 KiB and a 16-byte footer after it (a clock: its first
   4 bytes read as a date). The footer is not LSDj's: the save is the first 128 KiB. Anything else as it came. */
export const SAV_FOOTER = 16;
export const savBody = bytes => bytes instanceof Uint8Array && bytes.length === SAV_SIZE + SAV_FOOTER ? bytes.subarray(0, SAV_SIZE) : bytes;
/* A .sav (or one with that footer) -> {bytes (the 128 KiB), working, active, songs: [{slot, name, version, blocks}],
   freeBlocks}. Songs are decompressed on demand (songBytes). Throws SavError for something that is not an LSDj save. */
export function parseSav(bytes) {
  bytes = savBody(bytes);
  if (!(bytes instanceof Uint8Array) || bytes.length !== SAV_SIZE) throw new SavError(`An LSDj save is 128 KiB (${SAV_SIZE} bytes).`);
  if (bytes[INIT] !== 0x6a || bytes[INIT + 1] !== 0x6b) throw new SavError('This is not an LSDj save (LSDj has not set it up).');
  const table = bytes.subarray(TABLE, TABLE + BLOCK_COUNT);
  const songs = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const first = table.indexOf(slot);
    if (first < 0) continue;
    songs.push({slot, name: nameText(bytes.subarray(NAMES + slot * 8, NAMES + slot * 8 + 8)), version: bytes[VERSIONS + slot],
      blocks: table.reduce((n, s) => n + (s === slot), 0), first});
  }
  const active = bytes[ACTIVE];
  return {bytes, working: bytes.subarray(0, SONG_SIZE), active: active < SLOTS ? active : null, songs,
    freeBlocks: table.reduce((n, s) => n + (s === FREE), 0)};
}

/* The save's header alone: its HEADER_SIZE bytes from HEADER (names, versions, the open song, the block table), as a
   DJ deck reads it from the FM-1 (lsdj/dj-ui.js) -> {active, songs: [{slot, name, version, blocks}], freeBlocks}
   as parseSav gives them, or null when LSDj has not set the save up. */
export const HEADER = NAMES, HEADER_SIZE = BLOCKS - NAMES;
export function savHeader(head) {
  if (!(head instanceof Uint8Array) || head.length < HEADER_SIZE) return null;
  const at = a => a - HEADER;
  if (head[at(INIT)] !== 0x6a || head[at(INIT) + 1] !== 0x6b) return null;
  const table = head.subarray(at(TABLE), at(TABLE) + BLOCK_COUNT), songs = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const blocks = table.reduce((n, s) => n + (s === slot), 0);
    if (blocks) songs.push({slot, name: nameText(head.subarray(slot * 8, slot * 8 + 8)), version: head[at(VERSIONS) + slot], blocks});
  }
  const active = head[at(ACTIVE)];
  return {active: active < SLOTS ? active : null, songs, freeBlocks: table.reduce((n, s) => n + (s === FREE), 0)};
}

/* The song in slot (0..31), decompressed. */
export function songBytes(sav, slot) {
  const s = sav.songs.find(x => x.slot === slot);
  if (!s) throw new SavError(`No song in slot ${slot}.`);
  return decompress(sav.bytes, BLOCKS + s.first * BLOCK_SIZE, b => (b >= 1 && b <= BLOCK_COUNT ? BLOCKS + (b - 1) * BLOCK_SIZE : null)).song;
}

/* A copy of a save with the song in slot as the one open: LSDj starts on its working song, so that song goes into
   the working area and the open slot is set (the DJ crate: load a deck straight into a chosen song). The saved
   songs are unchanged. */
export function withOpenSong(bytes, slot) {
  const sav = parseSav(bytes), out = bytes.slice();
  out.set(songBytes(sav, slot), 0);
  out[ACTIVE] = slot;
  return out;
}

/* .lsdsng -> {name, version, song}. */
export function readLsdsng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 9 + 3) throw new SavError('This is not an .lsdsng song file.');
  return {name: nameText(bytes.subarray(0, 8)), nameBytes: bytes.slice(0, 8), version: bytes[8], song: decompress(bytes, 9, null).song};
}
/* .lsdprj, a song with its kits -> {name, nameBytes, version, song, kits: [16 KiB kit banks]}. The .lsdsng layout (an
   8-byte name, a version byte, 512-byte song blocks), then the song's kits as whole 16 KiB banks to the end of the
   file (seen in 27 projects: 0 to 32 kits, never anything after them). The kits start at the first block from which
   every 16 KiB to the end is a kit bank (60 40), not at an offset worked out from the size (32 song blocks are 16 KiB
   too). */
const PRJ_KIT = 0x4000, isKitAt = (b, o) => b[o] === 0x60 && b[o + 1] === 0x40;
export function readLsdprj(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 9 + BLOCK_SIZE || (bytes.length - 9) % BLOCK_SIZE)
    throw new SavError('This is not an .lsdprj project file.');
  let at = bytes.length;
  for (let o = 9 + BLOCK_SIZE; o + PRJ_KIT <= bytes.length; o += BLOCK_SIZE) {
    if ((bytes.length - o) % PRJ_KIT) continue;
    let all = true;
    for (let k = o; k < bytes.length; k += PRJ_KIT) if (!isKitAt(bytes, k)) { all = false; break; }
    if (all) { at = o; break; }
  }
  const s = readLsdsng(bytes.subarray(0, at)), kits = [];
  for (let k = at; k < bytes.length; k += PRJ_KIT) kits.push(bytes.slice(k, k + PRJ_KIT));
  return {...s, kits};
}
/* {nameBytes or name, version, song} -> .lsdsng bytes. */
export function writeLsdsng({name, nameBytes: nb, version = 0, song}) {
  const blocks = compressSong(song, 1);
  const out = new Uint8Array(9 + blocks.length * BLOCK_SIZE);
  out.set(nb ?? nameBytes(name), 0); out[8] = version & 0xff;
  blocks.forEach((b, k) => out.set(b, 9 + k * BLOCK_SIZE));
  return out;
}
export const lsdsngOf = (sav, slot) => {
  const s = sav.songs.find(x => x.slot === slot);
  return writeLsdsng({nameBytes: sav.bytes.slice(NAMES + slot * 8, NAMES + slot * 8 + 8), version: s.version, song: songBytes(sav, slot)});
};

/* A new save from the working song and a list of songs [{slot, nameBytes, version, song}] (slot kept when
   given, else the first free). Every song is compressed again into fresh blocks. Throws SavError when the
   songs don't fit (191 blocks) or there are more than 32. active: the open song's slot, or null. */
export function buildSav(template, working, songs, active) {
  if (songs.length > SLOTS) throw new SavError(`A save holds at most ${SLOTS} songs.`);
  const out = new Uint8Array(SAV_SIZE);
  out.set(template.subarray(0, BLOCKS));            /* keeps LSDj's reserved header bytes */
  out.set(working, 0);
  out.fill(0, NAMES, NAMES + 0x100); out.fill(0, VERSIONS, VERSIONS + SLOTS);
  out.fill(FREE, TABLE, TABLE + BLOCK_COUNT);
  out[INIT] = 0x6a; out[INIT + 1] = 0x6b;
  const used = new Set(songs.filter(s => s.slot != null).map(s => s.slot));
  if (used.size !== songs.filter(s => s.slot != null).length) throw new SavError('Two songs in the same slot.');
  let block = 0;
  for (const s of songs) {
    let slot = s.slot;
    if (slot == null) { slot = 0; while (used.has(slot)) slot++; used.add(slot); }
    const blocks = compressSong(s.song, block + 1);
    if (block + blocks.length > BLOCK_COUNT)
      throw new SavError(`The songs don't fit: ${s.name ?? nameText(s.nameBytes)} needs ${blocks.length} blocks and only ${BLOCK_COUNT - block} are free.`);
    out.set(s.nameBytes ?? nameBytes(s.name), NAMES + slot * 8);
    out[VERSIONS + slot] = s.version ?? 0;
    blocks.forEach((b, k) => { out.set(b, BLOCKS + (block + k) * BLOCK_SIZE); out[TABLE + block + k] = slot; });
    block += blocks.length;
  }
  out[ACTIVE] = active != null && used.has(active) ? active : FREE;
  return out;
}

/* The songs of a parsed save as buildSav takes them. */
export const songsOf = sav => sav.songs.map(s => ({slot: s.slot, nameBytes: sav.bytes.slice(NAMES + s.slot * 8, NAMES + s.slot * 8 + 8),
  version: s.version, song: songBytes(sav, s.slot)}));

/* One save per song: each a copy of the save (its settings, header bytes) holding only that song, in slot 0, and
   open (the working song), so LSDj starts on it: a DJ crate card a song, or a song to hand someone. Damaged songs
   are left out. -> [{slot, name, bytes}] */
export function splitSav(bytes) {
  const sav = parseSav(savBody(bytes)), out = [];
  for (const s of sav.songs) {
    let song;
    try { song = songBytes(sav, s.slot); } catch (e) { if (e instanceof SavError) continue; throw e; }
    const nb = sav.bytes.slice(NAMES + s.slot * 8, NAMES + s.slot * 8 + 8);
    out.push({slot: s.slot, name: s.name || `SLOT ${s.slot}`, bytes: buildSav(sav.bytes, song, [{slot: 0, nameBytes: nb, version: s.version, song}], 0)});
  }
  return out;
}
