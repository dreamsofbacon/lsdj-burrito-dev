// SPDX-License-Identifier: GPL-3.0-only
// Song backups (lsdj/backups.js): before songs are sent, what the FM-1 holds is kept, the last 5 per FM-1; songs
// already kept are not read again; a DJ load backs up only where the FM-1 reads its songs in seconds; a failed
// read throws (the caller sends nothing). Storage that isn't kept is said (kit-library.js, no IndexedDB here).
import assert from 'node:assert/strict';
const events = [];
globalThis.document = {dispatchEvent: e => events.push(e)};
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
const {backupSongs, backups, KEEP} = await import('../lsdj/backups.js');
const {storageState, addToLibrary} = await import('../lsdj/kit-library.js');
const {crc32} = await import('../lsdj/lsdj-rom.js');

const save = n => { const b = new Uint8Array(131072); b.fill(n); b[5] = n * 3; return b; };
const fm1 = (bytes, {stream = true, fail = false} = {}) => ({reads: 0,
  info: async () => ({title: 'LSDj-v9.3.9', saveSize: bytes.length, saveCrc: crc32(bytes), importing: 0, stream}),
  exportSave: async function () { this.reads++; if (fail) throw Error('did not answer'); return bytes.slice(); }});

const log = [];
let l = fm1(save(1));
const e = await backupSongs(l, 'FM-1 1', {log: t => log.push(t)});
assert.ok(e && e.kind === 'backup' && e.fm1 === 'FM-1 1' && l.reads === 1);
assert.equal(await backupSongs(l, 'FM-1 1'), null, 'the same songs: not read again');
assert.equal(l.reads, 1);
/* a crate card with the songs on the FM-1: already kept, nothing read */
await addToLibrary('sav', 'a crate card', save(9), {crc: crc32(save(9))});
l = fm1(save(9)); assert.equal(await backupSongs(l, 'FM-1 1'), null); assert.equal(l.reads, 0);
/* the last KEEP per FM-1 */
for (let n = 2; n < 2 + KEEP + 2; n++) await backupSongs(fm1(save(n)), 'FM-1 1');
await backupSongs(fm1(save(50)), 'FM-1 2');
const b = await backups();
assert.equal(b.filter(f => f.fm1 === 'FM-1 1').length, KEEP, 'FM-1 1: the last 5');
assert.equal(b.filter(f => f.fm1 === 'FM-1 2').length, 1, "FM-1 2's own");
assert.ok(b[0].at >= b[b.length - 1].at, 'newest first');
/* a DJ load on an FM-1 that reads slowly: skipped, said */
l = fm1(save(60), {stream: false}); log.length = 0;
assert.equal(await backupSongs(l, 'FM-1 2', {quickOnly: true, log: t => log.push(t)}), null);
assert.equal(l.reads, 0); assert.match(log[0], /not backed up first/);
/* a read that fails: thrown */
await assert.rejects(backupSongs(fm1(save(61), {fail: true}), 'FM-1 2'), /did not answer/);
/* no IndexedDB here: the storage isn't kept, and that's said */
const st = await storageState();
assert.equal(st.kept, false); assert.match(st.trouble, /last only until this page closes/);
assert.ok(events.some(x => x.type === 'kit-library-trouble'));
console.log(`backups: PASS (kept before a send, not read twice, a crate card counts, the last ${KEEP} per FM-1, a slow DJ load skipped and said, a failed read thrown; storage not kept: said)`);
