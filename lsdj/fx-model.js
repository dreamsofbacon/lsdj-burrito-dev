// SPDX-License-Identifier: GPL-3.0-only
// The firmware's data, as the page sees it. Mirrors firmware/lsdj_fx_ui.h
// (lsdj_fx_pack: 17 words since alpha 66, 11 before), firmware/lsdj_settings.h (one word) and
// firmware/lsdj_theme.h (8 RGB565 colours).

export const CHANNELS = ['PU1', 'PU2', 'WAV', 'NOI'];
/* Every effect, as firmware/lsdj_fx.h / lsdj_fx_ui.h (alpha 66: 17 words; 11 before).
   where: 'ch' per channel (bytes c*7+i), 'q' per channel, alpha 66 (bytes 44+c*6+i),
   'echo' (bytes 28+i), 'comp' (byte 43), 'flags' (fxOff bits, mute / freeze: live only). */
export const FILTERS = ['Off', 'Low-pass', 'High-pass', 'Band-pass', 'Notch', 'Low-pass 24 dB'];
export const CH_PARAMS = [   // per channel, in the packed order
  {key: 'type', name: 'Filter', choices: FILTERS},
  {key: 'cutoff', name: 'Cutoff'}, {key: 'reso', name: 'Resonance'}, {key: 'drive', name: 'Drive'},
  {key: 'crush', name: 'Crush'}, {key: 'decim', name: 'Decimate'}, {key: 'send', name: 'Echo send'}];
export const Q_PARAMS = [    // per channel, alpha 66, in the packed order
  {key: 'dist', name: 'Distortion', choices: ['Soft', 'Hard', 'Fold', 'Fuzz']},
  {key: 'warm', name: 'Warm'}, {key: 'lfoRate', name: 'LFO rate'}, {key: 'lfoDepth', name: 'LFO depth'},
  {key: 'lfoShape', name: 'LFO shape', choices: ['Sine', 'Triangle', 'Square', 'Saw', 'Random']},
  {key: 'lfoDest', name: 'LFO to', choices: ['Cutoff', 'Volume', 'Pan']}];
export const ECHO_PARAMS = [
  {key: 'time', name: 'Time'}, {key: 'feedback', name: 'Feedback'}, {key: 'mix', name: 'Mix'},
  {key: 'sync', name: 'Sync', choices: ['Free', 'Tempo']}, {key: 'mode', name: 'Mode', choices: ['Mono', 'Ping-pong']},
  {key: 'tone', name: 'Tone'}, {key: 'wobble', name: 'Wobble'}];
/* The FM-1's effects pages: KNOB 1-4 in order (firmware lsdj_fx_page_knob). Before alpha 66 only the old four. */
export const LEGACY_PAGES = [
  {name: 'FILTER', knobs: [['ch', 'drive'], ['ch', 'type'], ['ch', 'cutoff'], ['ch', 'reso']]},
  {name: 'TONE', knobs: [['ch', 'drive'], ['q', 'dist'], ['q', 'warm'], ['comp', 'comp']], v2: true},
  {name: 'LFO', knobs: [['q', 'lfoRate'], ['q', 'lfoDepth'], ['q', 'lfoShape'], ['q', 'lfoDest']], v2: true},
  {name: 'LO-FI', knobs: [['ch', 'crush'], ['ch', 'decim'], ['ch', 'send'], ['flags', 'fxOn']]},
  {name: 'ECHO', knobs: [['echo', 'time'], ['echo', 'feedback'], ['echo', 'mix'], ['echo', 'tone']]},
  {name: 'ECHO MORE', knobs: [['echo', 'wobble'], ['echo', 'sync'], ['echo', 'mode'], ['echo', 'freeze']]}];
/* FM-1_975 .. 978 */
export const PAGES_978 = [
  {name: 'MASTER', knobs: [['master', 'allFxOn'], ['comp', 'comp'], null, null]},
  {name: 'FILTER', knobs: [['flags', 'fxOn'], ['ch', 'type'], ['ch', 'cutoff'], ['ch', 'reso']]},
  {name: 'DRIVE', knobs: [['ch', 'drive'], ['q', 'dist'], ['q', 'warm'], null]},
  LEGACY_PAGES[2],
  {name: 'LO-FI', knobs: [['ch', 'crush'], ['ch', 'decim'], ['ch', 'send'], null]},
  LEGACY_PAGES[4],
  {...LEGACY_PAGES[5], name: 'ECHO MOD'}];
/* FM-1_979 and newer: the echo send on FILTER K2, next to Channel FX; the filter type on LO-FI K3.
   (The saved words do not say which: the firmware's number does.) */
export const PAGES_979 = PAGES_978.map((pg, i) =>
  i === 1 ? {name: 'FILTER', knobs: [['flags', 'fxOn'], ['ch', 'send'], ['ch', 'cutoff'], ['ch', 'reso']]} :
  i === 4 ? {name: 'LO-FI', knobs: [['ch', 'crush'], ['ch', 'decim'], ['ch', 'type'], null]} : pg);
/* FM-1_980 and newer: MASTER K3 / K4 are the echo's mix and time too (ECHO keeps them as well) */
export const PAGES = PAGES_979.map((pg, i) =>
  i === 0 ? {name: 'MASTER', knobs: [['master', 'allFxOn'], ['comp', 'comp'], ['echo', 'mix'], ['echo', 'time']]} : pg);
/* 0.9.97 (FM-1_997) and newer: every effect on one page only, the per-channel ones on the channel pages. LO-FI K3
   the echo send; ECHO time, feedback, mix, tone (all shared); ECHO MOD K4 empty; MASTER K3 freeze; FILTER K2 the
   filter type. (dev.2-5 had the send on ECHO K1, the tone on ECHO MOD K4.) REVERB, the 8th page, below. */
