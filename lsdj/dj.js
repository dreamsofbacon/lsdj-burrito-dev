// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: the maths, no page or MIDI (lsdj/dj-ui.js draws it; node tests/dj.mjs).
// Positions are in MIDI clocks (24 a beat, LSDj steps are sixteenths: 6 clocks a row), a bar is 4 beats.
//   - where a deck is in the bar, and how far it is from the master (wrapped to half a bar either way);
//   - Sync: the master's tempo, then a short speed-up or slow-down that closes the gap (a bend, never a jump:
//     LSDj on MIDI clock plays every clock it gets, so the page can only change how fast they come);
//   - the next beat or bar on the master, to start or kill on;
//   - crossfader curves, the DJ filter (one knob: low-pass to the left, high-pass to the right, off in the middle),
//     tap tempo.
import {PPQN, clampBpm} from './midiclock.js';

export const BEAT = PPQN, BAR = 4 * PPQN;
export const NUDGE = 0.04;              /* nudge: 4 % faster or slower while held */
export const SYNC_MAX_BEND = 0.08;      /* Sync never plays more than 8 % off the tempo */
export const SYNC_MIN_MS = 400;         /* ... and takes at least this long */

const mod = (a, n) => ((a % n) + n) % n;
/* clocks -> {bar, beat (0-3), frac (0-1 through the beat)}; null stays null */
export function position(clocks) {
  if (clocks == null) return null;
  const c = Math.max(0, clocks);
  return {bar: Math.floor(c / BAR), beat: Math.floor(mod(c, BAR) / BEAT), frac: mod(c, BEAT) / BEAT};
}
/* how many clocks the deck is behind the master (negative: ahead), wrapped to -BAR/2 .. BAR/2 */
export function offset(deck, master, unit = BAR) {
  if (deck == null || master == null) return null;
  const d = mod(master - deck, unit);
  return d >= unit / 2 ? d - unit : d;
}
/* Sync: the bend that closes `gap` clocks (offset()) at `bpm`: {factor, ms}; factor 1 when already there. */
export function syncBend(gap, bpm) {
  if (!gap) return {factor: 1, ms: 0};
  const clock = 60000 / (clampBpm(bpm) * PPQN);
  let ms = Math.max(SYNC_MIN_MS, Math.abs(gap) * clock / SYNC_MAX_BEND);
  return {factor: 1 + gap * clock / ms, ms};
}
/* the time of the master's next beat or bar (unit clocks) after `now`, given its phase now and tempo */
export function nextOn(masterPhase, bpm, now, unit = BAR) {
  if (masterPhase == null) return now;
  const clock = 60000 / (clampBpm(bpm) * PPQN), left = mod(-masterPhase, unit);
  return now + (left < 1e-9 || unit - left < 1e-9 ? 0 : left) * clock;
}
/* Play's "Start on" (the DJ layout): [key, label, unit in clocks]. A bar is one LSDj phrase (16 rows, 6 clocks each),
   so "Next bar" counted on a playing deck is that LSDj's next row 00; 2 .. 16 bars count from where it started.
   "Next chain": the playing deck's LSDj's next chain (its first phrase), from where it is in its chain (chainLeft; a bar
   when that isn't known). */
export const START_ON = [['now', 'Now', 0], ['beat', 'Next beat', BEAT], ['bar', 'Next bar (LSDj phrase)', BAR],
  ['chain', 'Next chain (LSDj)', BAR],
  ['2', 'Every 2 bars', 2 * BAR], ['4', 'Every 4 bars', 4 * BAR], ['8', 'Every 8 bars', 8 * BAR], ['16', 'Every 16 bars', 16 * BAR]];
export const startUnit = key => (START_ON.find(s => s[0] === key) ?? START_ON[2])[2];
/* when a deck starts: the next multiple of unit clocks on the reference (its phase in clocks now, at bpm); now for
   "Now" or no reference */
