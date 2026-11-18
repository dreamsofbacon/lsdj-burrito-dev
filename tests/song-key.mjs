// SPDX-License-Identifier: GPL-3.0-only
// lsdj/song-key.js: a song's key from its notes, with made-up songs (node tests/song-key.mjs).
import assert from 'node:assert/strict';
import {pitchClasses, keyOf, songKeys, camelot, PARTS, readOffsets} from '../lsdj/song-key.js';

/* LSDj note value of a pitch class (0 = C) in octave 4 (1 = C3: 0x55 shows as C 9) */
const N = (pc, oct = 4) => 1 + (oct - 3) * 12 + pc;
/* a song: phrases {p: [notes, one a step, 0 = none]}, chains {c: [[phrase, transpose]...]}, rows: [[ch0, ch1, ch2, ch3] chains],
   instruments {i: type} (0 pulse, 1 wave, 2 kit, 3 noise), each phrase played by instrument ins[p] (default 0) */
function song({phrases, chains, rows, instruments = {0: 0}, ins = {}}) {
  const s = new Uint8Array(0x8000);
  s.fill(0xff, 0x1290, 0x1290 + 1024); s.fill(0xff, 0x2080, 0x2080 + 2048); s.fill(0xff, 0x7000, 0x7000 + 0xff0);
  for (const [i, t] of Object.entries(instruments)) s[0x3080 + i * 16] = t;
  for (const [p, notes] of Object.entries(phrases)) { notes.forEach((n, k) => { s[p * 16 + k] = n; }); s[0x7000 + p * 16] = ins[p] ?? 0; }
  for (const [c, steps] of Object.entries(chains)) steps.forEach(([p, t = 0], k) => { s[0x2080 + c * 16 + k] = p; s[0x2880 + c * 16 + k] = t & 255; });
  rows.forEach((r, row) => r.forEach((c, ch) => { if (c != null) s[0x1290 + row * 4 + ch] = c; }));
  return s;
}
/* a C major tune (C E G C, F A C, G B D, C) and an A minor one (A C E A, D F A, E G# B, A) */
const cMajor = [N(0), 0, N(4), 0, N(7), 0, N(0, 5), 0, N(5), 0, N(9), 0, N(7), N(11), N(2, 5), N(0)];
const aMinor = [N(9), 0, N(0, 5), 0, N(4, 5), 0, N(9), 0, N(2, 5), 0, N(5, 5), 0, N(4, 5), N(8, 5), N(11, 5), N(9)];

{ /* C major; A minor; the same tune a whole tone up by the chain's transpose: D major */
  const c = keyOf(pitchClasses(song({phrases: {0: cMajor}, chains: {0: [[0]]}, rows: [[0]]})));
  assert.equal(c.name, 'C'); assert.equal(c.long, 'C major'); assert.equal(c.camelot, '8B');
  const a = keyOf(pitchClasses(song({phrases: {0: aMinor}, chains: {0: [[0]]}, rows: [[0]]})));
  assert.equal(a.name, 'Am'); assert.equal(a.camelot, '8A');
  const d = keyOf(pitchClasses(song({phrases: {0: cMajor}, chains: {0: [[0, 2]]}, rows: [[0]]})));
  assert.equal(d.name, 'D'); assert.equal(d.camelot, '10B');
  const down = keyOf(pitchClasses(song({phrases: {0: cMajor}, chains: {0: [[0, -1]]}, rows: [[0]]})));   /* FF: one down, B major */
  assert.equal(down.name, 'B');
}
{ /* drums don't count: a kit or noise instrument's notes, even on a pitched channel */
  const s = song({phrases: {0: cMajor, 1: aMinor.map(n => n && N(1))}, chains: {0: [[0]], 1: [[1], [1], [1]]}, rows: [[0, 1]], instruments: {0: 0, 1: 2}, ins: {1: 1}});
  assert.equal(keyOf(pitchClasses(s)).name, 'C');
}
{ /* weight: a chain on more rows counts more; a note lasts to the next */
  const s = song({phrases: {0: cMajor, 1: aMinor}, chains: {0: [[0]], 1: [[1]]}, rows: [[0], [1], [1], [1]]});
  assert.equal(keyOf(pitchClasses(s)).name, 'Am');
  const held = pitchClasses(song({phrases: {0: [N(7), 0, 0, 0, N(0)]}, chains: {0: [[0]]}, rows: [[0]]}));
  assert.equal(held[7], 4); assert.equal(held[0], 12);
}
{ /* too few notes: no key; the part playing now */
  assert.equal(keyOf(pitchClasses(song({phrases: {0: [N(0)]}, chains: {0: [[0]]}, rows: [[0]]}))), keyOf(new Array(12).fill(0)));
  /* (C major then E major: the same tune four up. Not A minor: it shares C major's notes, so a mix of the two is
     either) */
  const s = song({phrases: {0: cMajor}, chains: {0: [[0]], 1: [[0, 4]]}, rows: [[0], [0], [0], [0], [0], [0], [1], [1], [1], [1]]});
  const k = songKeys(s, [6, null, null, null]);
  assert.equal(k.whole.name, 'C'); assert.equal(k.now.name, 'E');
  assert.equal(songKeys(s).now, null);
}
/* the Camelot wheel: every major and minor */
assert.deepEqual([0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5].map(t => camelot(t, false)), ['8B', '9B', '10B', '11B', '12B', '1B', '2B', '3B', '4B', '5B', '6B', '7B']);
assert.deepEqual([9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7, 2].map(t => camelot(t, true)), ['8A', '9A', '10A', '11A', '12A', '1A', '2A', '3A', '4A', '5A', '6A', '7A']);
/* the reads a deck makes: each at a multiple of 128 (the FM-1 refuses any other: "Key…" forever from 0x1290), and
   together they cover every part the key needs */
{
  const at = readOffsets(128);
  assert(at.every(o => o % 128 === 0), `aligned: ${at.filter(o => o % 128).map(o => o.toString(16))}`);
  for (const [a, b] of PARTS) for (let x = a; x < b; x++) assert(at.some(o => o <= x && x < o + 128), `0x${x.toString(16)} read`);
  assert(at.every(o => o + 128 <= 0x8000), 'within the song');
}
console.log('song-key: PASS (C major, A minor, a chain transpose up and down, drums left out, rows and held notes weigh, too few notes, the part playing now, the Camelot wheel)');