export const PAGES_997 = PAGES.map((pg, i) =>
  i === 0 ? {name: 'MASTER', knobs: [['master', 'allFxOn'], ['comp', 'comp'], ['echo', 'freeze'], null]} :
  i === 1 ? {name: 'FILTER', knobs: [['flags', 'fxOn'], ['ch', 'type'], ['ch', 'cutoff'], ['ch', 'reso']]} :
  i === 4 ? {name: 'LO-FI', knobs: [['ch', 'crush'], ['ch', 'decim'], ['ch', 'send'], ['rvch', 'rvSend']]} :
  i === 5 ? {name: 'ECHO', knobs: [['echo', 'time'], ['echo', 'feedback'], ['echo', 'mix'], ['echo', 'tone']]} :
  i === 6 ? {name: 'ECHO MOD', knobs: [['echo', 'wobble'], ['echo', 'sync'], ['echo', 'mode'], null]} : pg);
/* fw: the firmware's number (979 for FM-1_979; leave it out for the newest) */
/* 0.9.97: the master reverb, the firmware's 8th page (its own word over the link: REVERB_GET / REVERB_SET), fed by
   each channel's reverb send on LO-FI K4 (0.9.97-dev.7: REVERB_SENDS_GET / _SET; dev.1-6 had REVERB K4 INPUT
   instead). Shown only when the FM-1 has it (fx.reverb; fx.reverb.rvSend null on dev.1-6). */
PAGES_997.push({name: 'REVERB', knobs: [['rv', 'rvMix'], ['rv', 'rvSize'], ['rv', 'rvTone'], null], rv: true});
export const REVERB_PARAMS = [{key: 'rvMix', name: 'Reverb mix'}, {key: 'rvSize', name: 'Size'}, {key: 'rvTone', name: 'Tone'}];
/* the reverb word: mix, size, tone, a byte each, low first (firmware lsdj_fx_rv_word; the 4th byte was dev.1-6's
   INPUT, 0 or 1, ignored); s: the sends word (a byte per channel, PU1 low), or null when the FM-1 has none */
export function unpackReverb(w, s = null) {
  if (!Number.isInteger(w) || w < 0 || w > 0xFFFFFFFF) throw Error('Invalid reverb setup.');
  const r = {rvMix: w & 255, rvSize: (w >>> 8) & 255, rvTone: (w >>> 16) & 255, rvSend: s === null ? null : unpackReverbSends(s)};
  if (r.rvMix > 127 || r.rvSize > 127 || r.rvTone > 127 || w >>> 24 > 1) throw Error('Invalid reverb setup.');
  return r;
}
export function unpackReverbSends(s) {
  if (!Number.isInteger(s) || s < 0 || s > 0xFFFFFFFF) throw Error('Invalid reverb sends.');
  const v = [0, 1, 2, 3].map(c => (s >>> (8 * c)) & 255);
  if (v.some(x => x > 127)) throw Error('Invalid reverb sends.');
  return v;
}
export const packReverb = r => ((r.rvMix & 127) | (r.rvSize & 127) << 8 | (r.rvTone & 127) << 16) >>> 0;
export const packReverbSends = r => (r.rvSend || [0, 0, 0, 0]).reduce((w, v, c) => w | (v & 127) << (8 * c), 0) >>> 0;
/* about how long the tail takes to fade 60 dB (firmware lsdj_fx_update: decay per pass, lines 27-39 ms) */
export const reverbSeconds = v => -3 * (3288 - 354) / 4 / 22050 / Math.log10((9270 + Math.floor(v * (15775 - 9270) / 127)) / 16384);
export const firmwareNumber = id => +(/^FM-1_(9\d\d)$/.exec(id || '')?.[1] ?? 0);
export const pagesForFx = (fx, fw = Infinity) => !fx.v3 ? LEGACY_PAGES : fw >= 997 ? PAGES_997 : fw >= 980 ? PAGES : fw >= 979 ? PAGES_979 : PAGES_978;
/* FM-1_977 and newer: MASTER opens with FX held on the FM-1; tapping FX shows the others
   (FM-1_978: ECHO and ECHO MOD with the channel pages again; the echo is shared, each channel sends to it). */
export const MASTER_PAGES = [0];
/* FM-1_981: FX opens the panel until FX again; SELECT goes FILTER .. LO-FI, then MASTER, ECHO, ECHO MOD
   (the shared echo with the master pages). fw: the firmware's number (leave it out for the newest). */
export const MASTER_PAGES_981 = [0, 5, 6, 7];   // (7: REVERB, 0.9.97)
export const isMasterPage = (fx, i, fw = Infinity) => !!fx.v3 && (fw >= 981 ? MASTER_PAGES_981 : MASTER_PAGES).includes(i);
export const PAGES_OLD = [0, 3, 4, 5];   // the old firmware's page numbers -> these pages
export const PARAM = Object.fromEntries([
  ...CH_PARAMS.map(p => [p.key, {...p, where: 'ch'}]), ...Q_PARAMS.map(p => [p.key, {...p, where: 'q'}]),
  ...ECHO_PARAMS.map(p => [p.key, {...p, where: 'echo'}]),
  ['comp', {key: 'comp', name: 'Compressor', where: 'comp'}],
  ...REVERB_PARAMS.map(p => [p.key, {...p, where: 'rv'}]),
  ['rvSend', {key: 'rvSend', name: 'Reverb send', where: 'rvch'}],
  ['allFxOn', {key: 'allFxOn', name: 'All FX', where: 'master', choices: ['Off', 'On']}],
  ['fxOn', {key: 'fxOn', name: 'Channel FX', where: 'flags', choices: ['Off', 'On']}],
  ['freeze', {key: 'freeze', name: 'Freeze', where: 'flags', choices: ['Off', 'On'], live: true}]]);