export function startTime(phase, bpm, now, unit) {
  return !unit || phase == null ? now : nextOn(phase, bpm, now, unit);
}
/* "Next chain": how many whole phrases the reference deck's LSDj still plays in its chain after the one it plays now.
   From its LIVE (0.9.98-dev.12): place p (0..15) of len phrases at phrase row `row`, read `ago` ms ago at bpm: the
   phrases it has started since (the row read is half done), then what is left of the chain; past its end the next
   chain is taken to be as long. null: not known (older firmware, not playing). A phrase is 16 rows (LSDj's H
   command, a shorter phrase, is not seen). */
export function chainLeft(p, len, row, ago, bpm) {
  if (p == null || !len || row == null) return null;
  const rows = row + 0.5 + Math.max(0, ago) * clampBpm(bpm) * 4 / 60000;
  return len - 1 - mod(p + Math.floor(rows / 16), len);
}
/* what's left before a start at `at` (ms), at bpm: whole beats left, rounded up (1 on the last beat), and the bars */
export function countIn(at, bpm, now) {
  const beats = Math.max(0, (at - now) * clampBpm(bpm) / 60000);
  return {beats: Math.max(0, Math.ceil(beats - 1e-6)), bars: Math.max(0, Math.ceil(beats / 4 - 1e-6))};
}

/* crossfader x 0 (all A) .. 1 (all B) -> [gain A, gain B] 0..1 */
export const CURVES = ['smooth', 'linear', 'cut'];
export function crossfade(x, curve = 'smooth') {
  const v = Math.min(1, Math.max(0, +x || 0));
  if (curve === 'linear') return [1 - v, v];
  if (curve === 'cut') return [v < 1 ? 1 : 0, v > 0 ? 1 : 0];   /* scratch style: both until the very end */
  return [Math.cos(v * Math.PI / 2), Math.sin(v * Math.PI / 2)];   /* constant power */
}
/* a 0..1 gain -> the FM-1's 0..127 */
export const level = g => Math.round(Math.min(1, Math.max(0, g)) * 127);

/* The DJ filter, one knob -64..63 (0 off) -> each channel's filter {type, cutoff, reso}: to the left low-pass with
   the cutoff coming down, to the right high-pass with it going up. Type numbers as fx-model.js (1 LP, 2 HP).
   reso: a little bite as it closes. A dead zone of ±2 around the middle is off. */
export function djFilter(k) {
  const v = Math.max(-64, Math.min(63, Math.round(+k || 0)));
  if (Math.abs(v) <= 2) return {type: 0, cutoff: 0, reso: 0};
  if (v < 0) return {type: 1, cutoff: Math.round(127 * (1 + v / 64) ** 1.5), reso: Math.round(-v / 64 * 40)};
  return {type: 2, cutoff: Math.round(127 * (v / 63) ** 0.75), reso: Math.round(v / 63 * 40)};
}

/* Tap tempo: tap(t) with each tap's time (ms) -> the tempo from the last 2..8 taps, or null; a gap over 2 s starts
   over. */
export function tapper() {
  let taps = [];
  return {
    tap(t) {
      if (taps.length && t - taps.at(-1) > 2000) taps = [];
      taps.push(t); if (taps.length > 8) taps.shift();
      if (taps.length < 2) return null;
      return clampBpm(Math.round(60000 * (taps.length - 1) / (taps.at(-1) - taps[0]) * 10) / 10);
    },
    reset() { taps = []; },
  };
}

/* the tempo of an outside clock (another device, a mixer, a DAW): feed(t) at each 0xF8 -> the tempo over the last
   beat (24 clocks), or null until there is one; a gap over 1 s starts over */
export function clockMeter() {
  let ts = [];
  return {
    feed(t) {
      if (ts.length && t - ts.at(-1) > 1000) ts = [];
      ts.push(t); if (ts.length > PPQN + 1) ts.shift();
      if (ts.length < PPQN + 1) return null;
      return Math.round(60000 / (ts.at(-1) - ts[0]) * 10) / 10;
    },
    reset() { ts = []; },
  };
}
