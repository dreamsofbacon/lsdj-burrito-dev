// SPDX-License-Identifier: GPL-3.0-only
// lsdj/presets.js: a slot's 128 bytes (as firmware/lsdj_presets.h lays them out) to a preset and back, names, the
// preset and bank files, refusals, the summary; PRESET GLIDE in the feature switches; INFO's presets flag
// (node tests/presets.mjs).
import assert from 'node:assert/strict';
import {SLOTS, KEYS, fromSlot, toSlot, cleanName, presetFile, bankFile, readPresetFile, fileName, summary} from '../lsdj/presets.js';
import {FEATURES, unpackFeatures, packFeatures, FEATURE_DEFAULTS} from '../lsdj/fx-model.js';
import {infoFrom} from '../lsdj/link.js';

/* effects words as the FM-1 packs them: byte 42 the mark, 37 the layout; then whatever is set */
const fxWords = set => {
  const b = new Uint8Array(76); b[42] = 0xF2; b[37] = 2; b[56] = 0;
  for (const [i, v] of Object.entries(set)) b[i] = v;
  return Array.from({length: 19}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
};
const sample = (over = {}) => ({name: 'DUB ECHO', fx: fxWords({30: 40, 68: 20, 0: 1}), settings: 0x5A000007, midi: 0x4D000001, feat: 0x460001CE,
  theme: [0xFFFF, 0xAD55, 0x52AA, 0, 0x1234, 0x4321, 0xF800, 0x07E0], ...over});

{ /* bytes: the layout of firmware/lsdj_presets.h */
  const b = toSlot(sample());
  assert.equal(b.length, 128); assert.equal(b[0], 0x50); assert.equal(b[1], 19);
  assert.equal(String.fromCharCode(...b.slice(2, 14)), 'DUB ECHO    ');
  assert.equal(b[14], 0); assert.equal(b[15], 0);
  assert.equal(b[16 + 42], 0xF2);                                   /* the effects from byte 16 */
  assert.deepEqual([...b.slice(92, 96)], [7, 0, 0, 0x5A]);           /* settings */
  assert.deepEqual([...b.slice(104, 106)], [0xFF, 0xFF]);            /* the first colour */
  assert.ok(b.slice(120).every(v => v === 0));
  assert.deepEqual(fromSlot(b), sample());
  assert.equal(fromSlot(new Uint8Array(128)), null);                 /* empty */
  assert.deepEqual(toSlot(null), new Uint8Array(128));
  const newer = b.slice(); newer[1] = 21; assert.throws(() => fromSlot(newer), /newer firmware/);
  assert.throws(() => fromSlot(new Uint8Array(100)), /128 bytes/);
}
{ /* names: the FM-1's letters, upper case, 12 at most */
  assert.equal(cleanName('dub echo'), 'DUB ECHO'); assert.equal(cleanName('  a~b  '), 'A B');
  assert.equal(cleanName('ABCDEFGHIJKLMNO'), 'ABCDEFGHIJKL'); assert.equal(cleanName('é'), '');
  assert.equal(String.fromCharCode(...toSlot(sample({name: 'lo-fi #2'})).slice(2, 14)), 'LO-FI #2    ');
  assert.throws(() => toSlot(sample({name: '~~'})), /needs a name/);
}
{ /* refusals: not this firmware's words */
  assert.throws(() => toSlot(sample({fx: fxWords({}).slice(0, 17)})), /effects/);
  assert.throws(() => toSlot(sample({fx: fxWords({42: 0})})), /effects/);
  assert.throws(() => toSlot(sample({settings: 0x4D000000})), /settings/);
  assert.throws(() => toSlot(sample({midi: 0})), /MIDI/);
  assert.throws(() => toSlot(sample({feat: 0x5A000000})), /switches/);
  assert.throws(() => toSlot(sample({theme: [1, 2, 3]})), /colours/);
  assert.throws(() => toSlot(sample({theme: [0, 0, 0, 0, 0, 0, 0, 0x10000]})), /colours/);
}
{ /* files: one, all 8 (empty slots null); wrong files */
  const one = readPresetFile(presetFile(sample(), 'FM-1_998'));
  assert.equal(one.kind, 'one'); assert.deepEqual(one.preset, sample());
  assert.equal(JSON.parse(presetFile(sample(), 'FM-1_998')).firmware, 'FM-1_998');
  const all = [sample(), null, sample({name: 'B'}), null, null, null, null, sample({name: 'LAST'})];
  const bank = readPresetFile(bankFile(all));
  assert.equal(bank.kind, 'bank'); assert.deepEqual(bank.presets, all);
  assert.throws(() => bankFile(all.slice(0, 7)), /8 slots/);
  assert.throws(() => readPresetFile('nope'), /not a presets file/);
  assert.throws(() => readPresetFile('{"format":"lsdj-burrito-fx","version":1}'), /lsdj-burrito-fx file, not presets/);
  assert.throws(() => readPresetFile('{}'), /not an LSDJ Burrito presets file/);
  assert.throws(() => readPresetFile(JSON.stringify({format: 'lsdj-burrito-presets', version: 1, presets: [null]})), /8 slots/);
  const bad = JSON.parse(presetFile(sample())); bad.settings = 1;
  assert.throws(() => readPresetFile(JSON.stringify(bad)), /settings/);
  assert.equal(fileName(sample(), 0), 'dub-echo.preset.json'); assert.equal(fileName(null, 2), 'preset-3.preset.json');
}
{ /* the summary */
  assert.equal(summary(sample()), 'echo, reverb, filter PU1');
  assert.equal(summary(sample({fx: fxWords({})})), 'no effects');
  assert.equal(summary(sample({fx: fxWords({39: 1, 30: 50})})), 'all effects off');
  assert.equal(summary(sample({fx: fxWords({0: 1, 35: 1, [7 + 3]: 60, [44 + 6 * 2 + 3]: 9})})), 'drive PU2, LFO WAV');   /* PU1's FX off */
  assert.equal(SLOTS, 8); assert.deepEqual(KEYS, ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
}
{ /* PRESET GLIDE: bits 20-22, stored XOR 1; a word from before reads 0.1 s and packs back unchanged */
  const g = FEATURES.find(f => f.key === 'presetGlide');
  assert.deepEqual(g.bits, [20, 3]); assert.equal(g.choices.length, 8); assert.equal(FEATURE_DEFAULTS.presetGlide, 1);
  const old = 0x460001CE, o = unpackFeatures(old);
  assert.equal(o.presetGlide, 1); assert.equal(packFeatures(o), old);
  o.presetGlide = 0; assert.equal(packFeatures(o), (old | 1 << 20) >>> 0);
  o.presetGlide = 4; assert.equal(unpackFeatures(packFeatures(o)).presetGlide, 4);
}
{ /* INFO: flags bit 3 */
  const d = new Array(35).fill(0); d[34] = 1 | 2 | 8;
  assert.equal(infoFrom(d).presets, true); d[34] = 3; assert.equal(infoFrom(d).presets, false);
}
console.log('PASS presets: slot bytes both ways, names, refusals, preset and bank files, summary, PRESET GLIDE, INFO flag');