const MARK = 0xF2;

const bytesOf = (words, n) => { const b = new Uint8Array(4 * n); words.slice(0, n).forEach((w, i) => { for (let j = 0; j < 4; j++) b[4 * i + j] = (w >>> (8 * j)) & 255; }); return b; };
const wordsOf = (b, n) => Array.from({length: n}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);

/* 17 words (alpha 66 and later: v2) or 11 */
export function unpackFx(words) {
  if (!Array.isArray(words) || ![11, 17].includes(words.length) ||
      words.some(w => !Number.isInteger(w) || w < 0 || w > 0xFFFFFFFF)) throw Error('Invalid effects setup.');
  const v2 = words.length >= 17, b = bytesOf(words, v2 ? 17 : 11);
  if (b[42] !== MARK) throw Error('Not an effects setup from this firmware.');
  if (b[37] > 2) throw Error('Unsupported effects layout. Update the webpage.');
  const v3 = b[37] === 2;
  if (v3 && (!v2 || b[38] >= PAGES.length || b[39] > 1 || b[40] || b[41])) throw Error('Invalid master effects setup.');
  const ch = CHANNELS.map((_, c) => Object.fromEntries(CH_PARAMS.map((p, i) => [p.key, b[c * 7 + i]])));
  const q = CHANNELS.map((_, c) => Object.fromEntries(Q_PARAMS.map((p, i) => [p.key, v2 ? b[44 + c * 6 + i] : 0])));
  const echo = Object.fromEntries(ECHO_PARAMS.map((p, i) => [p.key, b[28 + i]]));
  const page = v3 ? b[38] : b[39] || b[40] || b[41] ? 0 : v2 ? b[38] % LEGACY_PAGES.length : PAGES_OLD[b[38] & 3];
  return {v2, v3, ch, q, echo, comp: v2 ? b[43] : 0, fxOff: b[35], target: b[36], page, bypass: v3 ? b[39] : 0};
}
export function packFx(fx) {
  const n = fx.v2 ? 17 : 11, b = new Uint8Array(4 * n);
  fx.ch.forEach((c, ci) => CH_PARAMS.forEach((p, i) => { b[ci * 7 + i] = c[p.key] & 127; }));
  ECHO_PARAMS.forEach((p, i) => { b[28 + i] = fx.echo[p.key] & 127; });
  b[35] = fx.fxOff & 15; b[36] = fx.target; b[37] = fx.v3 ? 2 : 1; b[42] = MARK;
  if (fx.v3) b[39] = fx.bypass ? 1 : 0;
  if (fx.v2) {
    b[38] = fx.page; b[43] = fx.comp & 127;
    fx.q.forEach((c, ci) => Q_PARAMS.forEach((p, i) => { b[44 + ci * 6 + i] = c[p.key] & 127; }));
  } else b[38] = Math.max(0, PAGES_OLD.indexOf(fx.page));
  return wordsOf(b, n);
}

/* Values as the FM-1 shows them (lsdj_fxk_value). */
const LFO_NOTES = ['1/32', '1/16T', '1/16', '1/8T', '1/16.', '1/8', '1/4T', '1/8.', '1/4', '1/2T', '1/4.', '1/2', '1 bar', '2 bars', '4 bars'];
const ECHO_NOTES = LFO_NOTES.slice(0, 12), ECHO_U = [3, 4, 6, 8, 9, 12, 16, 18, 24, 32, 36, 48];
export function lfoRateText(v) {
  if (v >= 64) return LFO_NOTES[Math.floor((v - 64) * 15 / 64)];
  const step = Math.floor((4870 * 2 ** (v >> 3)) * (8 + (v & 7)) / 8);
  return (step * 44100 / 2 ** 32).toFixed(2).replace(/0$/, '') + ' Hz';
}
export function echoTimeText(fx, bpm) {
  const t = fx.echo.time;
  if (fx.echo.sync) return ECHO_NOTES[Math.floor(t * 12 / 128)];
  const max = 32768 - (4 * 96 + 4), m = fx.echo.mode ? Math.floor(max / 2) : max;
  return Math.round((64 + Math.floor(t * (m - 64) / 127)) * 1000 / 22050) + ' ms';
}
export function valueText(fx, key, c, bpm) {
  const p = PARAM[key], v = paramGet(fx, key, c);
  if (p.choices) return p.choices[v] ?? String(v);
  if (key === 'lfoRate') return lfoRateText(v);
  if (key === 'time') return echoTimeText(fx, bpm);
  if (key === 'tone') return v === 64 ? 'flat' : v < 64 ? `darker ${64 - v}` : `thinner ${v - 64}`;
  if (key === 'rvSize') return reverbSeconds(v).toFixed(1) + ' s';
  return String(v);
}
export function paramGet(fx, key, c) {
  const p = PARAM[key];
  switch (p.where) {
  case 'ch': return fx.ch[c][key];
  case 'q': return fx.q[c][key];
  case 'echo': return fx.echo[key];
  case 'comp': return fx.comp;
  case 'rv': return fx.reverb ? fx.reverb[key] : 0;
  case 'rvch': return fx.reverb?.rvSend?.[c] ?? 0;
  case 'master': return fx.bypass ? 0 : 1;
  default: return key === 'fxOn' ? ((fx.fxOff >> c) & 1 ? 0 : 1) : (fx.freeze ? 1 : 0);
  }
}
/* Is this effect doing something now? Perform dims the ones that aren't (as the Wiring greys its blocks): a filter
   setting with no filter type, drive and its distortion at drive 0, the LFO at depth 0, crush / decimate at 0, the
   echo (and a send to it) with its mix at 0, the same for the reverb, the compressor at 0; a channel with Channel FX
   off, and everything with All FX off. The switches (All FX, Channel FX, Freeze) are never dimmed. */
