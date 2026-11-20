// SPDX-License-Identifier: GPL-3.0-only
// sameFm1: an FM-1 known again on new ports (app.js reconnect, dj-ui.js take-back): by firmware and LSDj, the
// songs' checksum between two alike; never a guess.
import assert from 'node:assert/strict';
import {sameFm1} from '../lsdj/link.js';

const fm1 = (key, title, firmware, saveCrc) => ({key, info: {title, firmware, saveCrc}});
const of = d => d.info;
const was = {title: 'LSDj-v9.3.9', firmware: 'FM-1_998', saveCrc: 7};
assert.equal(sameFm1([fm1('out-6', 'LSDj-v9.3.9', 'FM-1_998', 9)], was, of)?.key, 'out-6', 'one alike: it (its songs may have changed)');
assert.equal(sameFm1([fm1('out-6', 'LSDj-v9.3.9', 'FM-1_997', 7)], was, of), null, 'older firmware: no');
assert.equal(sameFm1([fm1('out-6', 'LSDj-v9.3.9', 'FM-1_999', 7)], was, of)?.key, 'out-6', 'one with a newer firmware (just updated): it');
assert.equal(sameFm1([fm1('out-6', 'LSDj-v9.4.0', 'FM-1_999', 3)], was, of)?.key, 'out-6', 'newer firmware, another LSDj: it');
assert.equal(sameFm1([fm1('a', 'LSDj-v9.3.9', 'FM-1_999', 7), fm1('b', 'LSDj-v9.3.9', 'FM-1_999', 7)], was, of), null, 'two newer: the user chooses');
assert.equal(sameFm1([fm1('out-6', 'LSDj-v9.2.1', 'FM-1_998', 7)], was, of), null, 'other LSDj: no');
assert.equal(sameFm1([fm1('a', 'LSDj-v9.3.9', 'FM-1_998', 1), fm1('b', 'LSDj-v9.3.9', 'FM-1_998', 7)], was, of)?.key, 'b', 'two alike: its songs decide');
assert.equal(sameFm1([fm1('a', 'LSDj-v9.3.9', 'FM-1_998', 7), fm1('b', 'LSDj-v9.3.9', 'FM-1_998', 7)], was, of), null, 'two the same: the user chooses');
assert.equal(sameFm1([fm1('a', 'LSDj-v9.3.9', 'FM-1_998', 7)], null, of), null, 'nothing known of it: no');
assert.equal(sameFm1([], was, of), null);
console.log('same-fm1: PASS (known again by firmware and LSDj; the songs decide between two; never a guess)');
