// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {unpackReverb, packReverbSends, packReverb, reverbSeconds, REVERB_PARAMS, valueText, PAGES, PAGES_997, PAGES_979, PAGES_978, LEGACY_PAGES, pagesForFx, firmwareNumber, unpackFx, packFx, paramGet, paramSet, channelSummary,
        FEATURES, FEATURE_DEFAULTS, packFeatures, unpackFeatures, MIDI_CC_MAP, THEMES, isMasterPage, effectActive} from '../lsdj/fx-model.js';

const setup = (layout, page, n = 17) => {
  const b = Array(4 * n).fill(0);
  b[35] = 6; b[36] = 5; b[37] = layout; b[38] = page; b[42] = 0xf2;
  return Array.from({length: n}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
};
assert.deepEqual(PAGES.map(p => p.name), ['MASTER', 'FILTER', 'DRIVE', 'LFO', 'LO-FI', 'ECHO', 'ECHO MOD']);
/* FM-1_979: echo send on FILTER K2 (next to Channel FX), filter type on LO-FI K3; 975-978 the other way round.
   FM-1_980: MASTER K3 / K4 = echo mix and time (also on ECHO) */
assert.deepEqual(PAGES_979.map(p => p.knobs.map(k => k?.[1] ?? null))[0], ['allFxOn', 'comp', null, null]);
assert.deepEqual(PAGES.map(p => p.knobs.map(k => k?.[1] ?? null)), [
  ['allFxOn', 'comp', 'mix', 'time'], ['fxOn', 'send', 'cutoff', 'reso'],
  ['drive', 'dist', 'warm', null], ['lfoRate', 'lfoDepth', 'lfoShape', 'lfoDest'],
  ['crush', 'decim', 'type', null], ['time', 'feedback', 'mix', 'tone'], ['wobble', 'sync', 'mode', 'freeze']
]);
assert.deepEqual(PAGES_978.map(p => p.knobs.map(k => k?.[1] ?? null))[1], ['fxOn', 'type', 'cutoff', 'reso']);
assert.deepEqual(PAGES_978.map(p => p.knobs.map(k => k?.[1] ?? null))[4], ['crush', 'decim', 'send', null]);
for (const pages of [PAGES, PAGES_979, PAGES_978]) {
  const keys = pages.slice(pages === PAGES ? 1 : 0).flatMap(p => p.knobs.filter(Boolean).map(k => k[1]));
  assert.equal(keys.length, new Set(keys).size);
}
assert.deepEqual(PAGES.slice(1), PAGES_979.slice(1));
/* 0.9.97 (FM-1_997): every effect once, the per-channel ones on the channel pages. LO-FI K3 the send; ECHO time,
   feedback, mix, tone; MASTER K3 freeze; FILTER K2 type */
assert.deepEqual(PAGES_997.map(p => p.knobs.map(k => k?.[1] ?? null)), [
  ['allFxOn', 'comp', 'freeze', null], ['fxOn', 'type', 'cutoff', 'reso'],
  ['drive', 'dist', 'warm', null], ['lfoRate', 'lfoDepth', 'lfoShape', 'lfoDest'],
  ['crush', 'decim', 'send', 'rvSend'], ['time', 'feedback', 'mix', 'tone'], ['wobble', 'sync', 'mode', null],
  ['rvMix', 'rvSize', 'rvTone', null]
]);
assert.ok(PAGES_997[7].rv && isMasterPage(unpackFx(setup(2, 0)), 7));
{ const keys = PAGES_997.filter(p => !p.rv).flatMap(p => p.knobs.filter(Boolean).map(k => k[1]));   /* every key, once */
  assert.deepEqual([...new Set(keys)].sort(), [...new Set([...PAGES.flatMap(p => p.knobs.filter(Boolean).map(k => k[1])), 'rvSend'])].sort());
  assert.equal(keys.length, new Set(keys).size); }
assert.equal(firmwareNumber('FM-1_979'), 979); assert.equal(firmwareNumber('FM-1_978'), 978); assert.equal(firmwareNumber('GameDude'), 0);
{ const v3 = unpackFx(setup(2, 1));
  assert.equal(pagesForFx(v3, 979), PAGES_979); assert.equal(pagesForFx(v3, 980), PAGES); assert.equal(pagesForFx(v3, 978), PAGES_978);
  assert.equal(pagesForFx(v3, 975), PAGES_978); assert.equal(pagesForFx(v3, 996), PAGES); assert.equal(pagesForFx(v3, 997), PAGES_997);
  assert.equal(pagesForFx(v3), PAGES_997); }
/* 0.9.97 reverb word: mix, size, tone a byte each (the 4th, dev.1-6's INPUT, ignored); dev.7 sends word: a byte per channel */
{ const r = unpackReverb(0x011E5A64, 0x40007F05);
  assert.deepEqual(r, {rvMix: 100, rvSize: 90, rvTone: 30, rvSend: [5, 127, 0, 64]});
  assert.equal(packReverb(r), 0x001E5A64); assert.equal(packReverbSends(r), 0x40007F05);
  assert.deepEqual(unpackReverb(0x001E5A64), {rvMix: 100, rvSize: 90, rvTone: 30, rvSend: null});   /* dev.1-6: no sends */
  for (const bad of [0x80, 0x8000, 0x800000, 0x02000000, -1, 1.5]) assert.throws(() => unpackReverb(bad));
  for (const bad of [0x80, 0x8000, 0x80000000, -1, 1.5]) assert.throws(() => unpackReverb(0, bad));
  assert.deepEqual(REVERB_PARAMS.map(p => p.key), ['rvMix', 'rvSize', 'rvTone']);
  assert.ok(Math.abs(reverbSeconds(0) - 0.4) < 0.15 && Math.abs(reverbSeconds(127) - 6) < 1.5, `${reverbSeconds(0)} .. ${reverbSeconds(127)}`);
  const fx = unpackFx(setup(2, 1)); fx.reverb = r;
  assert.equal(paramGet(fx, 'rvSize', 0), 90); paramSet(fx, 'rvMix', 0, 5); assert.equal(fx.reverb.rvMix, 5);
  assert.match(valueText(fx, 'rvSize', 0), / s$/);
  assert.equal(paramGet(fx, 'rvSend', 3), 64); paramSet(fx, 'rvSend', 2, 33); assert.deepEqual(fx.reverb.rvSend, [5, 127, 33, 64]);
  assert.equal(valueText(fx, 'rvSend', 2), '33'); fx.fxOff = 0; fx.bypass = 0; assert.match(channelSummary(fx, 2), /rev 33/);
  fx.reverb.rvMix = 0; paramSet(fx, 'rvSend', 0, 10); assert.equal(fx.reverb.rvMix, 64, 'a send with the reverb silent sets a mix');
  fx.reverb.rvSend = null; assert.equal(paramGet(fx, 'rvSend', 0), 0); assert.throws(() => paramSet(fx, 'rvSend', 0, 1));
  delete fx.reverb; assert.equal(paramGet(fx, 'rvMix', 0), 0); assert.throws(() => paramSet(fx, 'rvMix', 0, 1)); }
for (let page = 0; page < 7; page++) {
  const fx = unpackFx(setup(2, page));
  assert.equal(pagesForFx(fx), PAGES_997);
  for (let c = 0; c < 4; c++) {
    fx.ch[c].cutoff = 80; fx.q[c].warm = 40; fx.echo.mix = 90; fx.comp = 70;
    const original = structuredClone(fx);
    paramSet(fx, 'allFxOn', c, 0);
    assert.equal(paramGet(fx, 'allFxOn', (c + 1) % 4), 0);
    assert.match(channelSummary(fx, c), /All FX off/);
    const roundtrip = unpackFx(packFx(fx));
    assert.deepEqual(roundtrip, {...original, bypass: 1});
    paramSet(fx, 'allFxOn', c, 1);
    assert.deepEqual(fx, original);
  }
}
for (const n of [11, 17]) {
  for (let p = 0; p < (n === 11 ? 4 : 6); p++) {
    const words = setup(1, p, n), fx = unpackFx(words);
    assert.equal(pagesForFx(fx), LEGACY_PAGES);
    assert.equal(fx.page, n === 11 ? [0, 3, 4, 5][p] : p);
    assert.equal(fx.bypass, 0);
    assert.throws(() => paramSet(fx, 'allFxOn', 0, 0), /requires FM-1_975/);
    assert.deepEqual(packFx(fx), words);
  }
}
for (const malformed of [[], setup(2, 7), setup(2, 0, 11), [...setup(2, 0), 0]]) assert.throws(() => unpackFx(malformed));
const badFlag = setup(2, 0); badFlag[9] |= 2 << 24;
assert.throws(() => unpackFx(badFlag), /master effects/);
const oldKnobs = setup(1, 5); oldKnobs[10] |= 5;
assert.equal(unpackFx(oldKnobs).page, 0);
/* The feature switches (firmware/lsdj_feat.h): the defaults are the firmware's, every value round-trips,
   unknown bits and values are refused. */
assert.equal(packFeatures(FEATURE_DEFAULTS), 0x460001CE);
assert.deepEqual(unpackFeatures(0x460001CE), FEATURE_DEFAULTS);
for (const f of FEATURES) for (let v = 0; v < f.choices.length; v++) {
  const o = {...FEATURE_DEFAULTS, [f.key]: v};
  assert.deepEqual(unpackFeatures(packFeatures(o)), o);
}
assert.equal(FEATURES.find(f => f.key === 'fxTheme').choices.length, THEMES.length + 1);
assert.throws(() => unpackFeatures(0x4D0001CE), /Not a feature/);
assert.throws(() => unpackFeatures(0x460001CE | 1 << 23), /Unknown/);   /* (bits 20-22: PRESET GLIDE, 0.9.98-dev.6) */
// FM-1_989 SCREEN RATE: bits 18-19, 0 = 10 a second (older words read as before)
assert.equal(FEATURE_DEFAULTS.screenRate, 0);
assert.equal(unpackFeatures(0x460001CE | 3 << 18).screenRate, 3);
assert.equal(packFeatures({...FEATURE_DEFAULTS, screenRate: 2}), (0x460001CE | 2 << 18) >>> 0);
/* FM-1_981 AUTOSAVE: default every minute, also for a 979 / 980 word; Off sets bit 16 (stored XOR 1) */
assert.equal(FEATURE_DEFAULTS.autosave, 1);
assert.equal(unpackFeatures(0x460001CE).autosave, 1);
assert.equal(packFeatures({...FEATURE_DEFAULTS, autosave: 0}), (0x460001CE | 1 << 16) >>> 0);
assert.equal(unpackFeatures(0x460001CE | 1 << 16).autosave, 0);
assert.equal(unpackFeatures(0x460001CE | 3 << 16).autosave, 2);
/* FM-1_981: ECHO and ECHO MOD with MASTER (the Master box); before, MASTER alone */
{ const v3 = {v3: true};
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].filter(i => isMasterPage(v3, i)), [0, 5, 6]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].filter(i => isMasterPage(v3, i, 980)), [0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].filter(i => isMasterPage({v3: false}, i)), []); }
assert.throws(() => unpackFeatures(0x460001CE | (THEMES.length + 1) << 9), /Unknown/);
/* The CC map: every CC the firmware takes (firmware/lsdj_midi.h lsdj_midi_cc_num), once */
assert.deepEqual(MIDI_CC_MAP.map(m => m[0]).sort((a, b) => a - b),
  [70, 71, 74, 75, 76, 77, 91, 80, 81, 12, 13, 14, 15, 16, 17, 18, 19, 72, 73, 78, 79, 82, 83, 20, 21, 22, 23, 92].sort((a, b) => a - b));
