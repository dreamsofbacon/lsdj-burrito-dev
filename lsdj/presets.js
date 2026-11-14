// SPDX-License-Identifier: GPL-3.0-only
// Presets (FM-1 0.9.98-dev.6): 8 slots on the FM-1, each everything a player sets (effects, settings, MIDI options,
// feature switches, custom theme) with a name. Mirrors firmware/lsdj_presets.h: a slot is 128 bytes over the link
// (PRESET_GET / PRESET_PUT). Files: one preset (.json, format lsdj-burrito-preset) or all 8 (lsdj-burrito-presets).
// Pure: tests/presets.mjs.

export const SLOTS = 8, SLOT_BYTES = 128, NAME_LEN = 12, FX_WORDS = 19;
export const KEYS = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];   /* EDIT + this key loads the slot */
const USED = 0x50, OFF = {nfx: 1, name: 2, fx: 16, settings: 92, midi: 96, feat: 100, theme: 104, end: 120};
const FX_MARK = 0xF2;   /* the effects words' byte 42 (fx-model.js MARK) */
const FORMAT_ONE = 'lsdj-burrito-preset', FORMAT_BANK = 'lsdj-burrito-presets';

const rd32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
const wr32 = (b, i, v) => { for (let k = 0; k < 4; k++) b[i + k] = (v >>> (8 * k)) & 255; };

/* What a name may hold on the FM-1's screen (LSDj's letters): A-Z 0-9 space - # ? ! . : = + /; lower case is
   made upper case, anything else a space; 12 characters at most, no spaces at the ends. */
