// SPDX-License-Identifier: GPL-3.0-only
// lsdj/lsdj-sav.js: LSDj saves and .lsdsng songs, with made-up songs only (node tests/lsdj-sav.mjs).
import assert from 'node:assert/strict';
import {parseSav, savHeader, HEADER, HEADER_SIZE, songBytes, compressSong, buildSav, songsOf, readLsdsng, writeLsdsng, lsdsngOf, nameBytes, nameText, splitSav,
  SavError, SAV_SIZE, SONG_SIZE, BLOCK_SIZE, BLOCK_COUNT, DEFAULT_WAVE, DEFAULT_INSTRUMENT} from '../lsdj/lsdj-sav.js';

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
/* a song with everything the compressor treats specially */
function song(kind = 0) {
  const s = new Uint8Array(SONG_SIZE); seed = 100 + kind;
  for (let i = 0; i < SONG_SIZE; i++) s[i] = kind === 1 ? rnd() : (i % 97 === 0 ? rnd() : 0);
  for (let k = 0; k < 40; k++) s.set(DEFAULT_INSTRUMENT, 0x3080 + 16 * k);
  for (let k = 0; k < 300; k++) s.set(DEFAULT_WAVE, 0x6000 + 16 * k);
  s.fill(0xc0, 0x100, 0x140);                 /* a run of C0 (C0 C0 is one C0) */
  s.fill(0xe0, 0x200, 0x240);                 /* a run of E0 */
  s.set([0xc0, 1, 0xe0, 0xf0, 0xe0, 0xf1, 0xe0, 0xff, 0xc0, 0xc0, 0xc0], 0x300);
  s.set([0x72, 0x62], 0x1e78); s.set([0x72, 0x62], 0x3e80); s.set([0x72, 0x62], 0x7ff0);
  s[0x7fff] = 3 + kind;
  return s;
}
const blank = () => { const b = new Uint8Array(SAV_SIZE); b[0x813e] = 0x6a; b[0x813f] = 0x6b; b[0x8140] = 0xff; b.fill(0xff, 0x8141, 0x8141 + BLOCK_COUNT); return b; };

/* names */
assert.deepEqual([...nameBytes('my song!')], [...'MY SONG', 0].map(c => typeof c === 'string' ? c.charCodeAt(0) : c));
assert.equal(nameText(nameBytes('abcdefghijk')), 'ABCDEFGH');
assert.throws(() => nameBytes('!!'), SavError);

/* compress: blocks of 0x200, chained 1-based from first, the last ends E0 FF; round trip exact */
for (const kind of [0, 1]) {
  const s = song(kind), blocks = compressSong(s, 5);
  assert.ok(blocks.every(b => b.length === BLOCK_SIZE));
  const lsdsng = writeLsdsng({name: 'TEST', version: 7, song: s});
  const back = readLsdsng(lsdsng);
  assert.equal(back.name, 'TEST'); assert.equal(back.version, 7); assert.deepEqual(back.song, s);
}
assert.throws(() => compressSong(new Uint8Array(10)), SavError);

