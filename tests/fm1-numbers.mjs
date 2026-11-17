// SPDX-License-Identifier: GPL-3.0-only
// FM-1 numbers (lsdj/fm1-numbers.js): an FM-1 keeps "FM-1 1" / "FM-1 2" while plugged in. By its place in the list
// by port, a reflashed FM-1 (Windows gives it new ports) swapped numbers with the other, and the DJ decks' labels
// with them (Colin's DJ test, 2026-11-17).
import assert from 'node:assert/strict';
import {fm1Numbers} from '../lsdj/fm1-numbers.js';

const dev = id => ({output: {id}});
const byPort = list => list.slice().sort((a, b) => a.output.id.localeCompare(b.output.id));
const n = fm1Numbers();
const a = dev('output-2'), b = dev('output-3');
let list = n.renumber(byPort([b, a]));
assert.deepEqual(list, [a, b]); assert.equal(n.no(a), 1); assert.equal(n.no(b), 2);

/* A reflashes: gone, then back on new ports that sort after B's. By port it would be FM-1 2 now */
list = n.renumber(byPort([b]));
assert.equal(n.no(b), 2, 'B keeps its number while A is away');
const a2 = dev('output-6');
list = n.renumber(byPort([b, a2]));
assert.equal(n.no(a2), 1, 'A is FM-1 1 again'); assert.equal(n.no(b), 2);
assert.deepEqual(list, [a2, b], 'listed in number order');

/* a third plugged in: the next number; the first pulled: its number free for the next one found */
const c = dev('output-1');
list = n.renumber(byPort([b, a2, c]));
assert.equal(n.no(c), 3);
list = n.renumber(byPort([b, c]));
const d = dev('output-9');
n.renumber(byPort([b, c, d]));
assert.equal(n.no(d), 1); assert.equal(n.no(b), 2); assert.equal(n.no(c), 3);
assert.equal(n.no(a2), null, 'a pulled one has no number');

/* two new at once: numbered in port order */
const m = fm1Numbers(), x = dev('output-4'), y = dev('output-10');
m.renumber(byPort([x, y]));
assert.equal(m.no(y), 1); assert.equal(m.no(x), 2);

console.log('PASS FM-1 numbers: kept while plugged in, a reflashed FM-1 takes its own number back, not its place by port');