assert.ok(MIDI_CC_MAP.every(m => m[2] === 'channel' || m[2] === 'shared'));
/* Dimmed when doing nothing (effectActive): the filter group needs a type, drive / LFO / crush / decimate their
   amount, sends and their effect a mix; Channel FX off dims the channel, All FX off everything; switches never */
{ const fx = unpackFx(setup(2, 1)), on = (k, c = 0) => effectActive(fx, k, c);
  fx.reverb = {rvMix: 0, rvSize: 64, rvTone: 64, rvSend: [0, 0, 0, 0]}; fx.fxOff = 0; fx.bypass = false;
  for (const k of ['type', 'cutoff', 'reso', 'warm', 'drive', 'dist', 'lfoRate', 'lfoDepth', 'crush', 'decim', 'send', 'rvSend',
    'time', 'feedback', 'mix', 'wobble', 'comp', 'rvMix', 'rvSize']) assert.equal(on(k), false, k + ' idle at rest');
  for (const k of ['allFxOn', 'fxOn', 'freeze']) assert.equal(on(k), true, k + ' (a switch) never idle');
  fx.ch[1].type = 1; assert.ok(on('cutoff', 1) && on('warm', 1) && !on('cutoff', 0), 'a filter type wakes its channel\'s filter');
  fx.ch[0].drive = 9; assert.ok(on('dist', 0) && !on('dist', 1));
  fx.q[2].lfoDepth = 5; assert.ok(on('lfoShape', 2) && on('lfoRate', 2) && !on('lfoRate', 0));
  fx.ch[3].crush = 1; assert.ok(on('crush', 3) && !on('decim', 3));
  fx.ch[0].send = 50; assert.ok(!on('send', 0), 'a send with the echo silent');
  fx.echo.mix = 30; assert.ok(on('send', 0) && on('feedback') && on('wobble') && !on('send', 1));
  fx.reverb.rvSend[1] = 20; assert.ok(!on('rvSend', 1)); fx.reverb.rvMix = 64; assert.ok(on('rvSend', 1) && on('rvTone') && !on('rvSend', 0));
  fx.comp = 3; assert.ok(on('comp'));
  fx.fxOff = 2; assert.ok(!on('cutoff', 1) && !on('rvSend', 1) && on('dist', 0) && on('fxOn', 1), 'Channel FX off: that channel idle');
  fx.bypass = true; assert.ok(!on('dist', 0) && !on('mix') && !on('comp') && on('allFxOn'), 'All FX off: all idle but the switch');
  delete fx.reverb; fx.bypass = false; assert.ok(!on('rvMix') && !on('rvSend', 1), 'no reverb (older firmware)'); }
console.log('PASS FX model: seven-page mapping (979 and 975-978), global bypass/settings roundtrip, 11/17-word legacy layouts, invalid data, feature switches, CC map');
