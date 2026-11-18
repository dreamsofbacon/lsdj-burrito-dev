// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: the tempo controls' maths, no page or MIDI (lsdj/dj-ui.js draws them; node tests/dj-tempo.mjs).
//   - − / + steps (1 BPM with Whole BPM, else 0.1), held: repeating, then bigger steps;
//   - half / double time, kept inside LSDj's 40-295 (null when it would leave it);
//   - a glide: from one tempo to another over a number of bars, even in beats (the tempo at each clock);
//   - the tempo fader's range (±8, ±16 or ±50 %), in hundredths of a percent against the master;
//   - tempo memory pads: four tempos kept in this browser.
// A change "on the next bar" (pads, ×½ / ×2, a glide's start) waits for nextOn() in dj.js; the steps and nudges
// never wait (they are small, and by hand).
import {clampBpm, MIN_BPM, MAX_BPM} from './midiclock.js';
import {BAR} from './dj.js';

/* a tempo as set: whole, or to a tenth (as dj-ui.js's tempoOf) */
export const roundBpm = (b, whole) => { const c = clampBpm(b); return whole ? Math.round(c) : Math.round(c * 10) / 10; };

/* − / +: one step that way (dir -1 / 1), size times the smallest step */
export const stepSize = whole => whole ? 1 : 0.1;
export function stepBpm(bpm, dir, whole, size = 1) {
  if (!dir) return roundBpm(bpm, whole);
  return roundBpm(bpm + Math.sign(dir) * stepSize(whole) * size, whole);
}

/* Held − / +: a step at once, another after HOLD_MS, then every REPEAT_MS; after 10 repeats 2 steps at a time,
   after 30, 5 (whole: 1, 2, 5 BPM; else 0.1, 0.2, 0.5). step(dir, size) is called each time.
   timer: {set(f, ms) -> id, clear(id)} (setTimeout by default). */
export const HOLD_MS = 400, REPEAT_MS = 90;
export const repeatSize = n => n < 10 ? 1 : n < 30 ? 2 : 5;
export function repeater(step, timer = {set: (f, ms) => setTimeout(f, ms), clear: id => clearTimeout(id)}) {
  let id = null, n = 0, dir = 0;
  const again = () => { n++; step(dir, repeatSize(n)); id = timer.set(again, REPEAT_MS); };
  const release = () => { if (id != null) timer.clear(id); id = null; dir = 0; n = 0; };
  return {
    press(d) { release(); dir = Math.sign(d) || 0; if (!dir) return; step(dir, 1); id = timer.set(again, HOLD_MS); },
    release,
    get held() { return dir; },
  };
}

/* ×½ / ×2: null when the result leaves LSDj's range (never a clamp: half of 60 is not 40) */
export function scaleBpm(bpm, factor, whole) {
  const b = (+bpm || 0) * factor;
  if (!Number.isFinite(b) || b < MIN_BPM || b > MAX_BPM) return null;
  return roundBpm(b, whole);
}

/* Glide: {from, to, start (the clock it starts on), length (clocks)}; bpmAt -> {bpm, done}. Even in clocks, so each
   beat of the glide moves the tempo the same amount, whatever its speed. Before its start: from; after: to. */
export const GLIDE_BARS = [1, 2, 4, 8, 16];
export function glide(from, to, startClock, bars) {
  return {from: clampBpm(from), to: clampBpm(to), start: +startClock || 0, length: Math.max(1, Math.round(+bars || 1)) * BAR};
}
export function glideAt(g, clocks) {
  if (!g || clocks == null) return null;
  const f = Math.min(1, Math.max(0, (clocks - g.start) / g.length));
  return {bpm: f >= 1 ? g.to : g.from + (g.to - g.from) * f, done: f >= 1};
}

/* The tempo fader: its range in hundredths of a percent, and the value of a tempo against the master's */
export const PITCH_RANGES = [800, 1600, 5000];
export const rangeText = r => `±${r / 100} %`;
export const pickRange = r => PITCH_RANGES.includes(+r) ? +r : PITCH_RANGES[0];
export const pitchOf = (bpm, master, range) => Math.max(-range, Math.min(range, Math.round((bpm / master - 1) * 10000)));
/* the same, not held to a range: what the deck's percentage says (held to the fader's ±8 %, a deck 27 % off read
   "-8.00 %": Colin's DJ test, 2026-11-17) */
export const pitchFree = (bpm, master) => Math.round((bpm / master - 1) * 10000);
/* the smallest range that holds a pitch (at least the one chosen), or the widest */
export const rangeFor = (pitch, range) => PITCH_RANGES.find(r => r >= range && Math.abs(pitch) <= r) ?? PITCH_RANGES[PITCH_RANGES.length - 1];
export const bpmOfPitch = (v, master) => clampBpm(master * (1 + v / 10000));

/* Tempo memory pads: PADS tempos (null: empty), kept as JSON */
export const PADS = 4;
export function loadPads(text) {
  let l;
  try { l = JSON.parse(text || '[]'); } catch { l = []; }
  if (!Array.isArray(l)) l = [];
  return Array.from({length: PADS}, (_, i) => Number.isFinite(l[i]) && l[i] >= MIN_BPM && l[i] <= MAX_BPM ? l[i] : null);
}
export const savePads = pads => JSON.stringify(Array.from({length: PADS}, (_, i) => pads[i] ?? null));
