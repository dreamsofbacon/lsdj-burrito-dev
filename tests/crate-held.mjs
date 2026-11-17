// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate's "does the FM-1 hold the songs sent" (crate-ui.js checkHeld). LSDj rewrites its working song (the
// save's first 32 KiB) as it starts, so the whole save's checksum differed after every load that worked (Colin's DJ
// test, 2026-11-17: "doesn't hold the songs sent" with the song playing). Only the songs' header may say so.
import assert from 'node:assert/strict';

/* crate-ui.js reaches for the page when it loads: enough of one for that */
const el = () => new Proxy(function () {}, {get: (t, k) => k === Symbol.toPrimitive ? () => '' : el(), apply: () => el(), set: () => true});
globalThis.document = el(); globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
globalThis.addEventListener ??= () => {}; globalThis.window ??= globalThis;
const {checkHeld} = await import('../lsdj/crate-ui.js');
const {crc32} = await import('../lsdj/link.js');
const {HEADER, HEADER_SIZE} = await import('../lsdj/lsdj-sav.js');

const sav = new Uint8Array(131072);
for (let i = 0; i < sav.length; i++) sav[i] = (i * 7 + (i >> 9)) & 255;
const now = pause => async () => {};
const fm1 = (held, opts = {}) => ({
  info: async () => opts.infoError ? Promise.reject(Error('gone')) : {title: 'LSDj-v9.3.9', firmware: 'FM-1_998', saveCrc: crc32(held)},
  readSaveAt: async (key, off, n) => { if (opts.readError) throw Error('quiet'); opts.reads = (opts.reads || 0) + 1; return held.slice(off, off + n); },
});

/* 1. exactly the bytes sent: fine, nothing read back */
{ const o = {}; const r = await checkHeld('k', sav, 'A', fm1(sav, o), now());
  assert.equal(r.bad, undefined); assert.equal(r.crc, crc32(sav)); assert.equal(o.reads, undefined); }

/* 2. LSDj changed its working song (below the header), songs intact: fine, and the badge takes the FM-1's checksum */
{ const held = sav.slice(); for (let i = 0; i < 0x8000; i += 97) held[i] ^= 0x5a;
  const o = {}; const r = await checkHeld('k', sav, 'A', fm1(held, o), now());
  assert.equal(r.bad, undefined, 'a working song LSDj rewrote is not "different songs"');
  assert.equal(r.crc, crc32(held)); assert.equal(o.reads, 1); }

/* 3. another song list (an LSDj that kept its own songs, or cleared them): said */
for (const at of [0, 0x140, HEADER_SIZE - 1]) {
  const held = sav.slice(); held[HEADER + at] ^= 1;
  const r = await checkHeld('k', sav, 'B', fm1(held), now());
  assert.match(r.bad, /doesn't hold the songs sent/);
}

/* 4. no answer: said, never "held" */
assert.match((await checkHeld('k', sav, 'A', fm1(sav, {infoError: true}), now())).bad, /couldn't ask/);
{ const held = sav.slice(); held[5] ^= 1;
  assert.match((await checkHeld('k', sav, 'A', fm1(held, {readError: true}), now())).bad, /couldn't read back/); }

console.log('PASS crate: songs held = the songs header read back, not the whole save checksum (LSDj rewrites its working song)');