/* a save: songs in their slots, the working song kept, the block table and names right; rebuilt the same */
{
  const songs = [{slot: 3, name: 'ALPHA', version: 2, song: song(0)}, {slot: 0, name: 'BETA', version: 9, song: song(2)}];
  const working = song(3);
  const bytes = buildSav(blank(), working, songs, 3);
  const sav = parseSav(bytes);
  assert.deepEqual(sav.songs.map(s => [s.slot, s.name, s.version]), [[0, 'BETA', 9], [3, 'ALPHA', 2]]);
  assert.equal(sav.active, 3);
  assert.deepEqual(sav.working, working);
  assert.deepEqual(songBytes(sav, 3), songs[0].song); assert.deepEqual(songBytes(sav, 0), songs[1].song);
  const used = sav.songs.reduce((n, s) => n + s.blocks, 0);
  assert.equal(sav.freeBlocks, BLOCK_COUNT - used);
  /* the header alone (a DJ deck reads it from the FM-1): the same songs, open song and free blocks */
  const head = savHeader(bytes.slice(HEADER, HEADER + HEADER_SIZE));
  assert.deepEqual(head, {active: sav.active, songs: sav.songs.map(({slot, name, version, blocks}) => ({slot, name, version, blocks})), freeBlocks: sav.freeBlocks});
  assert.equal(HEADER_SIZE, 512); assert.equal(savHeader(new Uint8Array(512)), null);
  assert.deepEqual(readLsdsng(lsdsngOf(sav, 3)).song, songs[0].song);
  /* rename, delete, add: build again from the list */
  const list = songsOf(sav);
  list.find(s => s.slot === 0).nameBytes = nameBytes('GAMMA');
  const again = parseSav(buildSav(bytes, sav.working, [...list.filter(s => s.slot !== 3), {name: 'NEW', song: song(4)}], 3));
  assert.deepEqual(again.songs.map(s => [s.slot, s.name]), [[0, 'GAMMA'], [1, 'NEW']]);
  assert.equal(again.active, null);                       /* the open song was deleted */
  assert.deepEqual(songBytes(again, 1), song(4));
}

/* too many blocks: refused, saying which song; more than 32 songs refused */
{
  seed = 7;
  const noisy = () => ({name: 'NOISE', song: song(1)});
  const one = compressSong(song(1)).length;
  const n = Math.floor(BLOCK_COUNT / one) + 1;
  assert.throws(() => buildSav(blank(), song(0), Array.from({length: n}, noisy), null), /don't fit: NOISE/);
  assert.throws(() => buildSav(blank(), song(0), Array.from({length: 33}, () => ({name: 'X', song: song(0)})), null), SavError);
}

/* not a save; damaged songs */
assert.throws(() => parseSav(new Uint8Array(100)), SavError);
assert.throws(() => parseSav(new Uint8Array(SAV_SIZE)), /not an LSDj save/);
{
  const bytes = buildSav(blank(), song(0), [{slot: 0, name: 'A', song: song(0)}], null);
  const sav = parseSav(bytes);
  const at = 0x8200 + (sav.songs[0].blocks - 1) * BLOCK_SIZE;   /* the last block: cut its end marker */
  const last = bytes.subarray(at, at + BLOCK_SIZE);
  const end = last.findIndex((b, i) => b === 0xe0 && last[i + 1] === 0xff && last.subarray(i + 2).every(x => !x));
  last[end + 1] = 0x40;                                    /* a jump to a block that isn't there */
  assert.throws(() => songBytes(parseSav(bytes), 0), SavError);
  assert.throws(() => readLsdsng(new Uint8Array(5)), SavError);
}

/* one song per save: each alone in slot 0, open, its name and version kept; the source untouched */
{
  const songs = [{slot: 3, name: 'ALPHA', version: 2, song: song(0)}, {slot: 0, name: 'BETA', version: 9, song: song(2)}, {slot: 7, name: 'GAMMA', version: 4, song: song(1)}];
  const src = buildSav(blank(), song(1), songs, 3), before = src.slice();
  const parts = splitSav(src);
  assert.deepEqual(parts.map(p => p.name), ['BETA', 'ALPHA', 'GAMMA']);
  for (const p of parts) {
    const one = parseSav(p.bytes), want = songs.find(s => s.name === p.name);
    assert.equal(one.songs.length, 1); assert.equal(one.songs[0].slot, 0); assert.equal(one.songs[0].name, want.name);
    assert.equal(one.songs[0].version, want.version);
    assert.deepEqual(songBytes(one, 0), want.song, `${p.name}: the same song`);
    assert.equal(one.active, 0, 'open, so LSDj starts on it');
    assert.deepEqual(one.working, want.song, 'it is the working song');
  }
  assert.deepEqual(src, before, 'the save split is unchanged');
  assert.equal(splitSav(new Uint8Array([...src, ...new Uint8Array(16)])).length, 3, 'a save with a 16-byte footer too');
}

console.log('PASS lsdj-sav: one song per save, names, the header alone (savHeader), compress round trip (defaults, C0/E0 runs, blocks), saves built and read, rename/delete/add, too big, damaged');