export function effectActive(fx, key, c = 0) {
  const p = PARAM[key];
  if (!p || p.where === 'master' || p.where === 'flags') return true;
  if (fx.v3 && fx.bypass) return false;
  const perCh = p.where === 'ch' || p.where === 'q' || p.where === 'rvch';
  if (perCh && (fx.fxOff >> c) & 1) return false;
  const ch = fx.ch[c] ?? {}, q = fx.q?.[c] ?? {}, echoOn = fx.echo.mix > 0, rvOn = !!fx.reverb?.rvMix;
  switch (key) {
  case 'type': case 'cutoff': case 'reso': case 'warm': return !!ch.type;
  case 'drive': case 'dist': return !!ch.drive;
  case 'lfoRate': case 'lfoDepth': case 'lfoShape': case 'lfoDest': return !!q.lfoDepth;
  case 'crush': return !!ch.crush;
  case 'decim': return !!ch.decim;
  case 'send': return echoOn && !!ch.send;
  case 'rvSend': return rvOn && !!fx.reverb.rvSend?.[c];
  case 'comp': return !!fx.comp;
  default: return p.where === 'echo' ? echoOn : p.where === 'rv' ? rvOn : true;
  }
}
export function paramSet(fx, key, c, v) {
  const p = PARAM[key];
  switch (p.where) {
  case 'ch': fx.ch[c][key] = v; if ((key === 'cutoff' || key === 'reso') && !fx.ch[c].type) fx.ch[c].type = 1; break;
  case 'q': fx.q[c][key] = v; if ((key === 'warm' || (key === 'lfoDepth' && fx.q[c].lfoDest === 0)) && v && !fx.ch[c].type) fx.ch[c].type = 1; break;
  case 'echo': fx.echo[key] = v; break;
  case 'comp': fx.comp = v; break;
  case 'rv':
    if (!fx.reverb) throw Error('The reverb needs 0.9.97 or newer firmware.');
    fx.reverb[key] = v; break;
  case 'rvch':   /* a send turned up with the reverb silent sets a mix, as the FM-1's knob does */
    if (!fx.reverb?.rvSend) throw Error('Reverb sends need 0.9.97 or newer firmware.');
    fx.reverb.rvSend[c] = v; if (v && !fx.reverb.rvMix) fx.reverb.rvMix = 64; break;
  case 'master':
    if (!fx.v3) throw Error('All FX requires FM-1_975 or newer firmware.');
    fx.bypass = v ? 0 : 1; break;
  default: if (key === 'fxOn') fx.fxOff = v ? fx.fxOff & ~(1 << c) : fx.fxOff | (1 << c);
  }
}
/* A short line per channel: what is on. */
export function channelSummary(fx, c) {
  const ch = fx.ch[c], q = fx.q[c], on = [];
  if (fx.bypass) return 'dry (All FX off)';
  if ((fx.fxOff >> c) & 1) return 'dry';
  if (ch.type) on.push(['', 'LP', 'HP', 'BP', 'Notch', 'LP24'][ch.type] + ' ' + ch.cutoff);
  if (ch.drive) on.push(['Soft', 'Hard', 'Fold', 'Fuzz'][q.dist] + ' ' + ch.drive);
  if (q.lfoDepth) on.push('LFO→' + ['cut', 'vol', 'pan'][q.lfoDest]);
  if (ch.crush || ch.decim) on.push('lo-fi');
  if (ch.send) on.push('echo ' + ch.send);
  if (fx.reverb?.rvSend?.[c]) on.push('rev ' + fx.reverb.rvSend[c]);
  return on.join(' · ') || 'clean';
}

