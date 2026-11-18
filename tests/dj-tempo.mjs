// SPDX-License-Identifier: GPL-3.0-only
// lsdj/dj-tempo.js: the DJ layout's tempo controls (node tests/dj-tempo.mjs).
import assert from 'node:assert/strict';
import {roundBpm, stepSize, stepBpm, repeater, repeatSize, HOLD_MS, REPEAT_MS, scaleBpm, glide, glideAt, GLIDE_BARS,
  PITCH_RANGES, rangeText, pickRange, pitchOf, pitchFree, rangeFor, bpmOfPitch, PADS, loadPads, savePads} from '../lsdj/dj-tempo.js';
import {BAR} from '../lsdj/dj.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* rounding and steps */
assert.equal(roundBpm(120.46, true), 120); assert.equal(roundBpm(120.46, false), 120.5);
assert.equal(roundBpm(10, false), 40, 'clamped to LSDj'); assert.equal(roundBpm(400, true), 295);
assert.equal(stepSize(true), 1); assert.equal(stepSize(false), 0.1);
assert.equal(stepBpm(120, 1, true), 121); assert.equal(stepBpm(120, -1, true), 119);
assert.equal(stepBpm(120, 1, false), 120.1); assert.equal(stepBpm(120.1, -1, false), 120);
assert.equal(stepBpm(120, 1, true, 5), 125, 'a bigger step');
assert.equal(stepBpm(295, 1, true), 295, 'the top stays'); assert.equal(stepBpm(40, -1, false), 40, 'the bottom stays');
assert.equal(stepBpm(120.4, 0, true), 120, 'no way: just rounded');
{ let b = 120; for (let i = 0; i < 10; i++) b = stepBpm(b, 1, false); assert.equal(b, 121, 'tenths add up without drift'); }

/* held: a step at once, then repeats, getting bigger */
{ const steps = [], timers = [];
  const timer = {set: (f, ms) => { timers.push({f, ms}); return timers.length; }, clear: id => { timers[id - 1].cleared = true; }};
  const r = repeater((dir, size) => steps.push([dir, size]), timer);
  r.press(1);
  assert.deepEqual(steps, [[1, 1]], 'a step at once');
  assert.equal(timers.at(-1).ms, HOLD_MS);
  for (let i = 0; i < 40; i++) timers.at(-1).f();
  assert.equal(timers.at(-1).ms, REPEAT_MS);
  assert.deepEqual(steps.slice(1, 3), [[1, 1], [1, 1]]);
  assert.deepEqual(steps[10], [1, 2], 'after 10 repeats: 2 at a time');
  assert.deepEqual(steps[30], [1, 5], 'after 30: 5');
  assert.equal(r.held, 1);
  r.release();
  assert.ok(timers.at(-1).cleared, 'let go: no more'); assert.equal(r.held, 0);
  steps.length = 0; r.press(-1);
  assert.deepEqual(steps, [[-1, 1]], 'the other way, from the start');
  r.press(0); assert.equal(r.held, 0); }
assert.equal(repeatSize(0), 1); assert.equal(repeatSize(9), 1); assert.equal(repeatSize(10), 2); assert.equal(repeatSize(30), 5);

/* half and double time: inside LSDj's range or not at all */
assert.equal(scaleBpm(170, 0.5, true), 85); assert.equal(scaleBpm(85, 2, true), 170);
assert.equal(scaleBpm(128.3, 0.5, false), 64.2, '64.15: to a tenth'); assert.equal(scaleBpm(128.3, 0.5, true), 64);
assert.equal(scaleBpm(60, 0.5, true), null, 'half of 60 is not 40'); assert.equal(scaleBpm(160, 2, true), null, '320: too fast');
assert.equal(scaleBpm(80, 0.5, true), 40, 'the bottom itself'); assert.equal(scaleBpm(NaN, 2, true), null);

/* glide: even in clocks */
assert.deepEqual(GLIDE_BARS, [1, 2, 4, 8, 16]);
{ const g = glide(120, 128, 1000, 8);
  assert.equal(g.length, 8 * BAR);
  assert.deepEqual(glideAt(g, 500), {bpm: 120, done: false}, 'before its start: from');
  assert.deepEqual(glideAt(g, 1000), {bpm: 120, done: false});
  assert.ok(near(glideAt(g, 1000 + 4 * BAR).bpm, 124), 'half way: half way');
  assert.ok(near(glideAt(g, 1000 + 2 * BAR).bpm, 122));
  assert.deepEqual(glideAt(g, 1000 + 8 * BAR), {bpm: 128, done: true});
  assert.deepEqual(glideAt(g, 99999), {bpm: 128, done: true}, 'after: to');
  assert.equal(glideAt(g, null), null); assert.equal(glideAt(null, 5), null); }
{ const g = glide(140, 70, 0, 2); assert.ok(near(glideAt(g, BAR).bpm, 105), 'down too'); }
assert.equal(glide(120, 400, 0, 0).to, 295, 'clamped; at least a bar');
assert.equal(glide(120, 130, 0, 0).length, BAR);

/* the tempo fader's range */
assert.deepEqual(PITCH_RANGES, [800, 1600, 5000]);
assert.equal(rangeText(800), '±8 %'); assert.equal(rangeText(5000), '±50 %');
assert.equal(pickRange('1600'), 1600); assert.equal(pickRange(123), 800, 'unknown: ±8 %'); assert.equal(pickRange(undefined), 800);
assert.equal(pitchOf(120, 120, 800), 0);
assert.equal(pitchOf(126, 120, 800), 500);
assert.equal(pitchOf(180, 120, 800), 800, 'past the range: its end');
assert.equal(pitchOf(180, 120, 5000), 5000);
/* the percentage as it is, and the range that holds it (Colin's DJ test: 240 BPM against 174 read -8.00 %) */
assert.equal(pitchFree(174, 240), -2750);
assert.equal(pitchFree(126, 120), 500);
assert.equal(rangeFor(500, 800), 800, 'within the chosen range: kept');
assert.equal(rangeFor(-1200, 800), 1600);
assert.equal(rangeFor(-2750, 800), 5000);
assert.equal(rangeFor(9000, 800), 5000, 'past the widest: the widest');
assert.equal(rangeFor(100, 1600), 1600, 'never narrower than the one chosen');
assert.equal(pitchOf(60, 120, 5000), -5000);
assert.ok(near(bpmOfPitch(500, 120), 126)); assert.ok(near(bpmOfPitch(-5000, 120), 60));
assert.equal(bpmOfPitch(5000, 250), 295, 'clamped');

/* memory pads */
assert.equal(PADS, 4);
assert.deepEqual(loadPads(''), [null, null, null, null]);
assert.deepEqual(loadPads('nonsense'), [null, null, null, null]);
assert.deepEqual(loadPads('{"a":1}'), [null, null, null, null]);
assert.deepEqual(loadPads('[120, null, 999, "x", 174, 90]'), [120, null, null, null], 'bad ones empty; four only');
assert.deepEqual(loadPads(savePads([128, null, 87.5])), [128, null, 87.5, null], 'round trip');
assert.equal(savePads([1, 2, 3, 4, 5]), '[1,2,3,4]');

console.log('PASS DJ tempo: − / + steps and holding, half / double time, glide, the tempo fader range, tempo pads');
