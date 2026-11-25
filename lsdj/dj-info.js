// SPDX-License-Identifier: GPL-3.0-only
// What the jog wheel shows of what LSDj is doing, from the FM-1's LIVE (link.js live / liveDj): the maths, no page
// (lsdj/dj-ui.js draws it; node tests/dj-info.mjs).
//   - each channel's phrase step (PU1 PU2 WAV NOI), carried on at the tempo between polls;
//   - the chain: which phrase of how many, and bars to its end;
//   - the song: its row, and rows to the next empty one (where LSDj goes back: unverified on an FM-1);
//   - chips for what isn't as usual: SYNC, live mode, mutes, the echo freeze, battery.
import {chainEnd} from './dj.js';
import {clampBpm} from './midiclock.js';

const NAMES = ['PU1', 'PU2', 'WAV', 'NOI'];
const mod = (a, n) => ((a % n) + n) % n;
const rowMs = bpm => 15000 / clampBpm(bpm);   /* a row is a sixteenth */
const mid = l => ((l.askedAt ?? l.gotAt ?? 0) + (l.gotAt ?? l.askedAt ?? 0)) / 2;   /* when LIVE was read: half-way */
export const LIVE_OLD_MS = 4000;   /* a LIVE older than this (the poll stalled) isn't shown */
const fresh = (l, t) => !!l && t - (l.gotAt ?? -Infinity) <= LIVE_OLD_MS;
const plays = (l, c) => !!((l.playing >> c) & 1);

/* each channel's phrase step now (0..15), or null (not playing, unknown, or a stale LIVE): the row it said, carried
   on at the tempo from when it was read. Each is 0..15 even when the next poll will correct it a little. */
export function channelSteps(l, t, bpm) {
  if (!fresh(l, t) || !l.rows || !bpm) return [null, null, null, null];
  const ahead = Math.max(0, t - mid(l)) / rowMs(bpm);
  return [0, 1, 2, 3].map(c => plays(l, c) && l.rows[c] != null ? Math.floor(mod((l.rows[c] & 15) + 0.5 + ahead, 16)) : null);
}

/* the channel whose chain is the song's section: the longest chain of those playing (a drum channel's short loop
   isn't the chain), or null */
export function chainChannel(l) {
  if (!l?.chainPos || !l.chainLen || !l.rows) return null;
  let c = null;
  for (let k = 0; k < 4; k++) if (plays(l, k) && l.chainPos[k] != null && l.chainLen[k] && l.rows[k] != null && (c == null || l.chainLen[k] > l.chainLen[c])) c = k;
  return c;
}

/* {phrase (1..), of, bars (to the chain's end, whole bars started counting this one), last (its last bar), end (ms)}
   or null. A bar is one phrase (16 rows). */
export function chainInfo(l, t, bpm) {
  if (!fresh(l, t) || !bpm) return null;
  const c = chainChannel(l);
  if (c == null) return null;
  const len = l.chainLen[c], end = chainEnd(l.chainPos[c], len, l.rows[c] & 15, mid(l), bpm, t);
  if (end == null) return null;
  const bars = Math.max(1, Math.ceil((end - t) / (16 * rowMs(bpm)) - 1e-6));
  return {phrase: len - bars + 1, of: len, bars, last: bars === 1, end, channel: c};
}

/* the song: {row (the playing channels' lowest song row), loops (rows to the next empty song row of a playing
   channel, 1 = after this one; null when none within `near` rows or the rows read don't reach)}, or null.
   map: song rows read (each [PU1, PU2, WAV, NOI] chains, null = empty) from song row `from`. */
export function songInfo(l, t, map, from, near = 8) {
  if (!fresh(l, t) || !l.songRows) return null;
  const at = [0, 1, 2, 3].filter(c => plays(l, c) && l.songRows[c] != null);
  if (!at.length) return null;
  const row = Math.min(...at.map(c => l.songRows[c]));
  let loops = null;
  if (map && from != null && from >= 0) {
    for (const c of at) {
      for (let n = 1; n <= near; n++) {
        const i = l.songRows[c] + n - from;
        if (i < 0 || i >= map.length) break;   /* (not read that far: not said) */
        if (map[i]?.[c] == null) { if (loops == null || n < loops) loops = n; break; }
      }
    }
  }
  return {row, loops};
}

/* the chips: [{k, text, warn}] for what isn't as usual (empty when all is). sync: LSDj's PROJECT › SYNC as LIVE
   says it; usual is KEYBD (stopped) or MIDI (the FM-1 switches to it while a deck plays it). master: this FM-1 is
   the master clock (SYNC = LSDJ is its own choice then, not a warning). */
export function chips(l, t, {master = false} = {}) {
  if (!fresh(l, t)) return [];
  const out = [];
  if (l.sync && l.sync !== 'keybd' && l.sync !== 'midi') out.push({k: 'sync', text: `SYNC ${l.sync.toUpperCase()}`, warn: !(master && l.sync === 'lsdj')});
  if (l.live) out.push({k: 'live', text: 'LIVE MODE', warn: false});
  const muted = NAMES.filter((n, c) => (l.mute >> c) & 1);
  if (muted.length) out.push({k: 'mute', text: `MUTE ${muted.join(' ')}`, warn: false});
  if (l.freeze) out.push({k: 'freeze', text: 'ECHO FREEZE', warn: false});   /* (the FM-1's echo held) */
  if (l.battery && !l.battery.usb) out.push({k: 'battery', text: `BATTERY ${'▮'.repeat(l.battery.bars)}${'▯'.repeat(3 - l.battery.bars)}`, warn: l.battery.bars <= 1});
  return out;
}