export const THEMES = [
  'Classic', 'Pocket', 'Sunset', 'Ice', 'Bacon', 'Virtual', 'Midnight', 'Custom',
  'White Grey', 'Black Green', 'Black', 'Orange', 'Purple', 'White Blue', 'White Green', 'Dmg',
  'Gb Light', 'Sgb Sepia', 'Matrix', 'Amber Crt', 'C64', 'Cga', 'Terminal', 'Hot Dog',
  'Blueprint', 'Paper', 'Ink', 'Nord', 'Dracula', 'Solarized', 'Monokai', 'Gruvbox',
  'Vaporwave', 'Synthwave', 'Cyberpunk', 'Miami', 'Neon', 'Night Drive', 'Plasma', 'Toxic',
  'Galaxy', 'Aurora', 'Obsidian', 'Shadow', 'Ocean', 'Forest', 'Lava', 'Volcano',
  'Desert', 'Arctic', 'Sky', 'Seafoam', 'Swamp', 'Sakura', 'Olive', 'Tea',
  'Moon', 'Sun', 'Mars', 'Neptune', 'Gold', 'Steel', 'Rust', 'Emerald',
  'Ruby', 'Sapphire', 'Amethyst', 'Topaz', 'Pearl', 'Rose Gold', 'Coral', 'Bubblegum',
  'Candy', 'Cotton', 'Peach', 'Mint', 'Banana', 'Grape', 'Cherry', 'Lime',
  'Berry', 'Coffee', 'Burrito', 'Salsa', 'Guac', 'Taco', 'Horchata', 'Halloween',
  'Xmas', 'Kirby', 'Slime', 'Denim',
];   // generated by tools/themes.py (firmware repo): edit it there
export const CUSTOM_THEME = 7;
export const PRESETS = [   // gb[4] (lightest first), text, dark, accent, empty bar
  [0xE7DA, 0x9D50, 0x5308, 0x18E3, 0xFFFF, 0x18E3, 0xFD20, 0x4208],
  [0xFFFF, 0xAD55, 0x52AA, 0x0000, 0xFFFF, 0x0000, 0xFD20, 0x4208],
  [0xFFBA, 0xD42E, 0x786D, 0x2087, 0xFFFF, 0x2087, 0x07FF, 0x4208],
  [0xDFFF, 0x6E9C, 0x3274, 0x1108, 0xFFFF, 0x1108, 0xF81F, 0x4208],
  [0xFF9B, 0xF48C, 0xA226, 0x3082, 0xFFFF, 0x3082, 0x07E0, 0x4208],
  [0xF800, 0xA800, 0x5000, 0x0000, 0xFFFF, 0x0000, 0x07FF, 0x4208],
  [0xB71F, 0x5C19, 0x29CF, 0x0843, 0xFFFF, 0x0843, 0xFD20, 0x4208],
  null,   // 7: Custom
  [0xE6FA, 0xBDB5, 0x4229, 0x2966, 0xFFFF, 0x2966, 0xDA63, 0x4208],
  [0x8E99, 0x6D95, 0x4229, 0x2104, 0xFFFF, 0x2104, 0xDA63, 0x4208],
  [0x94F4, 0x630C, 0x3186, 0x18E3, 0xFFFF, 0x18E3, 0xDA63, 0x4208],
  [0xE369, 0xBA24, 0x6123, 0x18E3, 0xFFFF, 0x18E3, 0x7677, 0x4208],
  [0xDD7A, 0xC417, 0x9B56, 0x51ED, 0xFFFF, 0x51ED, 0xDA63, 0x4208],
  [0xEF5C, 0xC618, 0x5371, 0x320A, 0xFFFF, 0x320A, 0xDA63, 0x4208],
  [0xEF5C, 0xAEB9, 0x7657, 0x4B8D, 0xFFFF, 0x4B8D, 0xDA63, 0x4208],
  [0x9DC2, 0x8D42, 0x3306, 0x11C2, 0xFFFF, 0x11C2, 0xFA8A, 0x4208],
  [0x7F7A, 0x4634, 0x23CC, 0x0985, 0xFFFF, 0x0985, 0xFD04, 0x4208],
  [0xF738, 0xD54F, 0x92C6, 0x30C1, 0xFFFF, 0x30C1, 0x451F, 0x4208],
  [0x87F0, 0x35E6, 0x1302, 0x0040, 0xFFFF, 0x0040, 0xFFFF, 0x4208],
  [0xFDEC, 0xCC04, 0x7200, 0x1860, 0xFFFF, 0x1860, 0x45FF, 0x4208],
  [0x9D1F, 0x739B, 0x4191, 0x210C, 0xFFFF, 0x210C, 0xFFEC, 0x4208],
  [0xFFFF, 0x57FF, 0xFABF, 0x0000, 0xFFFF, 0x0000, 0xFFEA, 0x4208],
  [0xFFFF, 0xAD55, 0x52AA, 0x0000, 0xFFFF, 0x0000, 0x07E0, 0x4208],
  [0xFFE0, 0xF800, 0x8000, 0x0000, 0xFFFF, 0x0000, 0xFFFF, 0x4208],
  [0xFFFF, 0x9E1F, 0x2AF5, 0x094C, 0xFFFF, 0x094C, 0xFE60, 0x4208],
  [0xFFFD, 0xC636, 0x738D, 0x2104, 0xFFFF, 0x2104, 0xD986, 0x4208],
  [0xEF7F, 0x8497, 0x318C, 0x0843, 0xFFFF, 0x0843, 0xFDE8, 0x4208],
  [0xEF7E, 0x8DF9, 0x4AAD, 0x31A8, 0xFFFF, 0x31A8, 0xCC2E, 0x4208],
  [0xF7BD, 0xBC9E, 0x6394, 0x2947, 0xFFFF, 0x2947, 0x57CF, 0x4208],
  [0xFFBC, 0x9514, 0x5B6E, 0x0167, 0xFFFF, 0x0167, 0xCA63, 0x4208],
  [0xF7BD, 0xA706, 0x738B, 0x2944, 0xFFFF, 0x2944, 0xF12E, 0x4208],
  [0xFF98, 0xD4C4, 0x62EA, 0x2945, 0xFFFF, 0x2945, 0x8532, 0x4208],
  [0xFEBE, 0xFB99, 0x067F, 0x1846, 0xFFFF, 0x1846, 0x07E0, 0x4208],
  [0xF622, 0xFA2C, 0x506D, 0x1846, 0xFFFF, 0x1846, 0x077F, 0x4208],
  [0xFF61, 0x077F, 0x70F2, 0x1004, 0xFFFF, 0x1004, 0xF94D, 0x4208],
  [0xFFFF, 0x4E5D, 0xF130, 0x1866, 0xFFFF, 0x1866, 0xFE60, 0x4208],
  [0xF89D, 0x3FE2, 0x109F, 0x0000, 0xFFFF, 0x0000, 0xFFE0, 0x4208],
  [0xFEF5, 0xFC88, 0x4213, 0x0844, 0xFFFF, 0x0844, 0x47F9, 0x4208],
  [0xFE7F, 0xDB1F, 0x7117, 0x2008, 0xFFFF, 0x2008, 0x47F2, 0x4208],
  [0xDFE8, 0x9EE0, 0x4300, 0x10C0, 0xFFFF, 0x10C0, 0xF99F, 0x4208],
  [0xDEBF, 0x941B, 0x4190, 0x0844, 0xFFFF, 0x0844, 0xFEEC, 0x4208],
  [0xCFFC, 0x66F5, 0x6213, 0x0885, 0xFFFF, 0x0885, 0xFB17, 0x4208],
  [0xAD78, 0x630F, 0x2947, 0x0841, 0xFFFF, 0x0841, 0xFFE0, 0x4208],
  [0xBDF7, 0x8410, 0x4208, 0x1082, 0xFFFF, 0x1082, 0xFA08, 0x4208],
  [0xCF7E, 0x4E5C, 0x03B6, 0x002B, 0xFFFF, 0x002B, 0xFDA0, 0x4208],
  [0xD79B, 0x7633, 0x2B4A, 0x08E3, 0xFFFF, 0x08E3, 0xF50C, 0x4208],
  [0xFF2D, 0xFB46, 0x9945, 0x1841, 0xFFFF, 0x1841, 0x3EDF, 0x4208],
  [0xFE68, 0xFA82, 0x8080, 0x1800, 0xFFFF, 0x1800, 0x46FF, 0x4208],
  [0xF737, 0xDD6E, 0x9B06, 0x4102, 0xFFFF, 0x4102, 0x4577, 0x4208],
  [0xFFFF, 0xC6FD, 0x6495, 0x2188, 0xFFFF, 0x2188, 0xFB0C, 0x4208],
  [0xEFBF, 0x963D, 0x4417, 0x1108, 0xFFFF, 0x1108, 0xFD08, 0x4208],
  [0xDFFE, 0x86F8, 0x344F, 0x0945, 0xFFFF, 0x0945, 0xFB8A, 0x4208],
  [0xD6F3, 0x950A, 0x4AC5, 0x10C1, 0xFFFF, 0x10C1, 0xDB9F, 0x4208],
  [0xFF7E, 0xF5B8, 0xAACF, 0x3905, 0xFFFF, 0x3905, 0x7ECB, 0x4208],
  [0xE738, 0xAD6E, 0x6346, 0x1902, 0xFFFF, 0x1902, 0x041F, 0x4208],
  [0xEFBB, 0xB672, 0x6C2B, 0x1923, 0xFFFF, 0x1923, 0xDB10, 0x4208],
  [0xEF7D, 0xB5B7, 0x630E, 0x18C3, 0xFFFF, 0x18C3, 0xFE68, 0x4208],
  [0xFFFB, 0xFEEC, 0xDC00, 0x4100, 0xFFFF, 0x4100, 0x441F, 0x4208],
  [0xFEB7, 0xDBCA, 0x8184, 0x2041, 0xFFFF, 0x2041, 0x667F, 0x4208],
  [0xD73F, 0x649D, 0x2213, 0x0866, 0xFFFF, 0x0866, 0xFDE8, 0x4208],
  [0xFF75, 0xDD66, 0x8302, 0x20C0, 0xFFFF, 0x20C0, 0x451F, 0x4208],
  [0xDF1C, 0x9D55, 0x530E, 0x1905, 0xFFFF, 0x1905, 0xFC04, 0x4208],
  [0xEE75, 0xBB88, 0x7183, 0x2081, 0xFFFF, 0x2081, 0x45FB, 0x4208],
  [0xCFFC, 0x4672, 0x1389, 0x00E2, 0xFFFF, 0x00E2, 0xFB13, 0x4208],
  [0xFE7A, 0xDA0C, 0x8085, 0x2021, 0xFFFF, 0x2021, 0x46FF, 0x4208],
  [0xCEFF, 0x439B, 0x1192, 0x0045, 0xFFFF, 0x0045, 0xFE68, 0x4208],
  [0xEEBF, 0xAB9B, 0x6112, 0x1845, 0xFFFF, 0x1845, 0x87EC, 0x4208],
  [0xFF78, 0xFDE8, 0xAB82, 0x28E0, 0xFFFF, 0x28E0, 0x431F, 0x4208],
  [0xFFFE, 0xE71A, 0xA512, 0x39A6, 0xFFFF, 0x39A6, 0x451B, 0x4208],
  [0xFF3B, 0xE573, 0x9B4C, 0x30E3, 0xFFFF, 0x30E3, 0x6679, 0x4208],
  [0xFF3B, 0xFC0E, 0xBA09, 0x3082, 0xFFFF, 0x3082, 0x35F5, 0x4208],
  [0xFF1D, 0xFCD9, 0xC291, 0x3886, 0xFFFF, 0x3886, 0x367F, 0x4208],
  [0xFF7E, 0xFD59, 0x9B1B, 0x288A, 0xFFFF, 0x288A, 0x677B, 0x4208],
  [0xFFFF, 0xFE7C, 0xAEBF, 0x318A, 0xFFFF, 0x318A, 0xFC08, 0x4208],
  [0xFF7B, 0xFDB2, 0xBB4A, 0x38C2, 0xFFFF, 0x38C2, 0x449F, 0x4208],
  [0xE7FE, 0x9F38, 0x446E, 0x1185, 0xFFFF, 0x1185, 0xFAF1, 0x4208],
  [0xFFB5, 0xEE68, 0x9384, 0x3101, 0xFFFF, 0x3101, 0x631F, 0x4208],
  [0xE6BF, 0x9B9B, 0x5951, 0x2046, 0xFFFF, 0x2046, 0x9FEB, 0x4208],
  [0xFEFB, 0xFA8C, 0x9885, 0x3001, 0xFFFF, 0x3001, 0x46F7, 0x4208],
  [0xEFF9, 0xAF68, 0x5402, 0x1101, 0xFFFF, 0x1101, 0xFA13, 0x4208],
  [0xF6FD, 0xCB95, 0x810C, 0x2043, 0xFFFF, 0x2043, 0x66F3, 0x4208],
  [0xF75B, 0xBC2A, 0x5984, 0x2081, 0xFFFF, 0x2081, 0x7EBF, 0x4208],
  [0xFF9A, 0xEE09, 0x9A85, 0x28E2, 0xFFFF, 0x28E2, 0x5DCC, 0x4208],
  [0xFF39, 0xFB08, 0x3448, 0x1841, 0xFFFF, 0x1841, 0xFEE0, 0x4208],
  [0xEFFA, 0xA6AD, 0x4BC5, 0x10E1, 0xFFFF, 0x10E1, 0xFA88, 0x4208],
  [0xFF77, 0xE568, 0x8A22, 0x2081, 0xFFFF, 0x2081, 0x45EC, 0x4208],
  [0xFFBD, 0xE6B7, 0x9C4D, 0x3123, 0xFFFF, 0x3123, 0x041F, 0x4208],
  [0xFEB3, 0xFC60, 0x68F3, 0x1042, 0xFFFF, 0x1042, 0x7FE0, 0x4208],
  [0xF7FE, 0xDA08, 0x2388, 0x08C1, 0xFFFF, 0x08C1, 0xFEA0, 0x4208],
  [0xFF3D, 0xFD17, 0xCA0E, 0x4084, 0xFFFF, 0x4084, 0x451F, 0x4208],
  [0xE7FB, 0x976E, 0x3488, 0x0902, 0xFFFF, 0x0902, 0xFB1F, 0x4208],
  [0xDF3D, 0x84D6, 0x3A8E, 0x10C5, 0xFFFF, 0x10C5, 0xED68, 0x4208],
];
export const COLOR_NAMES = ['Lightest', 'Light', 'Dark', 'Darkest', 'Text', 'Box dark', 'Accent', 'Empty bar'];

