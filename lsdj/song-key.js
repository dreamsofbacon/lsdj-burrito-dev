// SPDX-License-Identifier: GPL-3.0-only
// The key of an LSDj song from its notes, for the DJ decks (dj-ui.js). Pure: no DOM.
// A song is LSDj's 0x8000 bytes (lsdj-sav.js); the parts read (also all a deck reads from its FM-1, PARTS):
//   0x0000 phrase notes (phrase * 16 + step; 0 = none, else pitch class (n - 1) % 12 with 0 = C: checked in LSDj
//          9.3.9, 0x55 shows as C 9), 0x1290 the song table (row * 4 + channel -> chain, FF = none), 0x2080 chain
//          phrases and 0x2880 chain transposes (chain * 16 + step; a transpose is signed semitones), 0x3080
//          instruments (16 bytes; byte 0: 0 pulse, 1 wave, 2 kit, 3 noise), 0x7000 phrase instruments (FF = the
//          channel's last one).
// Each pitched note (pulse and wave instruments; kits and noise are drums) counts for the steps it lasts (to the next
// note in its phrase, or the phrase's end) times the song rows its chain is on. The counts are matched against the
// Krumhansl-Kessler major and minor key profiles; the best match is the key. Grooves, tables, arpeggios and the
// instruments' own transposes are not counted.
export const PARTS = [[0x0000, 0x0ff0], [0x1290, 0x1690], [0x2080, 0x3080], [0x3080, 0x3480], [0x7000, 0x7ff0]];
/* the save reads (READ, chunk bytes each) that cover PARTS, each at a multiple of chunk: the FM-1 answers "bad request"
   to any other offset (lsdj_link.h), and 0x1290 (the song table) is not one. Read from 0x1290 the deck asked for that
   chunk every poll and stayed on "Key…" (Colin, 2026-11-17: never worked on an FM-1). */
export function readOffsets(chunk = 128) {
  const at = new Set();
  for (const [a, b] of PARTS) for (let o = Math.floor(a / chunk) * chunk; o < b; o += chunk) at.add(o);
  return [...at].sort((x, y) => x - y);
}
const SONG = 0x1290, CHAIN_PHR = 0x2080, CHAIN_TSP = 0x2880, INSTR = 0x3080, PHR_INSTR = 0x7000;
const PULSE = 0, WAVE = 1;
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/* a phrase's pitched notes into hist (transposed, times weight); last: the channel's instrument so far */
function addPhrase(song, hist, phrase, transpose, weight, last) {
  const notes = [];
  for (let s = 0; s < 16; s++) {
    const i = song[PHR_INSTR + phrase * 16 + s];
    if (i !== 0xff && i < 64) last.ins = i;
    const n = song[phrase * 16 + s];
    if (n) notes.push({s, n, ins: last.ins});
  }
  notes.forEach((x, k) => {
    const type = x.ins == null ? PULSE : song[INSTR + x.ins * 16];
    if (type !== PULSE && type !== WAVE) return;
    const steps = (notes[k + 1]?.s ?? 16) - x.s;
    hist[(((x.n - 1 + transpose) % 12) + 12) % 12] += steps * weight;
  });
}
/* the chain on a song row and channel through its phrases */
function addChain(song, hist, chain, weight, last) {
  for (let s = 0; s < 16; s++) {
    const p = song[CHAIN_PHR + chain * 16 + s];
    if (p === 0xff || p >= 0xff) continue;
    const t = song[CHAIN_TSP + chain * 16 + s];
    addPhrase(song, hist, p, t > 127 ? t - 256 : t, weight, last);
  }
}
/* rows: the song rows to count (default every row), per channel or the same for all -> 12 weights from C */
export function pitchClasses(song, rows = null) {
  const hist = new Array(12).fill(0);
  for (let c = 0; c < 3; c++) {   /* PU1, PU2, WAV (NOI: drums) */
    const last = {ins: null};
    const list = rows ? (Array.isArray(rows[0]) ? rows[c] : rows) : Array.from({length: 256}, (_, r) => r);
    for (const r of list ?? []) {
      const chain = song[SONG + r * 4 + c];
      if (chain !== 0xff && chain < 0x80) addChain(song, hist, chain, 1, last);
    }
  }
  return hist;
}
const corr = (a, b) => {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : 0;
};
/* Camelot (the DJs' wheel): C major 8B, A minor 8A; a fifth up is one more */
export const camelot = (tonic, minor) => `${((minor ? tonic + 3 : tonic) * 7 % 12 + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
/* 12 weights -> {tonic (0 = C), minor, name ('Am'), long ('A minor'), camelot ('8A'), sure (0..1)} or null (too few notes,
   or fewer than three different ones) */
export function keyOf(hist) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total < 8 || hist.filter(x => x > 0).length < 3) return null;   /* (one or two notes make no key) */
  const all = [];
  for (let t = 0; t < 12; t++) {
    const rot = i => hist[(i + t) % 12];
    const h = Array.from({length: 12}, (_, i) => rot(i));
    all.push({tonic: t, minor: false, r: corr(h, MAJOR)}, {tonic: t, minor: true, r: corr(h, MINOR)});
  }
  all.sort((a, b) => b.r - a.r);
  const [best, next] = all;
  /* how sure: the best match's strength and its lead over the next (a relative major / minor is often close) */
  const sure = Math.max(0, Math.min(1, best.r * 0.6 + (best.r - next.r) * 4));
  const n = NAMES[best.tonic];
  return {tonic: best.tonic, minor: best.minor, name: n + (best.minor ? 'm' : ''), long: `${n} ${best.minor ? 'minor' : 'major'}`,
    camelot: camelot(best.tonic, best.minor), sure, r: best.r};
}
/* the song's key, and the key of what plays now: at = each channel's song row (LIVE songRows; null: not playing);
   ahead: rows counted from there */
export function songKeys(song, at = null, ahead = 4) {
  const whole = keyOf(pitchClasses(song));
  let now = null;
  if (at?.some(r => r != null)) {
    const rows = [0, 1, 2].map(c => at[c] == null ? [] : Array.from({length: ahead}, (_, k) => at[c] + k).filter(r => r < 256));
    now = keyOf(pitchClasses(song, rows));
  }
  return {whole, now};
}
