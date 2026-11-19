// SPDX-License-Identifier: GPL-3.0-only
// lsdj/cart-core.js and the .lsdprj reader: the crate's cart maker with made-up ROMs, kits and songs only
// (node tests/cart.mjs). No real LSDj or song is used: users bring their own.
import assert from 'node:assert/strict';
import {BANK, kitSlots, parseKit, buildKit} from '../lsdj/lsdj-kit.js';
import {parseSav, songBytes, buildSav, writeLsdsng, readLsdprj, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import * as S from '../lsdj/lsdj-sets.js';
import {newState, setLibrary, addFiles, view, build, fitCarts} from '../lsdj/cart-core.js';
import {planRom, listKits} from '../lsdj/lsdj-rom.js';
import {splitSav} from '../lsdj/lsdj-sav.js';
import {kitOf, lsdj, song, blank, prj} from './lsdj-fixtures.mjs';

/* ---- .lsdprj: a song, then its kits as whole banks (none, or several) ---- */
const KA = kitOf('ALPHA', [4, 5], true, 1), KB = kitOf('BRAVO', [3, 3, 3], true, 7), KX = kitOf('XTRA', [6], true, 11);
const sA = song([{ins: 0, k1: 0}], [0x10, 0x20]);   /* plays kit 00 */
const sX = song([{ins: 0, k1: 3}, {ins: 1, k1: 10}], [0x10, 0x10]);   /* plays kit 03 (instrument 0 only) */
{
  const p = readLsdprj(prj('WITHKITS', sX, [KX, KB]));
  assert.equal(p.name, 'WITHKITS'); assert.equal(p.kits.length, 2);
  assert.deepEqual(p.song, sX); assert.equal(parseKit(p.kits[0]).name, 'XTRA');
  const none = readLsdprj(prj('NOKITS', sA, []));
  assert.equal(none.kits.length, 0); assert.deepEqual(none.song, sA);
  assert.throws(() => readLsdprj(new Uint8Array(100)), /not an .lsdprj/);
}
/* which kit number each of a project's kits is */
{
  const two = song([{ins: 0, k1: 3}, {ins: 1, k1: 10}], [0x10, 0x10, 0x10], 0);
  two[0x7001] = 1;   /* the second note plays instrument 1: kits 03 and 0A */
  assert.deepEqual([...S.projectKits(two, [KA, KB]).map], [[3, 0], [10, 1]]);
  assert.equal(S.projectKits(two, [KA, KB]).rule, 'played');
  assert.equal(S.projectKits(two, Array(11).fill(KA)).rule, 'number');
  assert.deepEqual([...S.projectKits(two, Array(11).fill(KA)).map], [[3, 3], [10, 10]]);
  assert.equal(S.projectKits(two, [KA]).rule, 'guess');
  assert.equal(S.projectKits(two, []).rule, 'none');
}

/* ---- the cart maker: files in, songs matched, carts out ---- */
const rom = lsdj('9.3.9', [KA, KB]);   /* kit 00 ALPHA, 01 BRAVO */
const sB = song([{ins: 0, k1: 1}], [0x30]);   /* plays kit 01 */
const sMissing = song([{ins: 0, k1: 6}], [0x10]);   /* plays kit 06: nobody has it */
const sav = buildSav(blank(), sA, [{slot: 0, name: 'ALPHASNG', song: sA}, {slot: 1, name: 'BRAVOSNG', song: sB}], 0);
const footer = new Uint8Array(SAV_SIZE + 16); footer.set(sav);
const st = newState();
setLibrary(st, [{id: 'lib1', kind: 'rom', name: 'mine.gb', bytes: rom}]);
const added = await addFiles(st, [
  {name: 'set.sav', bytes: footer},                                  /* (a 16-byte footer: still a save) */
  {name: 'lost.lsdsng', bytes: writeLsdsng({name: 'LOST', song: sMissing})},
  {name: 'proj.lsdprj', bytes: prj('PROJ', sX, [KX])},               /* its own kit: kit 03 is XTRA */
  {name: 'notes.txt', bytes: new Uint8Array(10)}]);
assert.equal(added.songs, 4); assert.deepEqual(added.skipped.map(s => s.name), ['notes.txt']);
let v = view(st, {plan: 'split'}, 400000);
const by = n => v.songs.find(s => s.name === n);
assert.equal(by('ALPHASNG').status, 'ok'); assert.equal(by('BRAVOSNG').status, 'ok');
assert.equal(by('LOST').status, 'missing'); assert.ok(by('LOST').kits[0].missing);
assert.equal(by('PROJ').status, 'ok'); assert.equal(by('PROJ').rule, 'played');
assert.match(by('PROJ').kits[0].source, /proj\.lsdprj kit 1/);
assert.equal(v.baseId, 'lib1'); assert.equal(v.plans.length, 1);
assert.deepEqual(v.plans[0].songs.sort(), ['ALPHASNG', 'BRAVOSNG', 'LOST', 'PROJ']);

/* only the ticked ones; then built: an LSDj with just their kits, and a .sav with them */
v = view(st, {ticked: [by('ALPHASNG').id, by('PROJ').id], plan: 'split'}, 400000);
assert.deepEqual(v.plans[0].songs.sort(), ['ALPHASNG', 'PROJ']); assert.equal(v.plans[0].kits, 2);
const [cart] = build(st, ['Friday']);
assert.equal(cart.title, 'Friday'); assert.ok(cart.fits);
const names = kitSlots(cart.rom).filter(s => !s.empty).map(s => s.kit.name).sort();
assert.deepEqual(names, ['ALPHA', 'XTRA'], 'the kits the two songs play, BRAVO left out');
const out = parseSav(cart.sav);
assert.deepEqual(out.songs.map(s => s.name).sort(), ['ALPHASNG', 'PROJ']);
/* PROJ's kit instrument points at the slot now holding XTRA */
const proj = songBytes(out, out.songs.find(s => s.name === 'PROJ').slot), slot = proj[0x3082] & 0x3f;
assert.equal(kitSlots(cart.rom)[slot].kit.name, 'XTRA');
assert.match(cart.report, /Friday/);
/* a cart made here is not a source for matching songs again */
setLibrary(st, [{id: 'lib1', kind: 'rom', name: 'mine.gb', bytes: rom}, {id: 'cart1', kind: 'rom', name: 'Friday.gb', bytes: cart.rom}], ['cart1']);
assert.deepEqual(view(st, {plan: 'split'}, 400000).roms.map(r => r.id), ['lib1']);
/* the LSDj to build with: one the FM-1 knows fully (LSDj 9.3.9: SYNC, play state, rows) before a newer one; the
   newest when none is; the one chosen always. (Fixtures are no real LSDj: checkRoms finds none fully known.) */
{
  const newer = lsdj('9.4.0', [KA]), two = newState();
  setLibrary(two, [{id: 'old', kind: 'rom', name: 'v939.gb', bytes: rom}, {id: 'new', kind: 'rom', name: 'v940.gb', bytes: newer}]);
  await addFiles(two, [{name: 'set.sav', bytes: footer}]);
  assert.ok(two.full.has('old') && two.full.has('new') && !two.full.get('old'), 'each LSDj checked once');
  assert.equal(view(two, {plan: 'split'}, 400000).baseId, 'new', 'none fully known: the newest');
  two.full.set('old', true);
  const vf = view(two, {plan: 'split'}, 400000);
  assert.equal(vf.baseId, 'old', 'the fully known one before a newer one');
  assert.deepEqual(vf.roms.map(r => [r.id, r.full]), [['old', true], ['new', false]]);
  assert.equal(view(two, {plan: 'split', baseId: 'new'}, 400000).baseId, 'new', 'the one chosen');
}
/* no LSDj to build with: songs listed, no carts */
const bare = newState(); await addFiles(bare, [{name: 'proj.lsdprj', bytes: prj('PROJ', sX, [KX])}]);
const vb = view(bare, {plan: 'split'}, 400000);
assert.equal(vb.songs.length, 1); assert.equal(vb.plans.length, 0); assert.equal(vb.baseId, null);
assert.throws(() => build(bare), /Nothing to build/);
/* the crate: songs and the LSDj chosen for them, the LSDj too big with all its kits -> cartridges that fit, holding
   only the kits (and samples) the songs play; a cartridge a song too */
{
  const big = lsdj('9.3.9', [kitOf('ALPHA', [40, 40], true, 1), kitOf('BRAVO', [60, 60], true, 7), kitOf('XTRA', [60, 60], true, 11)]);
  const all = listKits(big).map(k => k.bank), cap = planRom(big, all.slice(0, 2), 1 << 30).needed + 1024;   /* (room for the two kits played, not the third) */
  assert.ok(!planRom(big, all, cap).fits, 'the whole LSDj does not fit this slot');
  const sav = buildSav(blank(), sA, [{slot: 0, name: 'ONE', song: sA}, {slot: 3, name: 'TWO', song: song([{ins: 0, k1: 1}], [0x10])}], 0);
  const [c, ...more] = fitCarts({rom: big, savs: [{name: 'set.sav', bytes: sav}], capacity: cap});
  assert.equal(more.length, 0, 'one cartridge');
  assert.ok(c.fits && planRom(c.rom, listKits(c.rom).map(k => k.bank), cap).fits, 'it fits, all its kits in');
  const names = kitSlots(c.rom).filter(x => !x.empty).map(x => x.kit.name.trim());
  assert.deepEqual(names.sort(), ['ALPHA', 'BRAVO'], `only the kits played: ${names}`);
  assert.deepEqual(c.songs, ['ONE', 'TWO']);
  const each = fitCarts({rom: big, savs: [{name: 'set.sav', bytes: sav}], capacity: cap, each: true});
  assert.equal(each.length, 2, 'a cartridge a song');
  assert.deepEqual(each.map(x => kitSlots(x.rom).filter(k => !k.empty).map(k => k.kit.name.trim())), [['ALPHA'], ['BRAVO']]);
  for (const x of each) { const p = parseSav(x.sav); assert.equal(p.songs.length, 1); assert.equal(p.active, 0, 'opens on its song'); }
  assert.equal(splitSav(sav).length, 2);
  assert.throws(() => fitCarts({rom: big, savs: [{name: 'empty.sav', bytes: blank()}], capacity: cap}), /No saved songs/);
}
console.log('cart: PASS (made to fit: only the kits played, a cartridge a song; .lsdprj with and without kits, a project\'s kit numbers, files in (a save with a footer, .lsdsng, .lsdprj, others skipped), each song\'s kits and status, carts planned, built with only the kits played and songs renumbered, carts made here not sources, the fully known LSDj first, no LSDj)');