export const toHex = c => '#' + [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31]
  .map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export const fromHex = h => { const v = parseInt(h.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  return (Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255); };

export const SETTINGS = [
  {key: 'knobsSwapped', bits: [0, 1], name: 'PRESETS knob', choices: ['Up/Down', 'Left/Right']},
  {key: 'presetsRev', bits: [1, 1], name: 'PRESETS direction', choices: ['Normal', 'Reversed']},
  {key: 'algoRev', bits: [2, 1], name: 'ALGO direction', choices: ['Normal', 'Reversed']},
  {key: 'playIsSelect', bits: [3, 1], name: 'PLAY / REC', choices: ['PLAY = Start', 'PLAY = Select']},
  {key: 'selectKey', bits: [4, 2], name: 'Extra Select key', choices: ['Off', 'F#5', 'D#5']},
  {key: 'meter', bits: [6, 1], name: 'CPU meter', choices: ['Off', 'On']},
  {key: 'theme', bits: [7, 3], hi: [12, 15, 16, 17], name: 'Theme', choices: THEMES},   // hi: where the value's bits 3, 4, 5, 6 go
  {key: 'popup', bits: [13, 2], name: 'Pop-up time (effects panel, messages)', choices: ['1.5 s', '3 s', '5 s', '10 s']}];
   // (bits 10-11: Bluetooth until FM-1_993)
/* The MIDI options (firmware/lsdj_midi.h, one word with 'M' on top; save-store record 16). */
const CH16 = Array.from({length: 16}, (_, i) => `Channel ${i + 1}`);
export const MIDI_SETTINGS = [
  {key: 'clockIn', bits: [0, 3], name: 'Clock in', choices: ['Off', 'All', 'USB', 'TRS']},
  {key: 'transport', bits: [3, 1], name: 'Transport (Start/Stop)', choices: ['Off', 'On']},
  {key: 'delay', bits: [4, 2], name: 'Sync delay', choices: ['100 ms', '75 ms', '50 ms']},
  {key: 'noteIn', bits: [6, 5], name: 'Note in (SYNC KEYBD)', choices: ['Off', 'All', ...CH16]},
  {key: 'ccFx', bits: [11, 4], name: 'CC to effects', choices: ['Off', ...Array.from({length: 13}, (_, i) => `Channels ${i + 1}-${i + 4}`)]},
  {key: 'clockOut', bits: [15, 1], name: 'Clock out (SYNC LSDJ)', choices: ['Off', 'USB']},   // (bit 16: Bluetooth until FM-1_993)
  {key: 'pcCue', bits: [17, 1], name: 'Program change cues row', choices: ['Off', 'On']}];
/* CC -> effects (firmware/lsdj_midi.h lsdj_midi_cc_apply). With CC FX = channels N..N+3, channel N
   is PU1, N+1 PU2, N+2 WAV, N+3 NOI; the shared ones (echo, compressor) work on any of the four.
   Choices are bands of the 0-127 value. [cc, what, 'channel' | 'shared'] */
export const MIDI_CC_MAP = [
  [70, 'Filter type: 0-21 off, 22-42 low-pass, 43-63 high-pass, 64-85 band-pass, 86-106 notch, 107-127 low-pass 24 dB', 'channel'],
  [74, 'Cutoff', 'channel'], [71, 'Resonance', 'channel'], [75, 'Drive', 'channel'],
  [79, 'Distortion: 0-31 soft, 32-63 hard, 64-95 fold, 96-127 fuzz', 'channel'], [78, 'Warm', 'channel'],
  [72, 'LFO rate', 'channel'], [73, 'LFO depth', 'channel'],
  [82, 'LFO shape: 0-25 sine, 26-51 triangle, 52-76 square, 77-102 saw, 103-127 random', 'channel'],
  [83, 'LFO to: 0-42 cutoff, 43-85 volume, 86-127 pan', 'channel'],
  [76, 'Crush', 'channel'], [77, 'Decimate', 'channel'], [91, 'Echo send', 'channel'], [92, 'Reverb send (0.9.97)', 'channel'],
  [80, 'Channel FX (64-127 on)', 'channel'], [81, 'Mute (64-127 muted)', 'channel'],
  [12, 'Echo time (synced: 12 note values)', 'shared'], [13, 'Echo feedback', 'shared'], [14, 'Echo mix', 'shared'],
  [15, 'Echo tone (64 flat)', 'shared'], [16, 'Echo wobble', 'shared'], [17, 'Echo sync (64-127 tempo)', 'shared'],
  [18, 'Echo mode (64-127 ping-pong)', 'shared'], [19, 'Freeze (64-127 on)', 'shared'], [20, 'Compressor', 'shared'],
  [21, 'Reverb mix (0.9.97)', 'shared'], [22, 'Reverb size', 'shared'], [23, 'Reverb tone', 'shared']];
export function unpackMidi(v) {
  if (v >>> 24 !== 0x4D) throw Error('Not a MIDI options word from this firmware.');
  return Object.fromEntries(MIDI_SETTINGS.map(s => [s.key, (v >>> s.bits[0]) & ((1 << s.bits[1]) - 1)]));
}
export function packMidi(o) {
  let v = 0x4D000000;
  for (const s of MIDI_SETTINGS) v |= (o[s.key] & ((1 << s.bits[1]) - 1)) << s.bits[0];
  return v >>> 0;
}
export function unpackSettings(v) {
  if (v >>> 24 !== 0x5A) throw Error('Not a settings word from this firmware.');
  return Object.fromEntries(SETTINGS.map(s => [s.key, ((v >>> s.bits[0]) & ((1 << s.bits[1]) - 1)) | (s.hi || []).reduce((a, b, i) => a | ((v >>> b) & 1) << (s.bits[1] + i), 0)]));
}
export function packSettings(o) {
  let v = 0x5A000000;
  for (const s of SETTINGS) {
    v |= (o[s.key] & ((1 << s.bits[1]) - 1)) << s.bits[0];
    (s.hi || []).forEach((b, i) => { v |= ((o[s.key] >> (s.bits[1] + i)) & 1) << b; });
  }
  return v >>> 0;
}

/* The feature switches (firmware/lsdj_feat.h: SETTINGS / FX+LIGHTS, one word with 'F' on top;
   save-store record 23, FM-1_979 and newer). */
export const FEATURES = [
  {key: 'pageWrap', bits: [0, 1], name: 'FX pages: SELECT goes round', choices: ['Off (stops at the first and last)', 'On']},
  {key: 'greyMuted', bits: [1, 1], name: 'Muted channel: FX panel grey', choices: ['Off', 'On'], def: 1},
  {key: 'mutePopup', bits: [2, 1], name: 'Muted channel: say why when its FX are turned', choices: ['Off', 'On'], def: 1},
  {key: 'showCc', bits: [3, 1], name: 'Show effects moved by MIDI CC', choices: ['Off', 'On'], def: 1},
  {key: 'ccOut', bits: [4, 1], name: 'FX knobs send their MIDI CC (USB)', choices: ['Off', 'On']},
  {key: 'knobs', bits: [5, 1], name: 'FX knobs', choices: ['Parameters: 4 effects of one channel', 'Channels: one effect on PU1 PU2 WAV NOI']},
  {key: 'pageLights', bits: [6, 1], name: 'Black keys show the page', choices: ['Off', 'On'], def: 1},
  {key: 'modeLights', bits: [7, 1], name: 'Light sweep on HOME (note / button mode)', choices: ['Off', 'On'], def: 1},
  {key: 'battery', bits: [8, 1], name: 'Battery on the FM-1\'s screen', choices: ['Off', 'On'], def: 1},
  {key: 'fxTheme', bits: [9, 7], name: 'FX panel colours', choices: ['Match the LSDj theme', ...THEMES]},
  /* FM-1_981. xor: stored as value XOR xor, so a word from 979 / 980 (no bits) reads as the default */
  {key: 'autosave', bits: [16, 2], xor: 1, name: 'Autosave', choices: ['Off', 'Every minute at most', 'Every 5 minutes at most', 'Every 15 minutes at most'], def: 1},
  /* FM-1_989: how often the FM-1 draws its screen (and so the mirror here); more costs CPU time next to the sound */
  {key: 'screenRate', bits: [18, 2], name: 'FM-1 screen: pictures a second (more costs CPU time next to the sound)', choices: ['10', '15', '20', '30']},
  /* 0.9.98-dev.6: a preset loaded slides the effects to its values over this long (older firmware: always 0 bits) */
  {key: 'presetGlide', bits: [20, 3], xor: 1, name: 'Preset glide: effects slide to a loaded preset over', choices: ['Off (at once)', '0.1 s', '0.25 s', '0.5 s', '1 s', '2 s', '4 s', '8 s'], def: 1}];
export const FEATURE_DEFAULTS = Object.fromEntries(FEATURES.map(f => [f.key, f.def || 0]));
export function unpackFeatures(v) {
  if (v >>> 24 !== 0x46) throw Error('Not a feature switches word from this firmware.');
  const o = Object.fromEntries(FEATURES.map(f => [f.key, ((v >>> f.bits[0]) & ((1 << f.bits[1]) - 1)) ^ (f.xor || 0)]));
  const used = FEATURES.reduce((m, f) => m | ((1 << f.bits[1]) - 1) << f.bits[0], 0);
  if ((v & 0xFFFFFF & ~used) || FEATURES.some(f => o[f.key] >= f.choices.length)) throw Error('Unknown feature switches. Update the webpage.');
  return o;
}
export function packFeatures(o) {
  let v = 0x46000000;
  for (const f of FEATURES) v |= ((Math.min(o[f.key] ?? f.def ?? 0, f.choices.length - 1) ^ (f.xor || 0)) & ((1 << f.bits[1]) - 1)) << f.bits[0];
  return v >>> 0;
}
