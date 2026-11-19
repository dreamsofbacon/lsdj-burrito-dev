// SPDX-License-Identifier: GPL-3.0-only
// Cartridges (lsdj/cartridges.js): an LSDj is checked before it's kept; kept once, its name and origin kept; its
// own name and kit choice saved; kit edits linked to the one they came from, the in-between copies found and
// cleaned up (not named ones, not ones in use, never the first of a chain); one a crate card plays isn't forgotten.
import assert from 'node:assert/strict';
const events = [], ls = new Map();
globalThis.document = {dispatchEvent: e => events.push(e)};
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o?.detail; } };
globalThis.localStorage = {getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k)};
const C = await import('../lsdj/cartridges.js');
const {lsdj, kitOf} = await import('./lsdj-fixtures.mjs');

const rom = n => { const r = lsdj('9.3.9', [kitOf('KITA', [4, 4], true, n), kitOf('KITB', [4], true, n + 9)]); r[0x2000] = n; return r; };

/* checked first: not an LSDj, not kept */
await assert.rejects(C.addCartridge(new Uint8Array(1000), 'notes.gb'));

const a = await C.addCartridge(rom(1), 'lsdj.gb');
assert.equal(a.from, 'file'); assert.equal(C.cartName(a), 'lsdj.gb'); assert.equal(C.originText(a), 'a file');
const again = await C.addCartridge(rom(1), 'other name.gb', {from: 'fm1'});
assert.equal(again.id, a.id); assert.equal(again.name, 'lsdj.gb', 'the same bytes: kept once, as it was');
assert.equal((await C.cartridges()).length, 1);

/* its own name and kit choice */
await C.renameCartridge(a.id, '  Live set  ');
await C.saveKitChoice(a.id, [9, 8]);
let [x] = await C.cartridges();
assert.equal(C.cartName(x), 'Live set'); assert.deepEqual(x.kits, [8, 9]);
assert.equal(x.bytes.length, rom(1).length, 'bytes untouched');

/* a chain of kit edits: a -> e1 -> e2 -> e3 */
const e1 = await C.addCartridge(rom(2), 'lsdj · kits changed 1.gb', {from: 'edited', parent: a.id});
const e2 = await C.addCartridge(rom(3), 'lsdj · kits changed 2.gb', {from: 'edited', parent: e1.id});
const e3 = await C.addCartridge(rom(4), 'lsdj · kits changed 3.gb', {from: 'edited', parent: e2.id});
let list = await C.cartridges();
const byId = new Map(list.map(c => [c.id, c]));
assert.equal(C.originText(e3, byId), 'kits changed from lsdj · kits changed 2.gb');
assert.deepEqual(C.inBetweenCopies(list).map(c => c.id).sort(), [e1.id, e2.id].sort(), 'e1, e2: in between; a (the file) and e3 (newest) stay');
assert.deepEqual(C.inBetweenCopies(list, {inUse: new Set([e1.id])}).map(c => c.id), [e2.id], 'one in use stays');
await C.renameCartridge(e2.id, 'keep me');
list = await C.cartridges();
assert.deepEqual(C.inBetweenCopies(list).map(c => c.id), [e1.id], 'a named copy stays');
await C.cleanUp(C.inBetweenCopies(list), list);
list = await C.cartridges();
assert.deepEqual(list.map(c => c.id).sort(), [a.id, e2.id, e3.id].sort());
assert.equal(list.find(c => c.id === e2.id).parent, a.id, 'e2 now points at what e1 came from');

/* Install's cartridge */
C.rememberInstallCart(e3.id);
assert.equal(C.installCart(), e3.id);

/* a crate card plays e3: not forgotten; once the card is gone, it is (and Install no longer opens it) */
ls.set('dj-crate', JSON.stringify([{id: 'c1', name: 'Card', rom: e3.id, sav: null, added: 1}]));
assert.equal(C.crateUses(e3.id).length, 1);
await assert.rejects(C.forgetCartridge(e3.id), /crate.*Nothing was forgotten/);
ls.set('dj-crate', '[]');
await C.forgetCartridge(e3.id);
assert.equal(C.installCart(), null);
assert.ok(!(await C.cartridges()).some(c => c.id === e3.id));
assert.ok(events.some(e => e.type === 'kit-library'), 'changes announced');

/* which cartridge an FM-1 has (phase 3): by the CRC kept when prepared or read, else worked out from its kits */
const {listKits} = await import('../lsdj/lsdj-rom.js');
const m1 = await C.addCartridge(rom(20), 'match.gb');
const all = listKits(m1.bytes).map(k => k.bank);
assert.equal(all.length, 2);
const crcAll = await C.dataCrcOf(m1.bytes, all), crcOne = await C.dataCrcOf(m1.bytes, [all[1]]);
assert.notEqual(crcAll, crcOne, 'other kits, another CRC');
assert.equal(await C.matchCart(12345), null, 'an LSDj not kept here');
let hit = await C.matchCart(crcAll);
assert.equal(hit.cart.id, m1.id, 'an install from before cartridges kept CRCs: matched with all its kits');
assert.deepEqual(hit.kits, all);
assert.ok((await C.cartridges()).find(c => c.id === m1.id).prints.some(p => p.dataCrc === crcAll), 'and the match kept');
await C.saveKitChoice(m1.id, [all[1]]);
hit = await C.matchCart(crcOne);
assert.equal(hit.cart.id, m1.id, 'with the kits it is set to install'); assert.deepEqual(hit.kits, [all[1]]);
await C.notePrint(a.id, 777, [8]);
hit = await C.matchCart(777);
assert.equal(hit.cart.id, a.id, 'a CRC kept when read from an FM-1'); assert.deepEqual(hit.kits, [8]);
for (let n = 0; n < 20; n++) await C.notePrint(a.id, 1000 + n, [8]);
assert.equal((await C.cartridges()).find(c => c.id === a.id).prints.length, 12, 'the last 12 kept');
console.log('cartridges: checked, kept once, named, kit choice, edit chains cleaned up, crate cards protected, an FM-1 matched to its cartridge');
