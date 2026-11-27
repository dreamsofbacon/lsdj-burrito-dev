// SPDX-License-Identifier: GPL-3.0-only
// lsdj/cart-core.js studioView / autoSort / buildStudio: carts arranged by hand, with made-up ROMs, kits and songs
// only (node tests/studio.mjs). No real LSDj or song is used: users bring their own.
import assert from 'node:assert/strict';
import {parseSav, buildSav, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {listKits} from '../lsdj/lsdj-rom.js';
import {kitSlots} from '../lsdj/lsdj-kit.js';
import {newState, setLibrary, addFiles, studioView, autoSort, buildStudio} from '../lsdj/cart-core.js';
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
console.log('PASS studio: carts by hand (order, kits, LSDj choice, lost kits), sort for me (named after the file), built carts; a card of 40 songs makes two cartridges with every sample, or says the first 32 fit');