export function cleanName(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9 \-#?!.:=+/]/g, ' ').slice(0, NAME_LEN).trim();
}
/* 128 bytes from the FM-1 -> a preset, or null for an empty slot */
export function fromSlot(b) {
  if (!b || b.length !== SLOT_BYTES) throw Error('A preset slot is 128 bytes.');
  if (b[0] !== USED) return null;
  if (b[OFF.nfx] !== FX_WORDS) throw Error('This preset is from newer firmware. Update the page.');
  return {
    name: String.fromCharCode(...b.slice(OFF.name, OFF.name + NAME_LEN)).trim(),
    fx: Array.from({length: FX_WORDS}, (_, i) => rd32(b, OFF.fx + 4 * i)),
    settings: rd32(b, OFF.settings), midi: rd32(b, OFF.midi), feat: rd32(b, OFF.feat),
    theme: Array.from({length: 8}, (_, i) => b[OFF.theme + 2 * i] | b[OFF.theme + 2 * i + 1] << 8)};
}
/* a preset -> its 128 bytes for PRESET_PUT (null: an empty slot, all zeros) */
export function toSlot(p) {
  const b = new Uint8Array(SLOT_BYTES);
  if (!p) return b;
  check(p);
  const name = cleanName(p.name).padEnd(NAME_LEN, ' ');
  b[0] = USED; b[OFF.nfx] = FX_WORDS;
  for (let i = 0; i < NAME_LEN; i++) b[OFF.name + i] = name.charCodeAt(i);
  p.fx.forEach((w, i) => wr32(b, OFF.fx + 4 * i, w));
  wr32(b, OFF.settings, p.settings); wr32(b, OFF.midi, p.midi); wr32(b, OFF.feat, p.feat);
  p.theme.forEach((c, i) => { b[OFF.theme + 2 * i] = c & 255; b[OFF.theme + 2 * i + 1] = c >> 8; });
  return b;
}
const word = v => Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF;
/* the shape of a preset (the FM-1 checks every value again when it gets it) */
function check(p) {
  if (!p || typeof p !== 'object') throw Error('Not a preset.');
  if (!cleanName(p.name)) throw Error('A preset needs a name (letters or numbers).');
  if (!Array.isArray(p.fx) || p.fx.length !== FX_WORDS || !p.fx.every(word) || ((p.fx[10] >>> 16) & 255) !== FX_MARK)
    throw Error(`"${p.name}": its effects are not from this firmware.`);
  if (!word(p.settings) || p.settings >>> 24 !== 0x5A) throw Error(`"${p.name}": its settings are not from this firmware.`);
  if (!word(p.midi) || p.midi >>> 24 !== 0x4D) throw Error(`"${p.name}": its MIDI options are not from this firmware.`);
  if (!word(p.feat) || p.feat >>> 24 !== 0x46) throw Error(`"${p.name}": its FX and light switches are not from this firmware.`);
  if (!Array.isArray(p.theme) || p.theme.length !== 8 || !p.theme.every(c => Number.isInteger(c) && c >= 0 && c <= 0xFFFF))
    throw Error(`"${p.name}": its colours are not 8 colours.`);
}
const plain = p => ({name: cleanName(p.name), fx: p.fx.slice(), settings: p.settings, midi: p.midi, feat: p.feat, theme: p.theme.slice()});
/* files */
export function presetFile(p, firmware = '') {
  check(p);
  return JSON.stringify({format: FORMAT_ONE, version: 1, firmware, ...plain(p)}, null, 1);
}
export function bankFile(presets, firmware = '') {
  if (!Array.isArray(presets) || presets.length !== SLOTS) throw Error('A bank is 8 slots.');
  presets.forEach(p => p && check(p));
  return JSON.stringify({format: FORMAT_BANK, version: 1, firmware, presets: presets.map(p => p ? plain(p) : null)}, null, 1);
}
/* a file's text -> {kind: 'one', preset} or {kind: 'bank', presets: [8, null = empty]} */
export function readPresetFile(text) {
  let d; try { d = JSON.parse(text); } catch { throw Error('This is not a presets file.'); }
  if (d?.format === FORMAT_ONE && d.version === 1) { const p = plain(d); check(p); return {kind: 'one', preset: p}; }
  if (d?.format === FORMAT_BANK && d.version === 1) {
    if (!Array.isArray(d.presets) || d.presets.length !== SLOTS) throw Error('This presets file does not hold 8 slots.');
    return {kind: 'bank', presets: d.presets.map(p => { if (!p) return null; const q = plain(p); check(q); return q; })};
  }
  if (d?.format) throw Error(`This is a ${d.format} file, not presets.`);
  throw Error('This is not an LSDJ Burrito presets file.');
}
/* A file name from a preset's name: "dub-echo.preset.json" */
export const fileName = (p, i) => `${(cleanName(p?.name) || `preset ${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset'}.preset.json`;

/* What a preset's effects do, in a few words: "echo, reverb, filter PU1 WAV" (or "no effects") */
const CH = ['PU1', 'PU2', 'WAV', 'NOI'];
export function summary(p) {
  const b = [];
  for (const w of p.fx) for (let k = 0; k < 4; k++) b.push((w >>> (8 * k)) & 255);
  const off = b[35], bypass = b[37] === 2 && b[39];
  const on = c => !((off >> c) & 1);
  const chans = test => CH.filter((_, c) => on(c) && test(c));
  const parts = [];
  if (bypass) return 'all effects off';
  const filt = chans(c => b[c * 7]), drive = chans(c => b[c * 7 + 3]), lofi = chans(c => b[c * 7 + 4] || b[c * 7 + 5]);
  const lfo = chans(c => b[44 + c * 6 + 3]);
  if (b[28 + 2]) parts.push('echo');
  if (b[68]) parts.push('reverb');
  if (b[43]) parts.push('compressor');
  if (filt.length) parts.push('filter ' + filt.join(' '));
  if (drive.length) parts.push('drive ' + drive.join(' '));
  if (lofi.length) parts.push('lo-fi ' + lofi.join(' '));
  if (lfo.length) parts.push('LFO ' + lfo.join(' '));
  return parts.join(', ') || 'no effects';
}
