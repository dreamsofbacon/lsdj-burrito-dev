// SPDX-License-Identifier: GPL-3.0-only
// lsdj/dj-info.js: what the jog wheel shows of LSDj (node tests/dj-info.mjs). Made-up LIVE readings only.
import assert from 'node:assert/strict';
import {channelSteps, chainChannel, chainInfo, songInfo, chips, LIVE_OLD_MS} from '../lsdj/dj-info.js';

const T = 100000, BPM = 120, ROW = 15000 / BPM;   /* 125 ms a row */
/* a LIVE read at T (asked and answered at once) */
const live = o => ({askedAt: T, gotAt: T, playing: 0b0111, mute: 0, freeze: 0, sync: 'keybd', live: false, battery: null,
  rows: [5, 5, 12, null], songRows: [10, 10, 11, null], chainPos: [1, 1, 0, null], chainLen: [4, 4, 2, null], ...o});

/* channel steps: the row said, carried on at the tempo; not playing / stale: null */
assert.deepEqual(channelSteps(live(), T, BPM), [5, 5, 12, null], 'the rows said (NOI not playing)');
assert.deepEqual(channelSteps(live(), T + 2 * ROW, BPM), [7, 7, 14, null], 'two rows later');
assert.deepEqual(channelSteps(live(), T + 5 * ROW, BPM), [10, 10, 1, null], 'round the phrase');
assert.deepEqual(channelSteps(live(), T + LIVE_OLD_MS + 1, BPM), [null, null, null, null], 'a stale LIVE: nothing');
assert.deepEqual(channelSteps(live({playing: 0}), T, BPM), [null, null, null, null], 'stopped');
assert.deepEqual(channelSteps(null, T, BPM), [null, null, null, null]);

/* the chain: the longest playing one; phrase 2 of 4, row 5: 2 bars and a bit to go -> 3 bars, then the last */
assert.equal(chainChannel(live()), 0);
assert.equal(chainChannel(live({playing: 0b0100})), 2, 'only WAV plays: its chain');
let c = chainInfo(live(), T, BPM);
assert.deepEqual([c.phrase, c.of, c.bars, c.last], [2, 4, 3, false], JSON.stringify(c));
c = chainInfo(live({chainPos: [3, 3, 0, null]}), T, BPM);
assert.deepEqual([c.phrase, c.of, c.bars, c.last], [4, 4, 1, true], 'the last phrase: the last bar');
c = chainInfo(live({chainPos: [3, 3, 0, null], rows: [15, 15, 0, null]}), T + 3 * ROW, BPM);
assert.deepEqual([c.phrase, c.bars], [1, 4], 'past the end: round to the chain\'s start again');
assert.equal(chainInfo(live({chainPos: null}), T, BPM), null, 'older firmware: nothing');
assert.equal(chainInfo(live(), T + LIVE_OLD_MS + 1, BPM), null, 'stale: nothing');

/* the song: the lowest playing song row; rows to the next empty one of a playing channel */
const rowsOf = n => Array.from({length: n}, () => [0, 1, 2, null]);
let map = rowsOf(20);
assert.deepEqual(songInfo(live(), T, map, 8), {row: 10, loops: null}, 'nothing empty near');
map[13 - 8] = [null, 1, 2, null];   /* (read from row 8) PU1 empty 3 rows after its row 10 */
assert.deepEqual(songInfo(live(), T, map, 8), {row: 10, loops: 3});
map[12 - 8] = [0, 1, null, null];   /* WAV (row 11) empty the row after it */
assert.deepEqual(songInfo(live(), T, map, 8), {row: 10, loops: 1}, 'the nearest of the playing channels');
assert.deepEqual(songInfo(live(), T, map, 8, 0), {row: 10, loops: null}, 'only within near');
assert.deepEqual(songInfo(live(), T, rowsOf(4), 8), {row: 10, loops: null}, 'the rows read don\'t reach: not said');
assert.deepEqual(songInfo(live(), T, null, -1), {row: 10, loops: null}, 'not read yet');
assert.equal(songInfo(live({playing: 0}), T, map, 8), null);
assert.deepEqual(songInfo(live({playing: 0b1000, songRows: [null, null, null, 2]}), T, rowsOf(20), 0), {row: 2, loops: 1}, 'NOI: its column empty');

/* chips: only what isn't as usual */
assert.deepEqual(chips(live(), T), []);
assert.deepEqual(chips(live({sync: 'midi'}), T), [], 'MIDI while a deck plays it: usual');
assert.deepEqual(chips(live({sync: 'lsdj'}), T), [{k: 'sync', text: 'SYNC LSDJ', warn: true}]);
assert.deepEqual(chips(live({sync: 'lsdj'}), T, {master: true}), [{k: 'sync', text: 'SYNC LSDJ', warn: false}], 'the master clock\'s own choice');
assert.deepEqual(chips(live({live: true, mute: 0b1010, freeze: 1}), T).map(x => x.text), ['LIVE MODE', 'MUTE PU2 NOI', 'ECHO FREEZE']);
assert.deepEqual(chips(live({battery: {bars: 1, usb: false}}), T), [{k: 'battery', text: 'BATTERY ▮▯▯', warn: true}]);
assert.deepEqual(chips(live({battery: {bars: 3, usb: true}}), T), [], 'on USB: no battery chip');
assert.deepEqual(chips(live({sync: 'off'}), T + LIVE_OLD_MS + 1), [], 'stale: nothing');

console.log('PASS dj-info: channel steps carried on at the tempo, the chain (phrase of, bars left, the last bar), the song row and the next empty row, the chips');
