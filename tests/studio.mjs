// SPDX-License-Identifier: GPL-3.0-only
// lsdj/cart-core.js studioView / autoSort / buildStudio: carts arranged by hand, with made-up ROMs, kits and songs
// only (node tests/studio.mjs). No real LSDj or song is used: users bring their own.
import assert from 'node:assert/strict';
import {parseSav, buildSav, writeLsdsng, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {listKits} from '../lsdj/lsdj-rom.js';
import {kitSlots} from '../lsdj/lsdj-kit.js';
import {newState, setLibrary, addFiles, studioView, autoSort, buildStudio, dupGroups, forget} from '../lsdj/cart-core.js';
import {kitOf, lsdj, song, blank} from './lsdj-fixtures.mjs';

const KA = kitOf('ALPHA', [4, 5], true, 1), KB = kitOf('BRAVO', [3, 3, 3], true, 7);
const rom = lsdj('9.3.9', [KA, KB]), rom2 = lsdj('9.2.0', [KA, KB]);
const sA = song([{ins: 0, k1: 0}], [0x10, 0x20]), sB = song([{ins: 0, k1: 1}], [0x30]), sLost = song([{ins: 0, k1: 6}], [0x10]);
const sav = buildSav(blank(), sA, [{slot: 0, name: 'ALPHASNG', song: sA}, {slot: 1, name: 'BRAVOSNG', song: sB}, {slot: 2, name: 'LOSTSNG', song: sLost}], 0);
const st = newState();
setLibrary(st, [{id: 'r1', kind: 'rom', name: 'v939.gb', bytes: rom}, {id: 'r2', kind: 'rom', name: 'v920.gb', bytes: rom2}]);
await addFiles(st, [{name: 'set.sav', bytes: sav}]);
const CAP = 400000;
let v = studioView(st, {carts: []}, CAP);
assert.equal(v.songs.length, 3); assert.deepEqual(v.carts, []);
const id = n => v.songs.find(s => s.name === n).id;

/* a hand-made cart: its songs in the order given, its kits counted, built with the page's LSDj unless one is chosen */
v = studioView(st, {carts: [{id: 'c1', lsdjId: null, songIds: [id('BRAVOSNG'), id('ALPHASNG')]}, {id: 'c2', lsdjId: 'r2', songIds: [id('ALPHASNG')]}, {id: 'c3', songIds: []}]}, CAP);
assert.deepEqual(v.carts[0].songs.map(s => s.name), ['BRAVOSNG', 'ALPHASNG'], 'the order is the slot order');
assert.equal(v.carts[0].parts.length, 1, 'two songs: one cartridge');
assert.equal(v.carts[0].parts[0].kits, 2); assert.ok(v.carts[0].parts[0].kib > 0 && v.carts[0].fits);
assert.deepEqual(v.carts[0].parts[0].kitNames.sort(), ['ALPHA', 'BRAVO']);
assert.ok(v.carts[0].lsdj.auto && v.carts[0].lsdj.id === v.baseId, 'automatic: the page\'s LSDj');
assert.equal(v.carts[1].lsdj.id, 'r2'); assert.ok(!v.carts[1].lsdj.auto);
assert.equal(v.carts[1].parts[0].kits, 1, 'only the kit its song plays');
assert.deepEqual(v.carts[2].songs, []); assert.deepEqual(v.carts[2].parts, []); assert.ok(v.carts[2].fits, 'an empty cart is not a problem');

/* a song whose kit nobody has: the cart says what it loses, and is not "fits" */
v = studioView(st, {carts: [{id: 'c1', songIds: [id('LOSTSNG'), id('ALPHASNG')]}]}, CAP);
assert.equal(v.songs.find(s => s.name === 'LOSTSNG').status, 'missing');

/* a kit re-pointed (left silent): not missing any more */
const lostKit = v.songs.find(s => s.name === 'LOSTSNG').kits[0].number;
v = studioView(st, {carts: [], choices: {madeWith: {}, kitPick: {[`${id('LOSTSNG')}:${lostKit}`]: 'none'}}}, CAP);
assert.equal(v.songs.find(s => s.name === 'LOSTSNG').status, 'ok');

/* one cartridge too small for its kits ("Start a new card": a card is one cartridge): the kits it can't hold are named */
v = studioView(st, {carts: [{id: 'c1', songIds: [id('ALPHASNG'), id('BRAVOSNG')]}], mode: 'new'}, 70000);
const tight = v.carts[0].parts[0];
assert.ok(tight.lost.length || tight.leftOut.length || tight.kib * 1024 <= 70000);
assert.equal(v.carts[0].fits, !tight.lost.length && !tight.leftOut.length);

/* sort for me: every song in some cart, once; none lost */
const sorted = autoSort(st, {songIds: v.songs.map(s => s.id)}, CAP);
assert.deepEqual(sorted.flatMap(c => c.songIds).sort(), v.songs.map(s => s.id).sort());
assert.ok(sorted.every(c => c.lsdjId));

/* built: an LSDj holding only the kits its songs play, and a .sav with the songs in order */
v = studioView(st, {carts: [{id: 'c1', songIds: [id('BRAVOSNG'), id('ALPHASNG')]}, {id: 'c2', songIds: [id('ALPHASNG')]}]}, CAP);
const made = buildStudio(st, ['c1', 'c2'], {c1: 'Mix'});
assert.equal(made.length, 2); assert.equal(made[0].title, 'Mix'); assert.equal(made[1].title, 'Cart');
assert.deepEqual(made[0].songs, ['BRAVOSNG', 'ALPHASNG']);
assert.equal(parseSav(made[0].sav).songs.length, 2);
assert.equal(made[0].sav.length, SAV_SIZE);
assert.equal(kitSlots(made[0].rom).filter(s => !s.empty).length, 2);
assert.equal(kitSlots(made[1].rom).filter(s => !s.empty).length, 1, 'cart 2 keeps only ALPHA');
assert.throws(() => buildStudio(st, ['nope']), /Nothing to build/);
assert.deepEqual(made.map(m => [m.part, m.parts]), [[0, 1], [0, 1]]);

/* more songs than one cartridge holds: 40 in one card (two saves of 20) */
const forty = Array.from({length: 40}, (_, i) => song([{ins: 0, k1: i % 2}], [0x10 + (i % 3) * 0x10]));
const savOf = (prefix, list) => buildSav(blank(), list[0], list.map((s, i) => ({slot: i, name: `${prefix}${i}`, song: s})), 0);
await addFiles(st, [{name: 'one.sav', bytes: savOf('ONE', forty.slice(0, 20))}, {name: 'two.sav', bytes: savOf('TWO', forty.slice(20))}]);
v = studioView(st, {carts: []}, CAP);
const ids40 = v.songs.filter(s => /^(ONE|TWO)\d/.test(s.name)).map(s => s.id);
assert.equal(ids40.length, 40);
/* "It makes more cartridges" (the default): two, each song in one of them once, every sample kept */
v = studioView(st, {carts: [{id: 'big', songIds: ids40}]}, CAP);
assert.equal(v.carts[0].parts.length, 2, 'a card of 40 songs makes two cartridges');
assert.deepEqual(v.carts[0].parts.flatMap(p => p.songIds).sort(), [...ids40].sort());
assert.ok(v.carts[0].parts.every(p => p.songs <= 32 && p.fits && !p.lost.length), 'each one fits with every sample');
assert.ok(v.carts[0].fits);
const pair = buildStudio(st, ['big'], {big: 'FRIDAY'});
assert.deepEqual(pair.map(m => m.title), ['FRIDAY 1', 'FRIDAY 2']);
assert.deepEqual(pair.map(m => [m.part, m.parts]), [[0, 2], [1, 2]]);
assert.equal(pair.reduce((n, m) => n + parseSav(m.sav).songs.length, 0), 40, 'every song in one of the two saves');
/* "Start a new card": one cartridge a card, and how many of its songs, in order, fit with every sample: 32 */
v = studioView(st, {carts: [{id: 'big', songIds: ids40}], mode: 'new'}, CAP);
assert.equal(v.carts[0].parts.length, 1); assert.equal(v.carts[0].fit, 32);
v = studioView(st, {carts: [{id: 'a', songIds: ids40.slice(0, 32)}, {id: 'b', songIds: ids40.slice(32)}], mode: 'new'}, CAP);
assert.deepEqual(v.carts.map(c => [c.fit, c.songs.length, c.fits]), [[32, 32, true], [8, 8, true]]);
/* sort for me says which file a cartridge's songs all came from (its name) */
assert.deepEqual(autoSort(st, {songIds: ids40.slice(0, 20)}, CAP).map(c => c.from), ['one.sav']);
assert.deepEqual(autoSort(st, {songIds: ids40.slice(10, 30)}, CAP).map(c => c.from), [null], 'two files: no name');
/* songs in more than one file: a file added twice is skipped; the same song (its bytes) or the same name in two files
   is a group, newest first (the higher version, then the later file); copies not kept are forgotten */
{
  const d = newState(), JAN = Date.UTC(2026, 0, 12), MAR = Date.UTC(2026, 2, 3), APR = Date.UTC(2026, 3, 1);
  setLibrary(d, [{id: 'r1', kind: 'rom', name: 'v939.gb', bytes: rom, date: JAN}]);
  const fri5 = song([{ins: 0, k1: 0}], [0x10, 0x11]), fri9 = song([{ins: 0, k1: 0}], [0x10, 0x12]), house = song([{ins: 0, k1: 1}], [0x30, 0x31]), solo = song([{ins: 0, k1: 1}], [0x40]);
  const jan = buildSav(blank(), fri5, [{slot: 0, name: 'FRIDAY', version: 5, song: fri5}, {slot: 1, name: 'HOUSE', version: 2, song: house}], 0);
  const mar = buildSav(blank(), fri9, [{slot: 0, name: 'FRIDAY', version: 9, song: fri9}, {slot: 1, name: 'HOUSE', version: 2, song: house}, {slot: 2, name: 'SOLO', version: 1, song: solo}], 0);
  let out = await addFiles(d, [{name: 'gig-jan.sav', bytes: jan, date: JAN}, {name: 'gig-mar.sav', bytes: mar, date: MAR}, {name: 'gig-mar (1).sav', bytes: mar, date: APR}]);
  assert.equal(out.songs, 5);
  assert.deepEqual(out.skipped, [{name: 'gig-mar (1).sav', why: 'the same file as gig-mar.sav'}], 'the same file twice: once');
  const dv = studioView(d, {carts: []}, CAP), sid = (n, f) => dv.songs.find(s => s.name === n && s.from === f).id;
  assert.deepEqual(dv.songs.map(s => [s.name, s.version, s.date, s.dups]), [['FRIDAY', 5, JAN, 2], ['HOUSE', 2, JAN, 2], ['FRIDAY', 9, MAR, 2], ['HOUSE', 2, MAR, 2], ['SOLO', 1, MAR, 1]]);
  assert.equal(dv.roms[0].date, JAN, 'an LSDj file keeps its date');
  let groups = dupGroups(d);
  assert.equal(groups.length, 2);
  const fri = groups.find(g => g.names[0] === 'FRIDAY'), hou = groups.find(g => g.names[0] === 'HOUSE');
  assert.deepEqual(fri.songs.map(s => [s.from, s.version]), [['gig-mar.sav', 9], ['gig-jan.sav', 5]], 'newest first: the higher version');
  assert.ok(!fri.same && fri.versions === 2 && !fri.unsure);
  assert.ok(hou.same && hou.versions === 1, 'HOUSE: the same in both');
  assert.deepEqual(hou.songs.map(s => s.from), ['gig-mar.sav', 'gig-jan.sav'], 'the same version: the later file first');
  assert.equal(hou.songs[1].same, hou.songs[0].id, 'its copy says which it is the same as');
  assert.deepEqual(dupGroups(d, [sid('SOLO', 'gig-mar.sav')]), [], 'SOLO is in one file');
  assert.deepEqual(dupGroups(d, [sid('FRIDAY', 'gig-jan.sav')]).map(g => g.names), [['FRIDAY']], 'only the groups asked about');
  /* the latest file with a lower version of it: unsure */
  const fri7 = song([{ins: 0, k1: 0}], [0x10, 0x13]);
  out = await addFiles(d, [{name: 'friday.lsdsng', bytes: writeLsdsng({name: 'FRIDAY', version: 7, song: fri7}), date: APR}]);
  groups = dupGroups(d, [sid('FRIDAY', 'gig-mar.sav')]);
  assert.ok(groups[0].unsure && groups[0].versions === 3, 'the April file has v7, March v9: unsure');
  assert.equal(groups[0].songs.find(s => s.id === groups[0].latest).from, 'friday.lsdsng');
  /* a renamed copy (the same bytes): the same group */
  await addFiles(d, [{name: 'solo2.lsdsng', bytes: writeLsdsng({name: 'SOLO2', version: 1, song: solo}), date: APR}]);
  const so = dupGroups(d, [sid('SOLO', 'gig-mar.sav')]);
  assert.ok(so.length === 1 && so[0].same && so[0].names.join() === 'SOLO2,SOLO', `the same song under another name (the later file first): ${so[0]?.names}`);
  /* the copies not kept: gone; their file may come in again */
  forget(d, [sid('FRIDAY', 'gig-jan.sav'), sid('HOUSE', 'gig-jan.sav')]);
  assert.equal(studioView(d, {carts: []}, CAP).songs.filter(s => s.from === 'gig-jan.sav').length, 0);
  out = await addFiles(d, [{name: 'gig-jan.sav', bytes: jan, date: JAN}]);
  assert.equal(out.songs, 2, 'a file whose songs were all taken out comes in again');
  /* never chained: ALPHA's bytes are BETA's, and BETA's name is another song's: two groups, ALPHA never with that one */
  const c = newState(), one = song([{ins: 0, k1: 0}], [0x50, 0x51]), other = song([{ins: 0, k1: 0}], [0x60, 0x61]);
  await addFiles(c, [{name: 'a.lsdsng', bytes: writeLsdsng({name: 'ALPHA', version: 1, song: one})}, {name: 'b.lsdsng', bytes: writeLsdsng({name: 'BETA', version: 1, song: one})},
    {name: 'b2.lsdsng', bytes: writeLsdsng({name: 'BETA', version: 4, song: other})}]);
  const cg = dupGroups(c).map(g => g.songs.map(s => `${s.name}@${s.from}`).sort().join());
  assert.deepEqual(cg.sort(), ['ALPHA@a.lsdsng,BETA@b.lsdsng', 'BETA@b.lsdsng,BETA@b2.lsdsng'], `two groups, not one chain: ${cg}`);
}
console.log('PASS studio: carts by hand (order, kits, LSDj choice, lost kits), sort for me (named after the file), built carts; a card of 40 songs makes two cartridges with every sample, or says the first 32 fit; songs in more than one file (a file twice skipped, the same song or name grouped newest first, unsure dates, a renamed copy, copies forgotten)');
