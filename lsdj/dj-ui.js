// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: two decks (A, B) and a mixer strip between them (the maths: lsdj/dj.js; mixers: lsdj/mixers.js;
// clocks: lsdj/midiclock.js). app.js mounts it and gives it the FM-1s (setDjHooks).
//   A deck is an FM-1 plugged in, or any other MIDI output (a drum machine, a DAW, a Game Boy on an ArduinoBoy: its
//   own deck type, with LSDj's speed notes; abSpeed). The page clocks each deck
//   itself, at its own tempo (LSDj PROJECT › SYNC = KEYBD, the FM-1 switching it to MIDI; CLOCK IN, TRANSPORT and PC CUE: each deck sets them, deckMidi / lsdjSync): Sync
//   matches the master's tempo and closes the gap to its bar by a short bend; nudge bends while held; Play starts on
//   the master's next bar. The master is a clock on this page (tempo, tap, Play / Stop) or one heard on a MIDI input
//   (a mixer, a DAW, an FM-1 with SYNC = LSDJ and CLOCK OUT = USB): its tempo and bar are followed.
//   FM-1 decks also get: stem kills (the channel mutes, now or on the next bar), the DJ filter (all four channels'
//   filters on one knob) and echo / reverb throws (sends up while held), or the mixer's own filter and FX send for
//   that channel (a choice per control), and a song-row cue (MIDI program change: GLO › MIDI › PC CUE on).
//   The mixer: a preset (mixers.js) or MIDI learn. Its controls drive the decks; the page's faders and crossfader
//   set its channel volumes when it takes them. Without a mixer the crossfader sets each FM-1's volume (0.9.98:
//   VOLUME_SET, times the MASTER knob; put back to full when the deck is emptied, the mixer changes or the layout
//   closes). 0.9.98 also gives: Hold (LSDj's live mode: each channel loops its chain), LSDj's SYNC set (0.9.98-dev.2) or warned of, and beat lights
//   from the FM-1's own phrase rows when this page isn't clocking it.
//   Each FM-1 deck shows, as chosen (Screen | Rows): its FM-1's screen (as Perform › Screen; FM-1_983 and newer),
//   on that FM-1's link, or (0.9.98) the song row map: click a row to cue it.
import {startClock, clampBpm, PPQN, CLOCK, START, CONTINUE, STOP, LOOKAHEAD_MS, workerTimer} from './midiclock.js';
import {sameFm1, OP} from './link.js';
import {BAR, BEAT, NUDGE, offset, syncBend, nextOn, crossfade, CURVES, djFilter, tapper, clockMeter} from './dj.js';
import {PRESETS, preset, readMidi, actionFor, out, learnRule, saveLearned, loadLearned} from './mixers.js';
import {stepBpm, repeater, scaleBpm, glide, glideAt, GLIDE_BARS, PITCH_RANGES, rangeText, pickRange, pitchOf, bpmOfPitch, PADS, loadPads, savePads} from './dj-tempo.js';
import {unpackFx, packFx, unpackReverb, packReverb, packReverbSends, CHANNELS, firmwareNumber, unpackSettings, PRESETS as THEME_COLOURS, CUSTOM_THEME, THEMES, unpackMidi, packMidi, paramSet, PARAM} from './fx-model.js';
import {fxPanel} from './dj-fx.js';
import {popOut, bringBack, isOut} from './popout.js';
import {pageColours} from './page-theme.js';
import {mountCrate, setCrateHooks, dropOnDeck, crateRedraw, CRATE_TYPE} from './crate-ui.js';
import {savHeader, HEADER, HEADER_SIZE, BLOCK_COUNT} from './lsdj-sav.js';
import {PARTS as KEY_PARTS, songKeys} from './song-key.js';
import {logEvent, logText, clearLog} from './conn-log.js';
import {fromSlot, KEYS as PRESET_KEYS} from './presets.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};
const NAMES = ['A', 'B'];
/* app.js: devices() -> [{key, label, fw}] (the FM-1s plugged in), linkFor(key) -> a Link or null, access() -> MIDIAccess
   or null, outputFor(key) -> the FM-1's MIDI output, takeClock() (Perform › Clock goes off: two clocks would fight),
   screen(key, link, canvas, onSupport) -> a started screen mirror ({stop}) on that link, or null */
let hooks = {devices: () => [], linkFor: () => null, access: () => null, outputFor: () => null, takeClock: () => {}, screen: () => null};
export function setDjHooks(h) { hooks = {...hooks, ...h}; }

const now = () => performance.now();
/* one-shot timers (bar-timed kills and tempo changes, a bend's end): a page timer, and a Worker's beat as well, as
   a hidden tab slows page timers to once a second (bars late). Whichever comes first runs it, once. (A new Worker can
   take seconds to start beating while the page loads: the page timer alone is never late in a shown tab.)
   later -> an id (never 0); cancelLater(id) */
const due = new Map();
let dueSeq = 0, dueStop = null;
function later(ms, f) {
  const id = ++dueSeq;
  due.set(id, {at: now() + ms, f, t: setTimeout(runDue, ms)});
  dueStop ??= workerTimer(runDue, 5);
  return id;
}
const cancelLater = id => { clearTimeout(due.get(id)?.t); due.delete(id); };
function runDue() {
  const t = now();
  for (const [id, x] of due) if (x.at <= t) { due.delete(id); clearTimeout(x.t); x.f(); }
  if (!due.size && dueStop) { dueStop(); dueStop = null; }
}
/* whole: Whole BPM (kept in this browser): every tempo set here snaps to a whole number (tap, typing, the mixer's +/-) */
/* the tempo controls (dj-tempo.js), kept in this browser: pads (four tempos), onBar (Next bar: pads, ×½ / ×2 and a
   glide's start wait for the master's next bar), padGlide (a pad glides there instead of jumping), glideBars;
   glide: one under way ({from, to, length, pos: clocks so far, at}); pending: a change waiting for the bar */
const master = {bpm: clampBpm(+store.get('dj-bpm', 120)), clock: null, source: 'page', ext: null, tap: tapper(),
  whole: store.get('dj-whole', '0') === '1',
  pads: loadPads(store.get('dj-pads', '[]')), onBar: store.get('dj-tempo-bar', '0') === '1', padGlide: store.get('dj-pad-glide', '0') === '1',
  glideBars: GLIDE_BARS.includes(+store.get('dj-glide-bars', 8)) ? +store.get('dj-glide-bars', 8) : 8, glide: null, pending: 0};
/* a tempo as set here: whole, or to a tenth */
const tempoOf = b => { const c = clampBpm(b); return master.whole ? Math.round(c) : Math.round(c * 10) / 10; };
const bpmText = b => master.whole ? String(Math.round(b)) : b.toFixed(1);
if (master.whole) master.bpm = tempoOf(master.bpm);
const mixer = {id: store.get('dj-mixer', 'none'), inId: store.get('dj-mixer-in', ''), outId: store.get('dj-mixer-out', ''),
  map: JSON.parse(store.get('dj-mixer-map', '[1,2]')), learned: loadLearned(store.get('dj-learned', '[]')), learning: null,
  xfader: 0.5, curve: store.get('dj-curve', 'smooth'), faders: {}, input: null, note: ''};
const decks = [0, 1].map(i => ({i, key: '', kind: '', bpm: master.bpm, clock: null, live: null, fx: null, rv: null, base: null,
  kill: 0, killOnBar: store.get('dj-killbar', '0') === '1', filter: 0, filterBy: 'fm1', throwBy: 'fm1', row: 0, sendTimer: 0, ui: null,
  level: null, levelSent: 127, levelBusy: false, scr: null, scrLink: null, scrOk: true,
  view: store.get(`dj-view-${i}`, 'screen'), map: null, mapFrom: -1, mapAt: 0, mapFill: null, abSpeed: 0,
  range: pickRange(store.get(`dj-range-${i}`, 800))}));
let root = null, ticker = 0, polling = 0, shown = false;
/* the deck's FM-1 firmware number (998: 0.9.98), 0 for other gear; cached until the FM-1 list changes */
const fwCache = new Map();
const fwOf = d => {
  if (d.kind !== 'fm1') return 0;
  if (!fwCache.has(d.key)) fwCache.set(d.key, firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw) || 0);
  return fwCache.get(d.key);
};
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

/* ---------- the master clock ---------- */
function masterClock() {
  if (!master.clock) master.clock = startClock({bpm: master.bpm, targets: []});   /* a reference: no targets */
  return master.clock;
}
/* the master's position (clocks since its Start) and tempo now, from this page's clock or the one heard */
function masterNow(t = now()) {
  if (master.source === 'page') return {phase: master.clock?.phase(t) ?? null, bpm: master.bpm};
  const e = master.ext;
  if (!e?.running) return {phase: null, bpm: e?.bpm || master.bpm};
  const b = e.bpm || master.bpm;
  return {phase: e.ticks + Math.min(1, (t - e.lastAt) * b * PPQN / 60000), bpm: b};
}
/* A tempo change updates the numbers only (the readout, by tick; the box, here), never the whole layout: Tap
   pressed quickly redrew both decks, their rows and the mixer on every tap and could freeze the page. */
function setMasterBpm(b) {
  master.bpm = tempoOf(b); store.set('dj-bpm', String(master.bpm));
  master.clock?.setTempo(master.bpm);
  const i = mixer.ui?.bpmIn;
  if (i && i.ownerDocument.activeElement !== i) i.value = master.bpm;
}
function setWhole(on) {
  master.whole = on; store.set('dj-whole', on ? '1' : '0');
  setMasterBpm(master.bpm);
  decks.forEach(d => d.synced ? followMaster(d) : setDeckBpm(d, d.bpm));   /* (synced: the master's, now whole) */
  draw();   /* the boxes' steps */
}
/* ---------- the tempo controls (dj-tempo.js): − / +, ×½ / ×2, back to the master, pads, a glide ---------- */
const pageMaster = () => master.source === 'page';   /* an outside master's tempo is its own: these leave it */
/* the master's tempo set by hand (− / +, Tap, typing, a pad, the mixer's encoder): a glide under way stops */
function handMasterBpm(b) {
  if (!pageMaster()) return;
  stopGlide();
  setMasterBpm(b);
}
const stepMaster = (dir, size = 1) => handMasterBpm(stepBpm(master.bpm, dir, master.whole, size));
const stepDeck = (d, dir, size = 1) => setDeckBpm(d, stepBpm(d.bpm, dir, master.whole, size));
/* Next bar on and the master playing: f waits for the master's next bar (a newer change replaces it); else now.
   It fires a lookahead early: the clocks already scheduled reach to the bar, so the new tempo starts there. */
function onBar(f, what) {
  cancelLater(master.pending); master.pending = 0;
  const t = now(), m = masterNow(t);
  if (!master.onBar || m.phase == null) { f(); return; }
  const ms = nextOn(m.phase, m.bpm, t) - t - LOOKAHEAD_MS;
  if (ms < 10) { f(); return; }
  say(`${what}: on the next bar.`);
  master.pending = later(ms, () => { master.pending = 0; f(); });
}
/* half / double time, the master's (decks synced to it follow) or a deck's; never outside LSDj's 40-295 */
function halfDouble(d, factor) {
  if (!d && !pageMaster()) return;
  const from = d ? d.bpm : master.bpm, b = scaleBpm(from, factor, master.whole), who = d ? `Deck ${NAMES[d.i]}` : 'Master';
  if (b == null) return say(`${who}: ${factor < 1 ? 'half' : 'double'} of ${bpmText(from)} BPM is outside LSDj's 40–295.`);
  onBar(() => { if (d) setDeckBpm(d, b); else handMasterBpm(b); say(`${who}: ${bpmText(b)} BPM.`); }, `${who} to ${bpmText(b)} BPM`);
}
/* a deck back on the master's tempo (pitch ±0), without Sync: by hand from there */
function matchMaster(d) {
  if (d.synced) return;
  setDeckBpm(d, masterBpm());
  if (d.ui?.pitch) d.ui.pitch.value = pitchValue(d);
  say(`Deck ${NAMES[d.i]}: back to the master's ${bpmText(d.bpm)} BPM.`);
}
/* the master onto a deck's LSDj tempo (its song's TEMPO, as the FM-1 last said: d.live.bpm), on the next bar with
   Next bar; decks synced to the master follow. (A deck this page clocks plays at the page's tempo instead.) */
function masterFromDeck(d) {
  if (!pageMaster()) return;
  const b = d.live?.bpm;
  if (!b) return say(`Deck ${NAMES[d.i]}: no LSDj tempo yet (an FM-1 deck, once it has answered).`);
  onBar(() => { handMasterBpm(b); say(`Master: deck ${NAMES[d.i]}'s LSDj tempo, ${bpmText(master.bpm)} BPM.`); },
    `Master to deck ${NAMES[d.i]}'s LSDj tempo, ${b} BPM`);
}
const lsdjBpmText = d => String(d.live?.bpm || '—');
/* a pad: tapped, the master goes to its tempo (on the next bar with Next bar; a glide with Pads glide); held, or
   tapped while empty, it keeps the master's tempo now */
function padGo(n) {
  const b = master.pads[n];
  if (b == null) return padSave(n);
  if (!pageMaster()) return;
  if (master.padGlide) return startGlide(b);
  onBar(() => { handMasterBpm(b); say(`Pad ${n + 1}: ${bpmText(b)} BPM.`); }, `Pad ${n + 1}, ${bpmText(b)} BPM`);
}
function padSave(n) {
  master.pads[n] = tempoOf(masterBpm()); store.set('dj-pads', savePads(master.pads));
  say(`Pad ${n + 1} keeps ${bpmText(master.pads[n])} BPM (hold a pad to keep the tempo now).`);
  showPads();
}
/* a glide: the master's tempo moves evenly, beat by beat, to `to` over master.glideBars bars (counted in clocks at
   the tempo as it goes, so it glides with the master stopped too); decks synced to the master follow it */
function startGlide(to) {
  if (!pageMaster()) return;
  const target = tempoOf(to);
  if (target === master.bpm) { stopGlide(); return say(`Master: already ${bpmText(target)} BPM.`); }
  onBar(() => {
    master.glide = {...glide(master.bpm, target, 0, master.glideBars), pos: 0, at: now()};
    say(`Master: gliding to ${bpmText(target)} BPM over ${master.glideBars} bar${master.glideBars > 1 ? 's' : ''}.`);
    showGlide();
  }, `Glide to ${bpmText(target)} BPM`);
}
function stopGlide() {
  if (!master.glide) return;
  master.glide = null; showGlide();
}
function glideTick(t) {
  const g = master.glide;
  if (!g) return;
  if (!pageMaster()) { stopGlide(); return; }
  g.pos += (t - g.at) * master.bpm * PPQN / 60000; g.at = t;
  const r = glideAt(g, g.pos);
  if (r.done) { master.glide = null; setMasterBpm(r.bpm); showGlide(); say(`Master: ${bpmText(master.bpm)} BPM.`); return; }
  master.bpm = r.bpm; master.clock?.setTempo(r.bpm);   /* (kept in this browser at the end) */
  const i = mixer.ui?.bpmIn;
  if (i && i.ownerDocument.activeElement !== i) i.value = bpmText(r.bpm);
}
/* the tempo fader's range (±8, ±16, ±50 %): the next one */
function nextRange(d) {
  d.range = PITCH_RANGES[(PITCH_RANGES.indexOf(d.range) + 1) % PITCH_RANGES.length];
  store.set(`dj-range-${d.i}`, String(d.range));
  const u = d.ui;
  if (u?.pitch) { u.pitch.min = -d.range; u.pitch.max = d.range; u.pitch.value = pitchValue(d); }
  if (u?.range) u.range.textContent = rangeText(d.range);
}
function masterPlay() {
  if (master.source !== 'page') { mixerSend('play'); return; }   /* an outside master: ask it (a mixer that takes it) */
  const c = masterClock();
  if (c.running) { c.stop(); decks.forEach(d => d.clock?.running && d.clock.stop()); drawPlay(); return; }
  const at = now() + 60;
  c.start(at);
  decks.forEach(d => { if (d.key) { deckClock(d).setTempo(d.bpm); if (!d.clock.running) d.clock.start(at); } });
  drawPlay();
}
/* Play / Stop changed: the decks' PLAY and nudge buttons and the mixer's Play all, not the whole layout */
function drawPlay(only = null) {
  (only ? [only] : decks).forEach(drawDeck);
  const b = mixer.ui?.playAll;
  if (!b) return;
  const running = master.source === 'page' ? !!master.clock?.running : !!master.ext?.running;
  b.textContent = running ? '■ Stop all' : '▶ Play all'; b.classList.toggle('on', running);
}
/* an outside master on a MIDI input: its clocks counted, its tempo measured */
function hearMaster(e) {
  const b = e.data?.[0], ext = master.ext;
  if (!ext) return;
  if (b === CLOCK) { ext.ticks++; ext.lastAt = e.timeStamp || now(); const v = ext.meter.feed(ext.lastAt); if (v) ext.bpm = v; }
  else if (b === START) { ext.running = true; ext.ticks = 0; ext.lastAt = e.timeStamp || now(); ext.meter.reset(); }
  else if (b === CONTINUE) ext.running = true;
  else if (b === STOP) ext.running = false;
}
function setSource(v) {
  if (master.ext?.input) master.ext.input.removeEventListener?.('midimessage', hearMaster);
  master.ext = null; master.source = 'page';
  if (v && v !== 'page') {
    const input = [...(hooks.access()?.inputs?.values() || [])].find(p => p.id === v);
    if (input) {
      master.source = v; master.ext = {input, ticks: 0, lastAt: 0, running: false, bpm: 0, meter: clockMeter()};
      input.open?.().catch?.(() => {});
      input.addEventListener?.('midimessage', hearMaster);
      master.clock?.stop();
    }
  }
  draw();
}

/* ---------- decks ---------- */
const deckOut = d => d.kind === 'fm1' ? hooks.outputFor(d.key) : [...(hooks.access()?.outputs?.values() || [])].find(p => p.id === d.key) || null;
function deckClock(d) {
  if (!d.clock) {
    const o = deckOut(d);
    d.clock = startClock({bpm: d.bpm, targets: o ? [o] : []});
    hooks.takeClock();
  }
  return d.clock;
}
async function assign(d, value) {
  d.clock?.stop(); d.clock?.close(); d.clock = null; d.startAt = 0; d.djNo = false;
  if (d.kind === 'fm1') djLetGo(d.key);   /* its OP4 / OP5 are its own again */
  if (d.kind === 'fm1' && d.levelSent !== 127) void fullVolume(d.key);   /* the FM-1 leaving the deck: full volume again */
  d.key = ''; d.kind = ''; d.live = null; d.fx = null; d.rv = null; d.base = null; d.throwing = null; d.kill = 0; d.killWant = null; d.killDoneAt = null; d.killDirty = 0; d.ccFx = 0; cancelLater(d.killTimer); d.killTimer = 0; d.levelPosted = null; d.filter = 0; setSynced(d, false); deckBend(d, 1); d.nudging = false;
  d.savHead = null; d.sav = null; d.savMatch = null; d.savAt = 0; d.seenPlaying = false; d.idlePolls = 0;
  d.song = null; d.songRead = null; d.songAt = null; d.songKeys = null;   /* (songAt null: never read) */
  d.presets = null; d.presetsAt = 0; drawPresets(d);
  d.syncTried = null; d.clockOut = null; d.midiKnown = false; d.warn = {}; d.ownRow = null; setWarn(d, 'midi', '');
  d.level = null; d.levelSent = 127; d.scrOk = true; d.themeAt = 0; d.map = null; d.mapFrom = -1; d.mapFill = null;
  paintDeck(d, null);
  if (value) { const [kind, ...k] = value.split(':'); d.kind = kind; d.key = k.join(':'); }
  if (d.kind && d.kind !== 'fm1') d.filterBy = d.throwBy = 'mixer';   /* only an FM-1 has effects of its own */
  if (d.kind === 'ab') abSpeed(d, 0);   /* a known start: normal speed */
  drawLabel(d); d.fxPanel?.rebuild();
  draw();
  crateRedraw();   /* its Load and Grab buttons follow the decks */
  if (d.kind !== 'fm1') return;
  applyVolumes();
  const l = hooks.linkFor(d.key);
  if (!l) return;
  try {   /* its effects, to put back after a filter or a throw */
    d.fx = unpackFx(await l.fxGet());
    if (firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw) >= 997) {
      const w = await l.reverbGet(); d.rv = w === null ? null : unpackReverb(w, await l.reverbSendsGet());
    }
    d.base = structuredClone({ch: d.fx.ch, echo: d.fx.echo, rv: d.rv});
    d.fxPanel?.rebuild();   /* its effects panel: this FM-1's */
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  await deckTheme(d, l);
  await deckSav(d, l).catch(() => {});
  await deckMidi(d, l);   /* the FM-1's MIDI settings for the deck (LSDj's SYNC: each poll, lsdjSync) */
  draw();
}
function deckPlay(d) {
  if (!d.key) return;
  const c = deckClock(d);
  d.seenPlaying = false; d.idlePolls = 0;
  if (c.running) { c.stop(); d.startAt = 0; drawPlay(d); void djKeys(d); return; }
  if (d.synced) followMaster(d);   /* (the master's tempo; starting on its bar puts the bars together) */
  c.setTempo(d.bpm);
  const m = masterNow();
  let at;
  if (m.phase == null && master.source === 'page') { at = now() + 60; masterClock().start(at); c.start(at); }
  else c.start(at = nextOn(m.phase, m.bpm, now()));   /* on the master's next bar */
  d.startAt = at;
  drawPlay(d);
  void djKeys(d);   /* its FM-1's OP4 blinks until the bar, then plays */
  clearTimeout(d.djTimer); d.djTimer = setTimeout(() => void djKeys(d), Math.max(0, at - now()) + 10);
}
/* 0.9.98-dev.4: the deck on its FM-1's own keys, OP4 Play and OP5 Stop, lit as the deck (firmware/lsdj_djkeys.h).
   Each poll tells the FM-1 the deck's state (DJ_DECK); it lets go of the keys 3 s after the last one, and at once
   when the layout hides, the deck takes another FM-1, or the page closes. A firmware without it: not asked again. */
const keysState = d => !d.clock?.running ? 'stopped' : now() < (d.startAt || 0) ? 'waiting' : 'playing';
async function djKeys(d, l = hooks.linkFor(d.key)) {
  if (!shown || d.kind !== 'fm1' || !l || d.djNo) return;
  const key = d.key;
  l.onDjKey = k => { if (d.kind === 'fm1' && d.key === key && shown) djPress(d, k); };
  try { if (!await l.djDeck(keysState(d))) d.djNo = true; } catch { /* lost: the next poll sends it again */ }
}
function djPress(d, k) {
  if (k === 'play' && !d.clock?.running) { deckPlay(d); say(`Deck ${NAMES[d.i]}: Play on the FM-1.`); }
  else if (k === 'stop' && d.clock?.running) { deckPlay(d); say(`Deck ${NAMES[d.i]}: Stop on the FM-1.`); }
}
function djLetGo(key) {
  const l = hooks.linkFor(key);
  if (!l) return;
  l.onDjKey = null; l.djDetach();
}
/* Sync: a lock, lit while on (as DJ software has). On: the deck takes the master's tempo at once and keeps
   following it (a tap, a new master tempo, an outside clock), and while both play its bar is kept on the master's:
   a gap of more than LOCK_SLACK clocks is closed by a short bend. On a stopped deck too: the tempo now, and Play
   starts it on the master's bar. Typing the deck's tempo, or a nudge, lets go (back to hand beatmatching). */
const LOCK_SLACK = 0.75;
function deckSync(d) {
  setSynced(d, !d.synced);
  if (!d.synced) return say(`Deck ${NAMES[d.i]}: Sync off.`);
  followMaster(d, true);
  say(`Deck ${NAMES[d.i]}: synced to the master, ${bpmText(d.bpm)} BPM` + (d.clock?.running ? '.' : ': Play starts it on the master\'s bar.'));
}
function setSynced(d, on) {
  d.synced = on;
  d.ui?.sync?.classList.toggle('on', on); d.ui?.sync?.setAttribute('aria-pressed', String(on));
}
/* one bend at a time: a new one (Sync again, a nudge) replaces the one under way, and its end can't cut the new one */
function deckBend(d, factor, ms = 0) {
  cancelLater(d.bendTimer); d.bendTimer = 0;
  d.clock?.bend(factor);
  if (ms) d.bendTimer = later(ms, () => { d.bendTimer = 0; d.clock?.bend(1); });
}
/* a synced deck: the master's tempo; its bar onto the master's (at once: any gap; later: past the slack) */
function followMaster(d, atOnce = false) {
  const t = now(), m = masterNow(t);
  if (m.bpm && d.bpm !== clampBpm(m.bpm)) { d.bpm = clampBpm(m.bpm); d.clock?.setTempo(d.bpm); showDeckBpm(d); }
  if (!d.clock?.running || m.phase == null || d.bendTimer || d.nudging) return;
  const gap = offset(d.clock.phase(t), m.phase);
  if (gap == null || Math.abs(gap) < (atOnce ? 0.05 : LOCK_SLACK)) return;
  const {factor, ms} = syncBend(gap, d.bpm);
  if (factor !== 1) deckBend(d, factor, ms);
}
/* nudge: faster / slower while held; it lets go of Sync (by hand from then on) */
const nudge = (d, dir) => {
  if (!d.clock?.running) return;
  if (dir && d.synced) { setSynced(d, false); say(`Deck ${NAMES[d.i]}: Sync off (nudged by hand).`); }
  d.nudging = !!dir;
  deckBend(d, dir ? 1 + dir * NUDGE : 1);
};
/* the deck's tempo typed (or Whole BPM): the numbers only, as setMasterBpm; it lets go of Sync */
function setDeckBpm(d, b) {
  if (d.synced) setSynced(d, false);
  d.bpm = tempoOf(b); d.clock?.setTempo(d.bpm);
  showDeckBpm(d);
}
function showDeckBpm(d) {
  const i = d.ui?.bpmIn;
  if (i && i.ownerDocument.activeElement !== i) i.value = d.bpm;
}

/* FM-1 sends, coalesced (a knob turned quickly sends at most every 60 ms) */
function pushFx(d) {
  if (d.sendTimer) return;
  d.sendTimer = setTimeout(async () => {
    d.sendTimer = 0;
    const l = hooks.linkFor(d.key);
    if (!l || !d.fx) return;
    try { await l.fxSet(packFx(d.fx)); if (d.rv) { await l.reverbSet(packReverb(d.rv)); if (d.rv.rvSend) await l.reverbSendsSet(packReverbSends(d.rv)); } }
    catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  }, 60);
}
/* ---------- each deck's effects panel (dj-fx.js): a drawer on its outer edge, a column, or its own window ---------- */
let fxView = store.get('dj-fx-view', 'drawers') === 'columns' ? 'columns' : 'drawers';
const fxOf = d => d.kind === 'fm1' && d.fx ? Object.assign(d.fx, {reverb: d.rv}) : null;
/* a change from the panel: on the deck's FM-1 (coalesced, as the filter knob), and kept as what the DJ filter and
   the throws put back afterwards */
function fxEdit(d, key, c, v) {
  const fx = fxOf(d);
  if (!fx) return;
  try { paramSet(fx, key, c, v); } catch (e) { return say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  d.fxTouched = now();
  if (d.base) {
    const p = PARAM[key];
    if (!d.filter && !d.throwing) d.base = structuredClone({ch: d.fx.ch, echo: d.fx.echo, rv: d.rv});
    else if (p.where === 'ch') d.base.ch[c] = {...d.base.ch[c], [key]: v, ...(key === 'type' ? {} : {type: d.fx.ch[c].type})};
    else if (p.where === 'echo') d.base.echo[key] = v;
    else if (p.where === 'rv' && d.base.rv) d.base.rv[key] = v;
    else if (p.where === 'rvch' && d.base.rv?.rvSend) d.base.rv.rvSend[c] = v;
  }
  pushFx(d);
  d.fxPanel?.refresh();
}
/* the FM-1's own knobs turned (LIVE carries its effects): taken in, unless this page is changing them right now (a
   send waiting, the panel or the filter knob just moved, a throw held) */
function adoptLiveFx(d) {
  if (!d.fx || !d.live?.fx || d.sendTimer || d.throwing || now() - (d.fxTouched || 0) < 1500) return;
  if (packFx(d.fx).join() === d.live.fx.join()) return;
  let f;
  try { f = unpackFx(d.live.fx); } catch { return; }
  d.fx = f;
  if (!d.filter) d.base = structuredClone({ch: f.ch, echo: f.echo, rv: d.rv});
  d.fxPanel?.refresh();
}
function fxOpen(d, on) {
  d.fxOpen = !!on; store.set(`dj-fx-open-${d.i}`, on ? '1' : '0');
  d.ui?.fxBox?.classList.toggle('open', d.fxOpen);
  d.ui?.fxTab?.setAttribute('aria-expanded', String(d.fxOpen));
}
const fxWin = d => `dj-fx-${d.i}`;
function fxPop(d) {
  if (isOut(fxWin(d))) return bringBack(fxWin(d));
  if (!popOut(fxWin(d), d.ui.fxBox, {title: `Deck ${NAMES[d.i]} effects`, width: 1280, height: 860}))
    say('The browser blocked the new window: allow pop-ups for this page, then press ⇱ again.');
}
function setFxView(v) {
  fxView = v === 'columns' ? 'columns' : 'drawers'; store.set('dj-fx-view', fxView);
  root?.querySelector('.dj-grid')?.classList.toggle('fx-columns', fxView === 'columns');
  root?.querySelectorAll('[data-fx-view]').forEach(b => { const on = b.dataset.fxView === fxView; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
}
function deckFilter(d, v) {
  d.filter = v; d.fxTouched = now();
  queueMicrotask(() => d.fxPanel?.refresh());
  if (d.filterBy === 'mixer') { const ch = mixer.map[d.i]; if (ch) mixerSend('filter', ch, v); }
  else if (d.fx && d.base) {
    const f = djFilter(v);
    d.fx.ch.forEach((c, n) => Object.assign(c, f.type ? f : {type: d.base.ch[n].type, cutoff: d.base.ch[n].cutoff, reso: d.base.ch[n].reso}));
    pushFx(d);
  }
  if (d.ui?.filt && +d.ui.filt.value !== v) d.ui.filt.value = v;
  showKnob(d);   /* (only the knob: it's being turned) */
}
/* a throw: the deck's sends all the way up while held (the effect's mix up if it was silent), then back, all of it
   as it was. An echo left at its start (time and feedback 0: one repeat 3 ms later, not heard as an echo) throws a
   tempo echo instead, 1/8. with 60% feedback; a reverb at size 0 one of about 2 s. The FM-1's own echo or reverb,
   once set, is the one thrown. */
const THROW_ECHO = {sync: 1, time: 80, feedback: 76};   /* time 80: the 8th of 12 synced notes, 1/8. (lsdj_fx.h) */
const THROW_RV_SIZE = 105;                              /* about 2 s (reverbSeconds) */
function deckThrow(d, what, on) {
  if (d.throwBy === 'mixer') { const ch = mixer.map[d.i]; if (ch) mixerSend('fx', ch, on ? 1 : 0); return; }
  if (!d.fx || !d.base) return;
  if (!on && d.throwing !== what) return;   /* (a let-go with no press: nothing to put back) */
  d.throwing = on ? what : null; d.fxTouched = now();
  queueMicrotask(() => d.fxPanel?.refresh());
  if (what === 'echo') {
    const e = d.base.echo, unset = !e.time && !e.feedback;
    d.fx.ch.forEach((c, n) => { c.send = on ? 127 : d.base.ch[n].send; });
    Object.assign(d.fx.echo, e, on ? {mix: e.mix || 80, ...(unset ? THROW_ECHO : {})} : {});
  } else if (d.rv?.rvSend && d.base.rv) {
    const r = d.base.rv;
    d.rv.rvSend = on ? [127, 127, 127, 127] : r.rvSend.slice();
    d.rv.rvMix = on && !r.rvMix ? 80 : r.rvMix;
    d.rv.rvSize = on && !r.rvSize ? THROW_RV_SIZE : r.rvSize;
  } else return say('Reverb throws need 0.9.97 on that FM-1.');
  /* sends are not heard with All FX off, nor on a channel whose effects are off (the FM-1's own switches) */
  if (on && d.fx.bypass) say(`Deck ${NAMES[d.i]}: All FX is off on that FM-1 (its MASTER page), so the throw can't be heard.`);
  else if (on && (d.fx.fxOff & 15) === 15) say(`Deck ${NAMES[d.i]}: the effects are off on every channel of that FM-1, so the throw can't be heard.`);
  pushFx(d);
}
/* Stem kills. d.killWant: the mask the pads ask for, toggled by each press: on top of the last press (sent or
   still waiting for the bar), never the last poll's (which can be a press behind, so two quick presses undid each
   other). On the bar: one timer for the deck sends whatever is wanted then, so every kill pressed before the bar
   lands. The FM-1's own mask (LIVE: its MUTE button) is taken again only from a LIVE asked for after the last send
   was answered: one asked before it (late on a busy link) still has the old mask, and a press on top of that put
   back channels unmuted since (Colin: "other channels mute as well"). Four channels only (& 15). */
const KILL_STALE_MS = 6000;   /* (no fresh LIVE for this long, e.g. its polls failing: the FM-1's last word anyway) */
const killShown = d => (d.killWant ?? d.live?.mute ?? d.kill) & 15;
/* the kills pressed (d.killDirty: a bit each, since the last send) to the FM-1. Hard mutes (Colin): each one only
   its own channel, by MIDI CC 81 on that channel's CC FX channel (64+ muted; firmware lsdj_midi.h), so no press can
   touch another channel whatever the page thinks the others are. Without CC FX (it couldn't be set, or older
   firmware without MIDI settings): the whole mask, MUTE_SET. */
function sendKills(d) {
  const dirty = (d.killDirty || 0) & 15, want = d.killWant & 15;
  d.killDirty = 0;
  const o = d.ccFx ? deckOut(d) : null;
  if (!o) return void setKill(d, want);
  const base = d.ccFx - 1;
  try {
    for (let c = 0; c < 4; c++) if ((dirty >> c) & 1) o.send([0xB0 | (base + c), 81, (want >> c) & 1 ? 127 : 0]);
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); return; }
  d.kill = (d.kill & ~dirty) | (want & dirty);
  logEvent(`Deck ${NAMES[d.i]}: ${CHANNELS.filter((_, c) => (dirty >> c) & 1).map(n => `${n} ${(want >> CHANNELS.indexOf(n)) & 1 ? 'muted' : 'playing'}`).join(', ')} (CC 81).`);
  if (d.live) d.live.mute = d.kill;
  d.killDoneAt = now() + 150;   /* (a LIVE asked from a moment on has it: the CC goes ahead of the link's next request) */
  paintKills(d);
}
async function setKill(d, mask) {
  const l = hooks.linkFor(d.key);
  if (!l) return;
  mask &= 15;
  logEvent(`Deck ${NAMES[d.i]}: mutes sent: ${muteNames(mask)}.`);   /* (to tell, if channels mute that weren't asked, where it came from) */
  d.kill = mask; d.killSends = (d.killSends || 0) + 1;
  if (d.live) d.live.mute = mask;   /* (the pads show it at once, not after the next poll) */
  paintKills(d);
  try { await l.muteSet(mask, d.live?.freeze ? 1 : 0); } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  finally { d.killSends--; d.killDoneAt = now(); }
}
function kill(d, c) {
  d.killWant = killShown(d) ^ (1 << c);
  d.killDirty = (d.killDirty || 0) ^ (1 << c);   /* (pressed twice before the bar: back as it was, nothing sent for it) */
  const m = masterNow();
  if (!d.killOnBar || m.phase == null) { cancelLater(d.killTimer); d.killTimer = 0; return sendKills(d); }
  if (!d.killTimer) d.killTimer = later(Math.max(0, nextOn(m.phase, m.bpm, now()) - now()), () => { d.killTimer = 0; sendKills(d); });
  paintKills(d);   /* (waiting for the bar: the pad blinks) */
}
/* after a poll: the page's kills win until they've settled on the FM-1, then the FM-1's own mask again */
function killSettle(d) {
  const fresh = d.killDoneAt != null && (d.live?.askedAt ?? -Infinity) > d.killDoneAt;
  if (d.killWant != null && !d.killTimer && !d.killSends && d.killDoneAt != null && (fresh || now() - d.killDoneAt > KILL_STALE_MS)) d.killWant = null;
  /* the FM-1 says other mutes than this page last sent (its MUTE keys, a MIDI CC 81, or something else): said once */
  const fm1 = (d.live?.mute ?? 0) & 15;
  if (fresh && !d.killSends && !d.killTimer && fm1 !== d.kill && fm1 !== d.killToldFor) {
    d.killToldFor = fm1;
    logEvent(`Deck ${NAMES[d.i]}: its FM-1 reports mutes ${muteNames(fm1)}; this page last sent ${muteNames(d.kill)}.`);
    d.kill = fm1;
  }
  paintKills(d);
  if (isOut(fxWin(d))) d.fxPanel?.refresh();   /* (its own window: the wiring greys the muted channels) */
}
const muteNames = m => CHANNELS.filter((_, c) => (m >> c) & 1).join(' ') || 'none';
/* the pads' lights: killed (dark, struck), or waiting for the bar to change (blinking) */
function paintKills(d) {
  const pads = d.ui?.kills;
  if (!pads) return;
  const shown = killShown(d), now_ = d.kill & 15;
  pads.forEach((p, c) => {
    p.classList.toggle('killed', !!((shown >> c) & 1));
    p.classList.toggle('pending', !!d.killTimer && ((shown ^ now_) >> c & 1) === 1);
  });
}
/* an ArduinoBoy deck (its mode 1, LSDJ slave sync): it follows the deck's clock, Start and Stop. Notes 50-53 on its
   channel (16 unless changed in its editor) set LSDj's speed: every clock, or every 2nd, 4th or 8th. It only listens:
   no screen, songs or row cues (its start-row note is never passed on to LSDj). */
const AB_SPEEDS = [['1', 'Normal speed'], ['½', 'Half speed'], ['¼', 'Quarter speed'], ['⅛', 'Eighth speed']];
let abCh = Math.min(16, Math.max(1, Math.round(+store.get('dj-ab-ch', 16)) || 16));
function abSpeed(d, n) {
  d.abSpeed = n;
  const o = deckOut(d);
  if (!o) return;
  const ch = abCh - 1;
  try { o.send([0x90 | ch, 50 + n, 100]); o.send([0x80 | ch, 50 + n, 0]); } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
}
/* a song row cue: program change n on channel 1 (the FM-1 takes any; GLO › MIDI › PC CUE must be ON) */
function cueRow(d) {
  if (d.kind === 'ab') return say(`Deck ${NAMES[d.i]}: an ArduinoBoy can't cue a song row.`);
  const o = deckOut(d);
  if (!o) return;
  try { o.send([0xC0, d.row & 127]); say(`Deck ${NAMES[d.i]}: row ${d.row.toString(16).toUpperCase().padStart(2, '0')} cued (FM-1: GLO › MIDI › PC CUE on).`); }
  catch (e) { say(e.message); }
}
/* 0.9.98: the FM-1's volume from this page (VOLUME_SET, times its MASTER knob). v: 0..1, null: full again. The
   latest value goes, one request at a time, so a fast crossfader never queues up. */
function deckLevel(d, v) {
  if (d.kind !== 'fm1' || fwOf(d) < 998) return;
  d.level = v == null ? null : Math.round(Math.max(0, Math.min(1, v)) * 127);
  postLevel(d);
}
/* While the crossfader moves: each new level sent at once (Link.post, past the requests queued on that FM-1's link,
   which on the FM-1 in use are many), at most every LEVEL_MS; once it rests, the last one sent again through the
   queue and confirmed (sendLevel), so a lost one is put right. */
const LEVEL_MS = 30, LEVEL_CONFIRM_MS = 250;
function postLevel(d) {
  clearTimeout(d.levelConfirm); d.levelConfirm = setTimeout(() => void sendLevel(d), LEVEL_CONFIRM_MS);
  const want = d.level ?? 127, t = now();
  if (want === d.levelPosted || d.levelPostTimer) return;
  const wait = LEVEL_MS - (t - (d.levelPostAt || 0));
  if (wait > 0) { d.levelPostTimer = setTimeout(() => { d.levelPostTimer = 0; postLevel(d); }, wait); return; }
  const l = hooks.linkFor(d.key);
  if (l?.post?.(OP.VOLUME_SET, [want])) { d.levelPosted = want; d.levelPostAt = t; }
}
async function sendLevel(d) {
  if (d.levelBusy) return;
  d.levelBusy = true;
  const key = d.key;
  try {
    for (let want = d.level ?? 127; want !== d.levelSent && d.key === key; want = d.level ?? 127) {
      const l = hooks.linkFor(key);
      if (!l || !(await l.volumeSet(want))) break;
      d.levelSent = want;
    }
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  finally { d.levelBusy = false; }
}
async function fullVolume(key) {
  try { await hooks.linkFor(key)?.volumeSet(127); } catch { /* gone: it is full at its next power on */ }
}
/* the crossfader sets the FM-1s' volumes only without a MIDI mixer; otherwise they are full */
function applyVolumes() {
  const g = crossfade(mixer.xfader, mixer.curve);
  decks.forEach((d, i) => deckLevel(d, mixer.id === 'none' ? g[i] : null));
}
/* 0.9.98: LSDj's live mode (Loop chains: each channel repeats its chain until another is cued), or song mode */
const HOLD_OFF = 'Loop', HOLD_ON = 'Loop';   /* (lit while on: the pads fit 6 letters) */
async function deckHold(d) {
  const l = hooks.linkFor(d.key);
  if (!l) return;
  const on = !d.live?.live;
  try {
    if (!(await l.seqSet(on))) return say(`Deck ${NAMES[d.i]}: this FM-1 can't switch LSDj's live mode (it needs LSDj 9.3.9).`);
    if (d.live) d.live.live = on;
    say(`Deck ${NAMES[d.i]}: ${on ? 'looping: each channel repeats the chain it plays (LSDj live mode) until you cue another' : 'the song plays on again (song mode)'}.`);
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  drawDeck(d);
}
/* ---------- the save on a deck's FM-1: the deck's label ----------
   The .sav this page last sent to that FM-1 (rememberSav, from Songs & kits; kept in this browser), and from the
   save's header (lsdj-sav.js savHeader: 4 READs of 128 bytes, copies, LSDj keeps playing) the song open in LSDj,
   the songs in the save and the room left. The header is read when the deck is chosen and every SAV_MS after;
   INFO (its save CRC, a sum over the whole save worked out on the FM-1) is asked only when the header changed, to
   say whether the FM-1 still holds the .sav sent. A read caught while LSDj writes its save shows until the next. */
const SAV_MS = 5000, SAVS = 'dj-savs';
const savsSent = () => { try { return JSON.parse(store.get(SAVS, '{}')) || {}; } catch { return {}; } };
export function rememberSav(key, name, crc) {
  const m = savsSent(); m[key] = {name, crc}; store.set(SAVS, JSON.stringify(m));
  decks.forEach(d => { if (d.key === key) { d.savHead = null; d.savAt = 0; drawLabel(d); } });   /* read again next poll */
  readSongAgain(key);
}
/* ---------- the key of the song on a deck's FM-1 (song-key.js) ----------
   LSDj's working song is read from the FM-1's save (READ, 128 bytes each: the parts the key needs, about 14 KiB),
   a few reads a poll (4 while it plays; the crossfader's VOLUME_SETs go past them), again every SONG_MS
   and after songs are sent. Then the song's key, and the key of the rows playing now, each poll. */
/* the song on that FM-1 changed (songs sent, a crate card loaded): its key read again from the next poll */
export function readSongAgain(key) { decks.forEach(d => { if (d.key === key) { d.songAt = null; d.songRead = null; } }); }
const SONG_MS = 60000, SONG_READS = [8, 4];   /* (the crossfader posts VOLUME_SET past the queue: link.js post) */
const songChunks = KEY_PARTS.flatMap(([a, b]) => Array.from({length: Math.ceil((b - a) / 128)}, (_, k) => a + k * 128));
async function deckSong(d, l) {
  if (!d.songRead && (d.songAt == null || now() - d.songAt > SONG_MS)) d.songRead = {next: 0, bytes: d.song?.slice() ?? new Uint8Array(0x8000)};
  const r = d.songRead, key = d.key;
  if (r) {
    for (let n = SONG_READS[playingNow(d) ? 1 : 0]; n > 0 && r.next < songChunks.length; n--, r.next++) {
      const at = songChunks[r.next], part = await l.saveRead(at);
      if (d.key !== key || d.songRead !== r) return;
      r.bytes.set(Array.prototype.slice.call(part, 0, Math.min(128, 0x8000 - at)), at);   /* (an array or bytes) */
    }
    if (r.next >= songChunks.length) { d.song = r.bytes; d.songRead = null; d.songAt = now(); }
  }
  if (!d.song) return drawKey(d);
  const rows = d.live?.songRows, playing = d.live?.playing || 0;
  d.songKeys = songKeys(d.song, rows && playing ? [0, 1, 2].map(c => (playing >> c) & 1 ? rows[c] : null) : null);
  drawKey(d);
}
/* the deck's key chip: the song's key and Camelot number (dimmed when unsure), and what plays now when it differs */
function drawKey(d) {
  const c = d.ui?.keyChip;
  if (!c) return;
  const k = d.songKeys?.whole, n = d.songKeys?.now;
  const reading = d.songRead && !d.song;
  const text = k ? `${k.name} · ${k.camelot}` + (n && n.name !== k.name ? ` › ${n.name}` : '') : reading ? 'Key…' : d.song ? 'Key ?' : '';
  setText(c, text);
  c.hidden = !text;
  c.classList.toggle('unsure', !!k && k.sure < 0.45);
  c.title = k ? `The song's key, from its notes: ${k.long} (Camelot ${k.camelot})${k.sure < 0.45 ? ', not sure' : ''}.` +
    (n ? ` Playing now: ${n.long} (${n.camelot}).` : '') + ' Drums (kits, noise) left out.'
    : reading ? 'Reading the song from the FM-1 to find its key.' : 'Too few notes to tell the key.';
}
async function deckSav(d, l) {
  const key = d.key;
  d.savAt = now();
  const head = new Uint8Array(HEADER_SIZE);
  for (let o = 0; o < HEADER_SIZE; o += 128) head.set(await l.saveRead(HEADER + o), o);
  if (d.key !== key || (d.savHead && head.every((b, i) => b === d.savHead[i]))) return;
  d.savHead = head; d.sav = savHeader(head);
  const sent = savsSent()[key];
  d.savMatch = sent ? (await l.info()).saveCrc === sent.crc : null;
  if (d.key === key) drawLabel(d);
}
/* the deck's label, as the tooltip of its FM-1 picker (no room taken on the deck): the .sav sent to it from this
   page (and whether its songs changed since), then the open song, how many, how full */
function drawLabel(d) {
  const pick = d.ui?.pick;
  if (!pick) return;
  if (d.kind !== 'fm1') { pick.title = ''; return; }
  const sent = savsSent()[d.key], s = d.sav, open = s?.active != null ? s.songs.find(x => x.slot === s.active) : null;
  pick.title = [sent ? sent.name + (d.savMatch === false ? ' (changed since)' : '') : 'Its own songs',
    !d.savHead ? 'Reading its songs…' : !s ? 'No LSDj songs on it yet' : [
      open ? `Song ${open.name || '(no name)'} .${hex2(open.version)}` : 'Song not saved yet',
      `${s.songs.length} song${s.songs.length === 1 ? '' : 's'}`, `${Math.round(100 * s.freeBlocks / BLOCK_COUNT)} % free`].join(' · ')].join('\n');
  /* the cartridge it holds (a crate card's, or any .sav sent here): a chip by its name; the crate's ON A / ON B */
  const held = heldSav(d);
  if (d.ui.chip) { d.ui.chip.hidden = !held; d.ui.chip.textContent = held ? held.name : ''; d.ui.chip.title = held ? `Deck ${NAMES[d.i]}'s FM-1 has "${held.name}"` : ''; }
  if ((held?.crc ?? null) !== (d.heldShown ?? null)) { d.heldShown = held?.crc ?? null; crateRedraw(); }
}
/* the .sav this page last sent to the deck's FM-1, while the FM-1 still reports it (not changed since) */
function heldSav(d) {
  if (d.kind !== 'fm1' || !d.key) return null;
  const sent = savsSent()[d.key];
  return sent && d.savMatch !== false ? sent : null;
}
/* each FM-1 deck in its FM-1's colours (its THEME setting; CUSTOM: its own colours), as the page takes the theme of
   the FM-1 in use (page-theme.js). Read when the deck is chosen and every so often after (a theme changed on it). */
const THEME_VARS = Object.keys(pageColours(Array(8).fill(0)));
async function deckTheme(d, l) {
  d.themeAt = now();
  try {
    const id = unpackSettings(await l.settingsGet()).theme;
    const colours = id === CUSTOM_THEME ? await l.themeGet() : THEME_COLOURS[id];
    if (d.kind === 'fm1' && hooks.linkFor(d.key) === l) paintDeck(d, colours ? pageColours(colours) : null);
  } catch { /* the colours stay as they are */ }
}
function paintDeck(d, vars) {
  const box = d.ui?.box;
  if (!box) return;
  for (const b of [box, d.ui.fxBox]) {   /* its effects panel in the same colours */
    if (!b) continue;
    THEME_VARS.forEach(k => b.style.removeProperty(k));
    if (vars) Object.entries(vars).forEach(([k, v]) => b.style.setProperty(k, v));
    b.classList.toggle('themed', !!vars);
  }
  const s = mixer.ui?.strips?.[d.i];
  if (s) stripColours(s, d);   /* its channel strip on the mixer too */
}
/* each FM-1 deck's screen, while the DJ layout shows: a mirror on the deck's FM-1 link, started again when that
   link changes (another FM-1 taken into use, a watcher started or ended), stopped when the deck is emptied */
function deckScreen(d) {
  const want = shown && d.kind === 'fm1' && deckView(d) === 'screen' && d.ui?.screen ? hooks.linkFor(d.key) : null;
  if (want === d.scrLink && (!want || d.scr || !d.scrOk)) return;   /* (no screen on its firmware: not asked again) */
  d.scr?.stop(); d.scr = null; d.scrLink = want;
  if (want && !d.scrOk) { d.scrOk = true; drawDeck(d); }   /* a new try: the canvas on the page again (it draws only when seen) */
  if (want) d.scr = hooks.screen(d.key, want, d.ui.screen, ok => { if (d.scrOk !== ok) { d.scrOk = ok; drawDeck(d); } });
}
/* a deck shows its FM-1's screen or its song row map (Rows, 0.9.98), as chosen (kept in this browser) */
const hasRows = d => fwOf(d) >= 998;
const deckView = d => d.view === 'rows' && hasRows(d) ? 'rows' : 'screen';
function setView(d, v) {
  d.view = v; store.set(`dj-view-${d.i}`, v);
  drawDeck(d); deckScreen(d);
  if (v === 'rows') { const l = hooks.linkFor(d.key); if (l) void readMap(d, l).then(() => drawMap(d), () => {}); }
}
/* 0.9.98: MAP_ROWS song rows from just before where the deck plays (4x LSDj's screen: the page's advantage is
   showing more, and touch), in columns of MAP_COL; read again when it moves on or every few seconds */
const MAP_ROWS = 64, MAP_COL = 16;
async function readMap(d, l) {
  const rows = (d.live?.songRows || []).filter((r, c) => r != null && (d.live.playing >> c) & 1);
  const at = rows.length ? Math.min(...rows) : d.row;
  /* kept while the playing row stays in the first column and the read is fresh; else read again, one SONG_ROWS
     block (16 rows) a poll, so a crossfader's VOLUME_SETs never wait behind four reads */
  const fresh = d.map && at >= d.mapFrom && at < d.mapFrom + MAP_COL - 2 && now() - d.mapAt < 4000;
  if (!fresh && !d.mapFill) d.mapFill = {from: Math.max(0, Math.min(256 - MAP_ROWS, at - 2)), rows: []};
  const f = d.mapFill;
  if (!f) return;
  const part = await l.songRows(f.from + f.rows.length);
  if (d.mapFill !== f) return;
  if (!part) { d.mapFill = null; return; }
  f.rows.push(...part);
  if (f.rows.length >= MAP_ROWS || !d.map) { d.map = f.rows.slice(); d.mapFrom = f.from; }   /* (a first read shows as it comes; a move, when whole) */
  if (f.rows.length >= MAP_ROWS) { d.mapAt = now(); d.mapFill = null; }
}
/* each FM-1 deck's LIVE, a few times a second: its own tempo, what plays, its mutes (0.9.98: rows, SYNC, mode) */
/* one round at a time: a round that takes longer than the 400 ms (the label, theme and rows reads on top of LIVE)
   skips the next one, instead of stacking requests up on the FM-1 links */
let pollBusy = false;
async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try { await pollRound(); } finally { pollBusy = false; }
}
/* stopped on the FM-1 itself (its own buttons): the page's clock for that deck stops too (the jog, the beat lights
   and PLAY with it). Only once the FM-1 has played since the deck started (LSDj takes a moment to start on the
   page's Start), and then said twice running (two polls, about 0.8 s) that no channel plays. */
function fm1Stopped(d) {
  if (!d.clock?.running) { d.seenPlaying = false; d.idlePolls = 0; return; }
  if (d.live.playing) { d.seenPlaying = true; d.idlePolls = 0; return; }
  if (!d.seenPlaying || ++d.idlePolls < 2) return;
  d.seenPlaying = false; d.idlePolls = 0;
  d.clock.stop();
  say(`Deck ${NAMES[d.i]}: stopped on the FM-1.`);
  drawDeck(d);
}
/* while a deck plays, its colours are read less often: those reads queue ahead of its sends */
const THEME_MS = 8000, THEME_PLAYING_MS = 30000;
const playingNow = d => !!d.clock?.running || !!d.live?.playing;
/* the decks at once: each FM-1 has its own link, so deck B no longer waits for deck A's whole round */
async function pollRound() {
  await Promise.all(decks.map(pollDeck));
}
async function pollDeck(d) {
  deckScreen(d);
  if (d.kind !== 'fm1') return;
  const l = hooks.linkFor(d.key);
  if (!l) return;
  try {
    const asked = now();
    d.live = await l.live(); d.live.askedAt = asked;   /* (when it was asked: killSettle trusts only a fresh one) */
    fm1Stopped(d); ownAnchor(d); adoptLiveFx(d); killSettle(d);
    await lsdjSync(d, l);
    await djKeys(d, l);
    if (d.live.level != null && !d.levelBusy) d.levelSent = d.live.level;
    if (d.live.level != null && d.levelSent !== (d.level ?? 127)) void sendLevel(d);   /* power cycled, or another page */
    if (now() - (d.themeAt || 0) > (playingNow(d) ? THEME_PLAYING_MS : THEME_MS)) await deckTheme(d, l);
    if (now() - (d.savAt || 0) > SAV_MS) await deckSav(d, l).catch(() => {});   /* (an import under way: next time) */
    await deckSong(d, l).catch(e => { d.songErr = String(e?.message ?? e); });   /* (kept for the tests; tried again next poll) */
    await deckPresets(d, l).catch(() => {});
    if (deckView(d) === 'rows') { await readMap(d, l); drawMap(d); }   /* (read only while the rows show) */
  } catch { d.live = null; }
}

/* ---------- presets (FM-1 0.9.98-dev.6, lsdj/presets.js) ----------
   A strip of 8 under the deck's head: a tap loads that preset on the deck's FM-1, as EDIT + its key does there (its
   effects slide over PRESET GLIDE). The list read every PRESET_MS (a slot loaded on the FM-1 shows too). */
const PRESET_MS = 3000;
const hasPresets = d => d.kind === 'fm1' && !!hooks.devices().find(x => x.key === d.key)?.presets;
async function deckPresets(d, l) {
  if (!hasPresets(d)) { if (d.presets) { d.presets = null; drawPresets(d); } return; }
  if (d.presets && now() - d.presetsAt < PRESET_MS) return;
  const key = d.key, got = await l.presetList();
  if (d.key !== key) return;
  d.presetsAt = now();
  if (JSON.stringify(got) !== JSON.stringify(d.presets)) { d.presets = got; drawPresets(d); }
}
function drawPresets(d) {
  const row = d.ui?.presets;
  if (!row) return;
  const p = d.presets;
  row.hidden = !p;
  if (!p) return row.replaceChildren();
  row.replaceChildren(...p.names.map((name, i) => {
    const b = el('button', {type: 'button', className: 'dj-preset' + (name ? '' : ' empty') + (p.current === i ? ' on' : ''), textContent: String(i + 1),
      title: name ? `Preset ${i + 1}: ${name} (on the FM-1: EDIT + ${PRESET_KEYS[i]})` : `Preset ${i + 1}: empty`,
      onclick: () => void deckPreset(d, i)});
    b.setAttribute('aria-pressed', String(p.current === i));
    return b;
  }));
}
async function deckPreset(d, i) {
  const l = hooks.linkFor(d.key), name = d.presets?.names[i];
  if (!l || !d.presets) return;
  if (!name) return say(`Deck ${NAMES[d.i]}: preset ${i + 1} is empty. Keep one there in Perform › Effects › Presets › Manage…, or on the FM-1: EDIT + SELECT, then ${PRESET_KEYS[i]}.`);
  if (d.throwing || d.filter) return say(`Deck ${NAMES[d.i]}: let go of the filter and throws first, then load the preset.`);
  try {
    if (await l.presetLoad(i) === 'empty') return say(`Deck ${NAMES[d.i]}: preset ${i + 1} is empty.`);
    /* its reverb as the deck's own (the effects come with the next polls, sliding: adoptLiveFx) */
    const p = fromSlot(await l.presetGet(i));
    if (p && d.rv) d.rv = unpackReverb(p.fx[17], p.fx[18]);
    d.presets = {...d.presets, current: i}; d.presetsAt = now(); d.themeAt = 0;   /* (its colours read again) */
    drawPresets(d);
    say(`Deck ${NAMES[d.i]}: preset ${i + 1}, ${name}.`);
  } catch (e) { say(`Deck ${NAMES[d.i]}: preset ${i + 1} not loaded: ${e.message}`); }
}

/* ---------- the mixer ---------- */
function mixerPorts() {
  const a = hooks.access();
  return {ins: [...(a?.inputs?.values() || [])], outs: [...(a?.outputs?.values() || [])]};
}
function mixerSend(what, ...args) {
  const outs = hooks.access()?.outputs;
  const o = outs?.get?.(mixer.outId) ?? [...(outs?.values() || [])].find(p => p.id === mixer.outId);
  if (!o) return false;
  const msgs = out(preset(mixer.id), what, ...args);
  try { msgs.forEach(m => o.send(m)); } catch { return false; }
  return msgs.length > 0;
}
function hearMixer(e) {
  const msg = readMidi(e.data);
  if (!msg) return;
  if (mixer.learning) {   /* MIDI learn: this control does the action chosen */
    const r = learnRule(msg, mixer.learning, mixer.learning.seen || []);
    mixer.learned = mixer.learned.filter(x => !(x.type === r.type && x.ch === r.ch && x.num === r.num)).concat(r);
    store.set('dj-learned', saveLearned(mixer.learned));
    mixer.note = `Learned: ${msg.type.toUpperCase()} ${msg.num} on channel ${msg.ch} → ${actName(mixer.learning)}.`;
    mixer.learning = null; draw(); return;
  }
  const a = actionFor(preset(mixer.id), msg, mixer.map, mixer.id === 'learn' ? mixer.learned : []);
  if (a) act(a);
}
function act(a) {
  const d = a.deck != null ? decks[a.deck] : null;
  switch (a.act) {
  case 'fader': if (a.ch != null) mixer.faders[a.ch] = a.v; break;
  case 'xfader': setXfader(a.v); break;
  case 'filter': if (d) deckFilter(d, a.v); break;
  case 'echo': case 'reverb': if (d) deckThrow(d, a.act, a.v >= 0.5); break;
  case 'start': if (d) deckPlay(d); break;
  case 'cue': if (d) cueRow(d); break;
  case 'play': masterPlay(); break;
  case 'tempo': {   /* an encoder: the master's tempo, or a deck's (whole: a step of 1 at least) */
    const by = master.whole ? Math.sign(a.v) * Math.max(1, Math.round(Math.abs(a.v))) : a.v;
    if (d) setDeckBpm(d, d.bpm + by); else handMasterBpm(master.bpm + by); break; }
  case 'step': if (d) stepDeck(d, a.dir || 1); else stepMaster(a.dir || 1); break;
  case 'nudge': if (d) nudge(d, a.v ? a.dir || 1 : 0); break;
  case 'half': case 'double': halfDouble(d, a.act === 'half' ? 0.5 : 2); break;
  case 'pad': if (a.n != null) padGo(a.n); break;
  case 'match': if (d) matchMaster(d); break;
  case 'fromdeck': if (d) masterFromDeck(d); break;
  }
  if (['start', 'cue', 'play'].includes(a.act)) drawMixer();   /* a press: Play / Stop may change */
  else mixerNumbers();   /* a fader, a knob, an encoder: many a second, the numbers only */
}
/* the crossfader: the mixer's two deck channels when it takes volumes; else (no mixer) each FM-1's volume, 0.9.98 */
function setXfader(v) {
  mixer.xfader = v;
  const g = crossfade(v, mixer.curve);
  let sent = false;
  if (mixer.id !== 'none') decks.forEach((d, i) => { const ch = mixer.map[i]; if (ch) sent = mixerSend('fader', ch, g[i]) || sent; });
  applyVolumes();
  const fm1s = decks.filter(d => d.kind === 'fm1');
  mixer.note = mixer.id === 'none'
    ? (fm1s.length && fm1s.every(d => fwOf(d) >= 998) ? 'Without a MIDI mixer the crossfader sets each FM-1\'s volume (times its MASTER knob).'
      : 'Without a MIDI mixer the crossfader sets each FM-1\'s volume: that needs 0.9.98 on the FM-1s.')
    : sent ? '' : 'This mixer doesn\'t take its volumes from the page: the crossfader shows here only.';
  mixerNumbers();   /* (dragged: the numbers only, never the slider itself) */
}
function setMixerIn(id) {
  mixer.input?.removeEventListener?.('midimessage', hearMixer);
  mixer.inId = id; store.set('dj-mixer-in', id);
  mixer.input = mixerPorts().ins.find(p => p.id === id) || null;
  mixer.input?.open?.().catch?.(() => {});
  mixer.input?.addEventListener?.('midimessage', hearMixer);
}
const ACTIONS = [{act: 'xfader'}, {act: 'play'}, {act: 'tempo'}, {act: 'step', dir: -1}, {act: 'step', dir: 1}, {act: 'half'}, {act: 'double'},
  ...Array.from({length: PADS}, (_, n) => ({act: 'pad', n})),
  ...[0, 1].flatMap(deck => ['start', 'cue', 'filter', 'echo', 'reverb'].map(act => ({act, deck}))),
  ...[0, 1].flatMap(deck => [{act: 'tempo', deck}, {act: 'step', dir: -1, deck}, {act: 'step', dir: 1, deck}, {act: 'nudge', dir: -1, deck},
    {act: 'nudge', dir: 1, deck}, {act: 'half', deck}, {act: 'double', deck}, {act: 'match', deck}, {act: 'fromdeck', deck}]),
  ...[0, 1].map(deck => ({act: 'fader', deck, mixCh: deck + 1}))];
function actName(a) {
  const n = {xfader: 'Crossfader', play: 'Master Play / Stop', tempo: 'Tempo (relative)', start: 'Play / Stop', cue: 'Cue row',
    filter: 'DJ filter', echo: 'Echo throw', reverb: 'Reverb throw', fader: 'Fader', step: a.dir < 0 ? 'Tempo −' : 'Tempo +',
    nudge: a.dir < 0 ? 'Nudge slower (held)' : 'Nudge faster (held)', half: 'Half time ×½', double: 'Double time ×2',
    pad: `Tempo pad ${(a.n ?? 0) + 1}`, match: 'Back to the master\'s tempo', fromdeck: 'Master to its LSDj tempo'}[a.act];
  return a.deck != null ? `Deck ${NAMES[a.deck]}: ${n}` : ['tempo', 'step', 'half', 'double'].includes(a.act) ? `Master: ${n}` : n;
}

/* ---------- drawing ---------- */
let statusEl = null;
/* (a deck's trouble also goes in the connection log, to read after it has gone from the status line) */
const say = text => { if (statusEl) statusEl.textContent = text; if (/^Deck [AB]: /.test(text) && !/Sync|synced|cued|speed/.test(text)) logEvent(text); };
function sel(options, value, onchange, label) {
  const s = el('select', {onchange: () => onchange(s.value)});
  if (label) s.setAttribute('aria-label', label);
  options.forEach(([v, t, dis]) => { const o = new Option(t, v); o.disabled = !!dis; s.append(o); });
  s.value = value; return s;
}
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
function holdBtn(text, down, up, props = {}) {
  const b = el('button', {type: 'button', textContent: text, ...props});
  b.onpointerdown = e => { b.setPointerCapture?.(e.pointerId); b.classList.add('on'); down(); };
  b.onpointerup = b.onpointercancel = () => { b.classList.remove('on'); up(); };
  b.onkeydown = e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { b.classList.add('on'); down(); } };
  b.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') { b.classList.remove('on'); up(); } };
  return b;
}
/* a held button that lets go however the press ends (the page redrawn under it, the window left) */
function pressBtn(text, down, up, props = {}) {
  let held = false;
  const end = () => { if (held) { held = false; up(); } };
  return holdBtn(text, () => { held = true; down(); addEventListener('pointerup', end, {once: true}); addEventListener('blur', end, {once: true}); }, end, props);
}
/* − / +: a step a press; held, it repeats and then takes bigger steps (dj-tempo.js repeater) */
function stepBtn(text, dir, step, props = {}) {
  const r = repeater(step);
  return pressBtn(text, () => r.press(dir), () => r.release(), props);
}
function deckChoices() {
  const fm1s = hooks.devices().map(d => [`fm1:${d.key}`, d.label]);
  const fm1Outs = new Set(hooks.devices().map(d => hooks.outputFor(d.key)?.id));
  const gear = mixerPorts().outs.filter(p => !fm1Outs.has(p.id) && p.id !== mixer.outId)
    .flatMap(p => [[`gear:${p.id}`, `${p.name} (MIDI)`], [`ab:${p.id}`, `${p.name} (ArduinoBoy)`]]);
  return [['', 'Empty'], ...fm1s, ...gear];
}
/* a deck, laid out as a CDJ (index.html .dj-deck):
     the top: the display (the FM-1's screen or its song rows, unframed; the .sav and song: the picker's tooltip), its source buttons
       (Screen, Rows) beside it;
     a row of eight pads under it (the channel kills, Echo and Reverb throws, Hold, BAR: kills on the next bar);
     the jog wheel in the middle (turned: a nudge; beat lights round its ring; its centre: the tempo, the pitch, the
       gap to the master), CUE and PLAY at its bottom left, SYNC and the tempo fader down its right;
     a utility line at the bottom. Each deck in its FM-1's colours. The filter knob is on the mixer's channel strip. */
function drawDeck(d) {
  const u = d.ui;
  if (!u) return;
  const fm1 = d.kind === 'fm1', fw = firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw), has98 = fw >= 998;
  u.body.replaceChildren();
  u.box.classList.toggle('empty', !d.key);
  u.info = null; u.hold = null; u.map = null; u.rowIn = null; u.pitch = null; u.jog = null; u.kills = null; u.beatShown = undefined;
  if (!d.key) { u.body.append(el('p', {className: 'hint dj-empty', textContent: 'Choose an FM-1 or another MIDI device for this deck.'})); return; }
  const running = !!d.clock?.running;

  /* the top: the display, and its source buttons */
  const display = el('div', {className: 'dj-display'});
  const top = el('div', {className: 'dj-top-panel'});
  if (fm1) {
    /* Screen | Rows: the FM-1's screen, or the song row map (tap a row to cue it), in one fixed-size box
       (index.html .dj-view-box: its size and shape are CSS variables), so the deck never changes size */
    const view = deckView(d);
    const viewBtn = (v, text, title, disabled = false) => btn(text, () => setView(d, v),
      {className: view === v ? 'on' : '', disabled, title, ariaPressed: String(view === v)});
    const box = el('div', {className: `dj-view-box ${view}`});
    if (view === 'rows') { u.map = el('div', {className: 'dj-map mono', role: 'group', ariaLabel: `Deck ${NAMES[d.i]} song rows`}); box.append(u.map); }
    else box.append(d.scrOk ? u.screen
      : el('p', {className: 'hint dj-view-note', textContent: fw >= 983 ? 'This FM-1 did not send its screen. Choose the deck again to retry.' : `This FM-1's screen shows here with FM-1_983 or newer (it runs ${fw ? `FM-1_${fw}` : 'older firmware'}).`}));
    display.append(el('div', {className: 'dj-view-area'}, box));   /* the box at the screen's shape, as big as fits */
    top.append(el('div', {className: 'seg dj-view', role: 'group', ariaLabel: `Deck ${NAMES[d.i]}: show`},
      viewBtn('screen', 'Screen', "The FM-1's screen"),
      viewBtn('rows', 'Rows', has98 ? 'The song rows: tap one to cue it at the next bar' : 'Needs 0.9.98 on the FM-1', !has98)), display);
  } else if (d.kind === 'ab') {
    const speed = n => btn(AB_SPEEDS[n][0], () => { abSpeed(d, n); drawDeck(d); },
      {className: d.abSpeed === n ? 'on' : '', ariaPressed: String(d.abSpeed === n), title: `${AB_SPEEDS[n][1]} (ArduinoBoy note ${50 + n})`});
    const ch = sel(Array.from({length: 16}, (_, i) => [String(i + 1), String(i + 1)]), String(abCh),
      v => { abCh = +v; store.set('dj-ab-ch', v); abSpeed(d, d.abSpeed); }, 'ArduinoBoy MIDI channel');
    display.append(el('div', {className: 'dj-disp-info'},
      el('b', {textContent: 'ArduinoBoy'}),
      el('div', {className: 'dj-padrow'}, el('span', {className: 'dj-small', textContent: 'LSDj speed'}),
        el('div', {className: 'seg', role: 'group', ariaLabel: `Deck ${NAMES[d.i]}: LSDj speed`}, ...[0, 1, 2, 3].map(speed)),
        el('label', {className: 'dj-small', title: 'The ArduinoBoy\'s LSDJ slave mode channel (16 unless changed in its editor)'}, 'Ch ', ch)),
      el('p', {className: 'dj-small', textContent: 'Mode 1 (LSDJ slave sync); in LSDj, PROJECT › SYNC = MIDI. It follows Play, Stop, the tempo and Sync. '
        + 'It only listens: no screen, song info or row cue; the filter and throws work through a MIDI mixer.'})));
    top.append(display);
  } else {
    display.append(el('div', {className: 'dj-disp-info'}, el('b', {textContent: 'MIDI clock'}),
      el('p', {className: 'dj-small', textContent: 'This page clocks this device: Play, Stop, the tempo and Sync. The filter and throws work through a MIDI mixer.'})));
    top.append(display);
  }

  /* the pads */
  const pads = el('div', {className: 'dj-pads'});
  if (fm1) {
    const held = !!d.live?.live;
    pads.append(...(u.kills = CHANNELS.map((n, c) => btn(n, () => kill(d, c), {className: 'dj-pad dj-kill', title: `Mute or play ${n}`}))));
    paintKills(d);
    pads.append(
      holdBtn('Echo', () => deckThrow(d, 'echo', true), () => deckThrow(d, 'echo', false), {className: 'dj-pad dj-throw', title: 'Echo throw: the sends up while held'}),
      holdBtn('Reverb', () => deckThrow(d, 'reverb', true), () => deckThrow(d, 'reverb', false),
        {className: 'dj-pad dj-throw', title: 'Reverb throw: the sends up while held', disabled: d.throwBy === 'fm1' && fw < 997}),
      u.hold = btn(held ? HOLD_ON : HOLD_OFF, () => void deckHold(d), {disabled: !has98, className: `dj-pad${held ? ' on' : ''}`, ariaPressed: String(held),
        title: has98 ? 'LSDj live mode (lit): each channel repeats the chain it plays instead of moving on, until you cue another. Again: the song plays on.' : 'Needs 0.9.98 on the FM-1'}),
      btn('On bar', () => { d.killOnBar = !d.killOnBar; store.set('dj-killbar', d.killOnBar ? '1' : '0'); drawDeck(d);
          say(`Kills: ${d.killOnBar ? 'on the next bar' : 'at once'}.`); },
        {className: `dj-pad${d.killOnBar ? ' on' : ''}`, ariaPressed: String(!!d.killOnBar), title: 'The four kill pads act on the next bar (lit), or at once. Makes no sound itself.'}));
  } else {
    pads.append(
      holdBtn('Echo', () => deckThrow(d, 'echo', true), () => deckThrow(d, 'echo', false), {className: 'dj-pad dj-throw', title: 'Echo throw (the mixer\'s FX send) while held'}),
      holdBtn('Reverb', () => deckThrow(d, 'reverb', true), () => deckThrow(d, 'reverb', false), {className: 'dj-pad dj-throw', title: 'Reverb throw (the mixer\'s FX send) while held'}));
  }

  /* the jog wheel: beat lights round its ring, a mark turning once a bar, its centre the tempo display */
  u.bpm = el('b', {className: 'dj-bpm'});
  u.pitchTxt = el('span', {className: 'dj-pitch-txt'});
  u.gap = el('span', {className: 'dj-gap'});
  u.phase = el('div', {className: 'dj-ring', ariaHidden: 'true'}, ...[0, 1, 2, 3].map(() => el('span')));
  const jog = el('div', {className: 'dj-jogwheel', tabIndex: 0, role: 'group', ariaLabel: `Deck ${NAMES[d.i]} jog wheel: turn it (or hold an arrow key) to nudge`,
    title: 'Turn to nudge: clockwise faster, anticlockwise slower'},
    el('div', {className: 'dj-platter'}, el('i', {className: 'dj-jog-mark'})), u.phase,
    el('div', {className: 'dj-jog-centre'}, u.bpm, el('small', {textContent: 'BPM'}), u.pitchTxt, u.gap));
  jogWheel(d, jog);
  u.jog = jog;

  /* CUE (a song row, at the next bar) and PLAY, bottom left */
  const left = el('div', {className: 'dj-left'});
  if (fm1) {
    const row = el('input', {type: 'text', value: hex2(d.row), size: 3, maxLength: 2, className: 'mono dj-row-in',
      onchange: () => { d.row = Math.min(127, parseInt(row.value, 16) || 0); }});
    row.setAttribute('aria-label', 'Song row (hex)');
    u.rowIn = row;
    left.append(el('label', {className: 'dj-small dj-cue-row'}, 'ROW', row),
      el('div', {className: 'dj-round-wrap'}, btn('CUE', () => cueRow(d), {className: 'dj-round dj-cue', title: 'Cue row: plays that song row at the next bar (FM-1: PC CUE on)'})));
  }
  left.append(el('div', {className: 'dj-round-wrap'},
    btn(running ? '❚❚' : '▶', () => deckPlay(d), {className: `dj-round dj-play${running ? ' on' : ''}`, ariaLabel: running ? 'Stop' : 'Play',
      title: running ? 'Stop' : 'Play: starts on the master\'s next bar'}),
    el('span', {className: 'dj-small', textContent: 'PLAY/STOP'})));

  /* SYNC and the tempo fader down the right (its tempo against the master's, ±8 %; up is slower, as on a CDJ) */
  const bpmIn = el('input', {type: 'number', min: 40, max: 295, step: master.whole ? 1 : 0.1, value: d.bpm, className: 'dj-bpm-in', onchange: () => setDeckBpm(d, +bpmIn.value)});
  u.bpmIn = bpmIn;
  bpmIn.setAttribute('aria-label', `Deck ${NAMES[d.i]} tempo`);
  const pitch = el('input', {type: 'range', min: -d.range, max: d.range, step: 1, value: pitchValue(d), className: 'dj-pitch',
    oninput: () => setDeckBpm(d, bpmOfPitch(+pitch.value, masterBpm()))});
  pitch.setAttribute('aria-label', `Deck ${NAMES[d.i]} tempo fader, against the master (hundredths of a percent)`);
  pitch.ondblclick = () => matchMaster(d);
  pitch.onpointerdown = () => { u.pitchHeld = true; };
  pitch.onpointerup = pitch.onpointercancel = () => { u.pitchHeld = false; };
  u.pitch = pitch;
  const right = el('div', {className: 'dj-right'},
    u.sync = btn('SYNC', () => deckSync(d), {className: `dj-sync${d.synced ? ' on' : ''}`, ariaPressed: String(!!d.synced),
      title: 'Lock to the master: its tempo, and its bar while both play. Again: off. The tempo fader, typing a tempo or the jog lets go.'}),
    u.range = btn(rangeText(d.range), () => nextRange(d), {className: 'dj-range', title: 'The tempo fader\'s range: ±8, ±16 or ±50 % (click for the next)',
      ariaLabel: `Deck ${NAMES[d.i]} tempo fader range`}),
    el('div', {className: 'dj-pitch-wrap'}, el('span', {className: 'dj-small', textContent: '−'}), pitch, el('span', {className: 'dj-small', textContent: '+'})),
    el('label', {className: 'dj-small dj-bpm-label'}, bpmIn),
    el('div', {className: 'dj-steps'},
      stepBtn('−', -1, (dir, size) => stepDeck(d, dir, size), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} tempo down`, title: 'Tempo down (hold: faster); lets go of Sync'}),
      stepBtn('+', 1, (dir, size) => stepDeck(d, dir, size), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} tempo up`, title: 'Tempo up (hold: faster); lets go of Sync'})));

  /* the tempo row under the jog: nudge (held: 4 % slower or faster, then back), half / double time, the master's tempo */
  const tempoRow = el('div', {className: 'dj-tempo-row'},
    pressBtn('◀', () => nudge(d, -1), () => nudge(d, 0), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} nudge slower`, title: 'Hold: slower while held (a playing deck); lets go of Sync', disabled: !running}),
    pressBtn('▶', () => nudge(d, 1), () => nudge(d, 0), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} nudge faster`, title: 'Hold: faster while held (a playing deck); lets go of Sync', disabled: !running}),
    btn('×½', () => halfDouble(d, 0.5), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} half time`, title: 'Half the tempo'}),
    btn('×2', () => halfDouble(d, 2), {className: 'dj-pad dj-tbtn', ariaLabel: `Deck ${NAMES[d.i]} double time`, title: 'Double the tempo'}),
    btn('MASTER', () => matchMaster(d), {className: 'dj-pad dj-tbtn dj-match', title: 'Back to the master\'s tempo (the fader to ±0), without Sync'}));

  /* the utility line: whose effects, and what the FM-1 says */
  const by = (k) => sel([['fm1', 'FM-1', !fm1], ['mixer', 'mixer', !preset(mixer.id).out]], d[k], v => { d[k] = v; }, 'Whose effect');
  const util = el('div', {className: 'dj-util dj-small'},
    el('label', {}, 'Throws by ', by('throwBy')), el('label', {}, 'Filter by ', by('filterBy')),
    fm1 && !has98 ? el('span', {textContent: 'Hold and Rows need 0.9.98.'}) : null);
  if (fm1) { u.info = el('span', {className: 'dj-info'}); util.append(u.info); }

  u.body.append(top, pads, el('div', {className: 'dj-deck-mid'}, left, jog, right), tempoRow, util);
  if (u.map) drawMap(d);
}
/* the jog wheel turned (a drag round its centre) or an arrow key held: a nudge that way while it moves */
function jogWheel(d, jog) {
  let last = null, dir = 0, idle = 0;
  const angle = e => { const r = jog.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
  const set = v => { if (v !== dir) { dir = v; nudge(d, v); } };
  const stop = () => { clearTimeout(idle); last = null; set(0); jog.classList.remove('touched'); };
  jog.onpointerdown = e => {
    if (e.button) return;
    e.preventDefault(); jog.focus({preventScroll: true});
    try { jog.setPointerCapture(e.pointerId); } catch { /* (not a live pointer) */ }
    last = angle(e); jog.classList.add('touched');
  };
  jog.onpointermove = e => {
    if (last == null) return;
    const a = angle(e);
    let da = a - last;
    if (da > 180) da -= 360; else if (da < -180) da += 360;
    if (Math.abs(da) < 1) return;
    last = a; set(da > 0 ? 1 : -1);
    clearTimeout(idle); idle = setTimeout(() => set(0), 140);   /* stopped turning: the nudge ends */
  };
  jog.onpointerup = jog.onpointercancel = stop;
  jog.onkeydown = e => {
    const v = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1}[e.key];
    if (v) { e.preventDefault(); set(v); }
  };
  jog.onkeyup = e => { if (e.key.startsWith('Arrow')) set(0); };
  jog.onblur = stop;
}
/* the tempo fader: the deck's tempo against the master's, in hundredths of a percent */
const masterBpm = () => masterNow().bpm || master.bpm;
const pitchValue = d => pitchOf(d.bpm, masterBpm(), d.range);
/* the filter knob's look from its value: the pointer's angle and a lit arc from the top (index.html .dj-knob) */
function showKnob(d) {
  const f = d.ui?.filt, k = f?.parentElement;
  if (!k) return;
  const v = +f.value / (+f.value < 0 ? 64 : 63), deg = v * 135;
  k.style.setProperty('--deg', `${deg}deg`);
  k.style.setProperty('--from', `${Math.min(0, deg)}deg`);
  k.style.setProperty('--sweep', `${Math.abs(deg)}deg`);
  k.classList.toggle('off', !+f.value);
}
/* a knob turned by dragging: up or right turns it up (a range input underneath holds the value) */
function dragKnob(knob, input, set) {
  knob.onpointerdown = e => {
    if (e.button) return;
    e.preventDefault(); input.focus({preventScroll: true});
    knob.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, v0 = +input.value, span = +input.max - +input.min;
    knob.onpointermove = m => {
      const v = Math.round(Math.max(+input.min, Math.min(+input.max, v0 + ((m.clientX - x0) - (m.clientY - y0)) * span / 200)));
      if (v !== +input.value) { input.value = v; set(v); }
    };
    knob.onpointerup = knob.onpointercancel = () => { knob.onpointermove = null; };
  };
  knob.onwheel = e => {
    e.preventDefault();
    const v = Math.max(+input.min, Math.min(+input.max, +input.value + (e.deltaY < 0 ? 4 : -4)));
    input.value = v; set(v);
  };
}
/* the song row map: 16 rows, a chain per channel (-- empty); the rows playing marked; a click cues that row
   (a program change: rows 00-7F only) */
function drawMap(d) {
  const u = d.ui;
  if (!u?.map) return;
  if (!d.map) { u.map.replaceChildren(el('span', {className: 'hint', textContent: 'Reading the song…'})); return; }
  const at = d.live?.songRows || [], playing = d.live?.playing || 0;
  u.map.replaceChildren(...d.map.map((chains, i) => {
    const r = d.mapFrom + i, here = chains.map((c, ch) => (playing >> ch) & 1 && at[ch] === r);
    /* a tap cues it; only the map is redrawn (its scroll stays) */
    const b = btn('', () => { d.row = r; cueRow(d); if (u.rowIn) u.rowIn.value = hex2(r); drawMap(d); },
      {className: `dj-maprow${here.some(Boolean) ? ' here' : ''}${r === d.row ? ' cued' : ''}${chains.every(c => c == null) ? ' empty' : ''}`,
      disabled: r > 127, title: r > 127 ? 'A program change cues rows 00–7F only' : `Cue row ${hex2(r)}`});
    b.append(el('b', {textContent: hex2(r)}), ...chains.map((c, ch) => el('span', {className: here[ch] ? 'on' : '', textContent: c == null ? '--' : hex2(c)})));
    return b;
  }));
}
/* the mixer, laid out as one: the master (tempo display, Tap, Play all, the clock), a channel strip per deck (its
   letter in the deck's colours, the FILTER knob, a level meter: the fader or the crossfader's share), the crossfader,
   and its setup (the mixer, its ports and channels, the curve) at the foot */
function drawMixer() {
  if (!root) return;
  const m = root.querySelector('.dj-mixer'), ms = root.querySelector('.dj-master'), p = preset(mixer.id), ports = mixerPorts();
  const portSel = (list, v, f, label) => sel([['', 'None'], ...list.map(x => [x.id, x.name])], v, f, label);
  const xf = el('input', {type: 'range', min: 0, max: 1000, value: Math.round(mixer.xfader * 1000), className: 'dj-xfader', oninput: () => setXfader(+xf.value / 1000)});
  xf.setAttribute('aria-label', 'Crossfader');
  xf.ondblclick = () => { xf.value = 500; setXfader(0.5); };
  const chSel = i => sel(Array.from({length: p.channels}, (_, c) => [String(c + 1), `ch ${c + 1}`]), String(mixer.map[i] || i + 1),
    v => { mixer.map[i] = +v; store.set('dj-mixer-map', JSON.stringify(mixer.map)); }, `Deck ${NAMES[i]}'s mixer channel`);
  const meterParts = [0, 1].map(() => ({bar: el('span'), src: el('small')}));
  const note = el('p', {className: 'dj-small'});
  const source = sel([['page', 'This page'], ...ports.ins.map(x => [x.id, `Clock from ${x.name}`])], master.source, setSource, 'Master clock');
  const mb = masterNow();
  const bpmIn = el('input', {type: 'number', min: 40, max: 295, step: master.whole ? 1 : 0.1, value: master.source === 'page' ? bpmText(master.bpm) : (mb.bpm || ''), disabled: master.source !== 'page',
    onchange: () => handMasterBpm(+bpmIn.value), className: 'dj-bpm-in'});
  bpmIn.setAttribute('aria-label', 'Master tempo');
  const big = el('div', {className: 'dj-bpm big', textContent: mb.bpm ? bpmText(mb.bpm) : '—'});
  const whole = el('input', {type: 'checkbox', checked: master.whole, onchange: () => setWhole(whole.checked)});
  /* a channel strip: the deck's FILTER knob (low-pass left, high-pass right; a range input under it) and its meter */
  const strip = i => {
    const d = decks[i];
    const filt = el('input', {type: 'range', min: -64, max: 63, value: d.filter, className: 'dj-filter', oninput: () => deckFilter(d, +filt.value)});
    filt.setAttribute('aria-label', `Deck ${NAMES[i]} DJ filter: low-pass left, high-pass right`);
    const knob = el('div', {className: 'dj-knob', title: 'FILTER: drag up or right for high-pass, down or left for low-pass; double-click: off'}, el('i'), filt);
    dragKnob(knob, filt, v => deckFilter(d, v));
    knob.ondblclick = () => { filt.value = 0; deckFilter(d, 0); };
    if (d.ui) { d.ui.filt = filt; }
    const s = el('div', {className: 'dj-strip'},
      el('b', {className: 'dj-strip-id', textContent: NAMES[i]}),
      el('span', {className: 'dj-small', textContent: 'FILTER'}), knob,
      el('div', {className: 'dj-small dj-lphp'}, el('span', {textContent: 'LP'}), el('span', {textContent: 'HP'})),
      el('div', {className: 'dj-meter'}, meterParts[i].bar, meterParts[i].src));
    stripColours(s, d);
    return s;
  };
  const strips = [strip(0), strip(1)];
  decks.forEach(showKnob);
  const off = master.source !== 'page';
  const check = (on, f, text, title) => { const c = el('input', {type: 'checkbox', checked: on, onchange: () => f(c.checked)}); return el('label', {className: 'dj-small', title}, c, text); };
  const pads = Array.from({length: PADS}, (_, n) => padBtn(n, off));
  const glideTo = el('input', {type: 'number', min: 40, max: 295, step: master.whole ? 1 : 0.1, value: bpmText(master.glide ? master.glide.to : master.bpm), className: 'dj-bpm-in', disabled: off});
  glideTo.setAttribute('aria-label', 'Glide to (BPM)');
  const glideBtn = btn(master.glide ? 'STOP' : 'GLIDE', () => master.glide ? stopGlide() : startGlide(+glideTo.value),
    {className: `dj-pad dj-tbtn${master.glide ? ' on' : ''}`, disabled: off, title: 'Move the master\'s tempo evenly to this one over the bars chosen'});
  const fromDeck = decks.map(d => el('button', {type: 'button', onclick: () => masterFromDeck(d), className: 'dj-pad dj-tbtn dj-from-deck', disabled: off || !d.live?.bpm,
    ariaLabel: `Master to deck ${NAMES[d.i]}'s LSDj tempo`, title: `The master takes deck ${NAMES[d.i]}'s LSDj tempo (its song's TEMPO on the FM-1)`},
    el('small', {textContent: `LSDJ ${NAMES[d.i]}`}), el('b', {textContent: lsdjBpmText(d)})));
  mixer.ui = {bpmIn, big, xf, meters: meterParts, note, strips, pads, glideBtn, glideTo, fromDeck};
  const running = master.source === 'page' ? !!master.clock?.running : !!master.ext?.running;
  /* the master: one bar across the top of the decks (index.html .dj-master), its groups side by side and wrapping
     when the window is narrow: its tempo; the tempo and Tap; ×½ / ×2 and the decks' LSDj tempos; the pads; a glide;
     Play all and the clock; the options. (It was the top of the middle column, which left the mixer too little room.) */
  ms.replaceChildren(
    el('div', {className: 'dj-mb-id'}, el('h4', {textContent: 'Master'}), big),
    el('div', {className: 'dj-mgrid dj-mg-tempo'},
      stepBtn('−', -1, (dir, size) => stepMaster(dir, size), {className: 'dj-pad dj-tbtn', disabled: off, ariaLabel: 'Master tempo down', title: 'Tempo down (hold: faster)'}),
      bpmIn,
      stepBtn('+', 1, (dir, size) => stepMaster(dir, size), {className: 'dj-pad dj-tbtn', disabled: off, ariaLabel: 'Master tempo up', title: 'Tempo up (hold: faster)'}),
      btn('TAP', () => { const b = master.tap.tap(now()); if (b) handMasterBpm(b); }, {className: 'dj-pad dj-tap', disabled: off, title: 'Tap in time'})),
    el('div', {className: 'dj-mgrid dj-mg-4'},
      btn('×½', () => halfDouble(null, 0.5), {className: 'dj-pad dj-tbtn', disabled: off, ariaLabel: 'Master half time', title: 'Half the master\'s tempo'}),
      btn('×2', () => halfDouble(null, 2), {className: 'dj-pad dj-tbtn', disabled: off, ariaLabel: 'Master double time', title: 'Double the master\'s tempo'}),
      ...fromDeck),
    el('div', {className: 'dj-tpads', role: 'group', ariaLabel: 'Tempo pads: tap to go, hold to keep the tempo now'}, ...pads),
    el('div', {className: 'dj-mgrid dj-glide'}, glideTo,
      sel(GLIDE_BARS.map(b => [String(b), `${b} bar${b > 1 ? 's' : ''}`]), String(master.glideBars), v => { master.glideBars = +v; store.set('dj-glide-bars', v); }, 'Glide length'),
      glideBtn),
    el('div', {className: 'dj-mgrid dj-mg-2'}, mixer.ui.playAll = btn(running ? '■ Stop all' : '▶ Play all', masterPlay, {className: `dj-pad${running ? ' on' : ''}`}), source),
    el('div', {className: 'dj-mopts'},
      el('label', {className: 'dj-small', title: 'Every tempo set here snaps to a whole number: Tap, typing, − / +, the decks, the mixer\'s tempo control'}, whole, ' Whole BPM'),
      check(master.onBar, v => { master.onBar = v; store.set('dj-tempo-bar', v ? '1' : '0'); }, ' Next bar',
        'Pads, ×½ / ×2, LSDj tempos and a glide\'s start wait for the master\'s next bar (while it plays)'),
      check(master.padGlide, v => { master.padGlide = v; store.set('dj-pad-glide', v ? '1' : '0'); }, ' Pads glide', 'A pad glides to its tempo (over the bars chosen) instead of jumping')),
    /* a phone on its side (index.html: the compact console): the master's other controls, the top line's and each
       deck's "by" choices behind ⋯ (#dj-root.more); hidden on a larger screen */
    btn('⋯', () => { const on = root.classList.toggle('more'); ms.querySelector('.dj-more')?.setAttribute('aria-expanded', String(on)); },
      {className: 'dj-pad dj-more', ariaLabel: 'More DJ controls', title: 'More: the tempo box, ×½ / ×2, the tempo pads, glide, the clock, Log and set up', ariaExpanded: String(root.classList.contains('more'))}));
  /* the mixer: a channel strip per deck, the crossfader, and its setup (⚙: opens over the strips, never pushing them
     out of the column) */
  m.replaceChildren(...[
    el('h4', {textContent: 'Mixer'}),
    el('div', {className: 'dj-strips'}, ...strips),
    el('div', {className: 'dj-xrow'}, el('b', {textContent: 'A'}), xf, el('b', {textContent: 'B'})),
    note,
    /* the mixer's setup, folded away once set (kept in this browser; open while MIDI learn waits for a control): it
       never takes the live controls' room */
    el('details', {className: 'dj-setup', open: setupOpen(p), ontoggle: e => { if (e.target.open !== setupOpen(p)) store.set('dj-mixer-setup', e.target.open ? '1' : '0'); }},
      el('summary', {title: 'The MIDI mixer: which one, its ports and channels, the crossfader curve'}, el('span', {className: 'dj-setup-h', textContent: '⚙ Setup'}), el('span', {className: 'dj-small', textContent: p.name})),
      el('div', {className: 'dj-setup-body'},
      sel(PRESETS.map(x => [x.id, x.name + (x.verified ? '' : ' (unverified)')]), mixer.id, v => { mixer.id = v; mixer.faders = {}; store.set('dj-mixer', v); setXfader(mixer.xfader); draw(); }, 'Mixer'),
      p.id === 'none' ? null : el('div', {className: 'dj-row'}, el('label', {}, 'From ', portSel(ports.ins, mixer.inId, setMixerIn, 'Mixer MIDI in')),
        el('label', {}, 'To ', portSel(ports.outs, mixer.outId, v => { mixer.outId = v; store.set('dj-mixer-out', v); }, 'Mixer MIDI out'))),
      p.id === 'none' ? null : el('div', {className: 'dj-row'}, el('label', {}, 'A on ', chSel(0)), el('label', {}, 'B on ', chSel(1))),
      p.note ? el('p', {className: 'dj-small', textContent: p.note}) : null,
      el('label', {className: 'dj-small'}, 'Crossfader ', sel(CURVES.map(c => [c, {smooth: 'Smooth fade', linear: 'Linear', cut: 'Cut (scratch)'}[c]]), mixer.curve,
        v => { mixer.curve = v; store.set('dj-curve', v); setXfader(mixer.xfader); }, 'Crossfader curve')),
      p.id === 'learn' ? learnBox() : null))].filter(Boolean));
  mixerNumbers();
}
/* the mixer's setup (the ⚙ drawer) open: as last left, closed at first; and
   always while MIDI learn waits */
function setupOpen(p) {
  if (mixer.learning) return true;
  const v = store.get('dj-mixer-setup', '');
  return v === '1';   /* (closed at first: open, it lies over the strips and the crossfader) */
}
/* a tempo pad: tap, its tempo; hold (or right-click), keep the master's tempo now in it */
function padBtn(n, off) {
  let t = 0, saved = false;
  const b = el('button', {type: 'button', className: 'dj-pad dj-tpad', disabled: off});
  b.onpointerdown = e => { if (e.button) return; saved = false; clearTimeout(t); t = setTimeout(() => { saved = true; padSave(n); }, 600); };
  b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(t);
  b.onclick = () => { if (!saved) padGo(n); saved = false; };
  b.oncontextmenu = e => { e.preventDefault(); clearTimeout(t); padSave(n); };
  showPad(b, n);
  return b;
}
function showPad(b, n) {
  const v = master.pads[n];
  b.textContent = v == null ? `P${n + 1}` : bpmText(v);
  b.classList.toggle('empty', v == null);
  b.title = v == null ? `Pad ${n + 1}: empty (tap or hold: keep the tempo now)` : `Pad ${n + 1}: ${bpmText(v)} BPM (tap: go; hold or right-click: keep the tempo now)`;
  b.setAttribute('aria-label', b.title);
}
const showPads = () => mixer.ui?.pads?.forEach((b, n) => showPad(b, n));
function showGlide() {
  const u = mixer.ui;
  if (!u?.glideBtn) return;
  u.glideBtn.textContent = master.glide ? 'STOP' : 'GLIDE'; u.glideBtn.classList.toggle('on', !!master.glide);
  if (master.glide && u.glideTo.ownerDocument.activeElement !== u.glideTo) u.glideTo.value = bpmText(master.glide.to);
}
/* a channel strip in its deck's colours (its FM-1's theme), or the DJ colours */
function stripColours(s, d) {
  const box = d.ui?.box;
  for (const k of ['--accent', '--accent-ink']) {
    const v = box?.classList.contains('themed') ? box.style.getPropertyValue(k) : '';
    if (v) s.style.setProperty(k, v); else s.style.removeProperty(k);
  }
}
/* the mixer's moving parts only (faders, crossfader, the note): a mixer sends many messages a second, and the
   page's own crossfader is being dragged, so these never rebuild the panel */
function mixerNumbers() {
  const u = mixer.ui;
  if (!u?.xf) return;
  const g = crossfade(mixer.xfader, mixer.curve);
  /* what reaches each deck: its channel fader on the mixer (when the mixer has sent one) times its crossfader share */
  u.meters.forEach((x, i) => {
    const f = mixer.id === 'none' ? null : mixer.faders[mixer.map[i]];
    x.bar.style.setProperty('--v', ((f ?? 1) * g[i]).toFixed(3));
    x.src.textContent = f != null ? 'fader × xfade' : 'xfade';
  });
  const v = String(Math.round(mixer.xfader * 1000));
  if (u.xf.value !== v) u.xf.value = v;   /* (dragged here: already that value) */
  u.note.textContent = mixer.note; u.note.hidden = !mixer.note;
}
function learnBox() {
  const pick = sel(ACTIONS.map((a, i) => [String(i), actName(a)]), '0', () => {}, 'Action to learn');
  return el('div', {className: 'dj-learn'},
    el('div', {className: 'dj-row'}, pick, btn(mixer.learning ? 'Move a control…' : 'Learn', () => {
      mixer.learning = mixer.learning ? null : {...ACTIONS[+pick.value]};
      mixer.note = mixer.learning ? `Move the control for ${actName(mixer.learning)} on your mixer.` : ''; drawMixer();
    }, {className: mixer.learning ? 'on' : ''}), btn('Forget all', () => { mixer.learned = []; store.set('dj-learned', '[]'); drawMixer(); }, {disabled: !mixer.learned.length})),
    el('ul', {className: 'hint dj-learned'}, ...mixer.learned.map(r => el('li', {textContent: `${r.type.toUpperCase()} ${r.num} ch ${r.ch} → ${actName(r)}`}))));
}
function draw() {
  if (!root) return;
  decks.forEach(d => {
    d.ui.pick.replaceChildren(...deckChoices().map(([v, t]) => new Option(t, v)));
    d.ui.pick.value = d.key ? `${d.kind}:${d.key}` : '';
    drawDeck(d);
    deckScreen(d);
  });
  drawMixer();
}
/* the moving parts, 20 times a second: tempo readouts, beat lights, the gap to the master, what the FM-1 says */
function tick() {
  glideTick(now());   /* (before the readouts: they show the tempo it has reached) */
  const t = now(), m = masterNow(t);
  if (mixer.ui?.big) { const s = m.bpm ? bpmText(m.bpm) : '—'; if (mixer.ui.big.textContent !== s) mixer.ui.big.textContent = s; }   /* the master's tempo */
  mixer.ui?.fromDeck?.forEach((b, i) => {   /* each deck's LSDj tempo, as last polled */
    const d = decks[i], s = lsdjBpmText(d), off = !pageMaster() || !d.live?.bpm, n = b.lastChild;
    if (n.textContent !== s) n.textContent = s;
    if (b.disabled !== off) b.disabled = off;
  });
  decks.forEach(d => { if (d.synced) followMaster(d); });   /* Sync: the master's tempo and bar, kept */
  decks.forEach(d => {
    const u = d.ui;
    if (!u?.bpm) return;
    const ph = d.clock?.phase(t) ?? null;
    /* not clocked by this page: the FM-1's own phrase row (0.9.98; a phrase is a bar, 4 rows a beat), as last polled */
    const own = ph == null ? fm1Row(d) : null;
    setText(u.bpm, own != null ? String(d.live.bpm) : bpmText(d.bpm * (d.clock?.factor || 1)));
    /* the pitch against the master: the fader (unless held) and its percentage */
    const pv = pitchValue(d), pt = `${pv > 0 ? '+' : pv < 0 ? '−' : '±'}${(Math.abs(pv) / 100).toFixed(2)} %`;
    if (u.pitchTxt && u.pitchTxt.textContent !== pt) u.pitchTxt.textContent = pt;
    if (u.pitch && !u.pitchHeld && u.pitch.ownerDocument.activeElement !== u.pitch && +u.pitch.value !== pv) u.pitch.value = pv;
    const gap = offset(ph, m.phase);
    setText(u.gap, gap != null ? (Math.abs(gap) < 0.5 ? 'in sync' : `${gap > 0 ? 'behind' : 'ahead'} ${(Math.abs(gap) / 6).toFixed(1)} rows`)
      : own != null ? `own clock · row ${hex2(own)}` : d.clock?.running ? 'no master' : 'stopped');
    if (u.info) setText(u.info, !d.live ? '' : [`On the FM-1: ${d.live.bpm} BPM · playing ${CHANNELS.filter((n, c) => (d.live.playing >> c) & 1).join(' ') || 'nothing'}`,
      d.live.level != null && d.live.level < 127 ? `volume ${Math.round(d.live.level / 1.27)} % from this page` : ''].filter(Boolean).join(' · '));
    if (u.hold && d.live?.live != null) { setText(u.hold, d.live.live ? HOLD_ON : HOLD_OFF); u.hold.classList.toggle('on', d.live.live); u.hold.setAttribute('aria-pressed', String(d.live.live)); }
  });
}
/* (20 times a second: a write only when the text changed, so the page isn't laid out again for nothing) */
const setText = (e, s) => { if (e.textContent !== s) e.textContent = s; };
/* The jog wheels and beat lights, every frame the screen draws (requestAnimationFrame), not on the 50 ms tick: they
   turned in 20 steps a second, unevenly. Colin saw deck A's skip. */
let animating = 0;
function animate() {
  animating = requestAnimationFrame(animate);
  const t = now();
  for (const d of decks) {
    const u = d.ui;
    if (!u?.phase || !u.jog?.isConnected) continue;
    const p = deckPos(d, t), beat = p == null ? -1 : Math.floor(p / BEAT) % 4;
    if (beat !== u.beatShown) {
      u.beatShown = beat; [...u.phase.children].forEach((s, b) => s.classList.toggle('on', b === beat));
    }
    if (p != null) u.jog.style.setProperty('--turn', `${(p / BAR * 360).toFixed(1)}deg`);   /* once round a bar */
  }
}
/* where a deck is in its bar, in clocks (0 .. BAR), or null when it isn't playing: this page's clock for it, or the
   FM-1's own phrase row (LIVE, 0.9.98) carried on at its tempo between polls, which come every 0.4 s or so, and less
   evenly on a busy link (the FM-1 in use also has Perform's own poll): a row is 6 clocks, 4 a beat */
const ROW = BEAT / 4;
function deckPos(d, t) {
  const ph = d.clock?.phase(t) ?? null;
  if (ph != null) return ((ph % BAR) + BAR) % BAR;
  if (d.ownRow == null || !d.live?.bpm) return null;
  const rows = d.ownRow + (t - d.ownAt) * d.live.bpm * 4 / 60000;
  return ((rows * ROW) % BAR + BAR) % BAR;
}
/* each LIVE (pollRound): the estimate pulled half-way to where the FM-1 says it is (the row it reports started up to a
   poll ago: its middle), so it never jumps a little each poll; a big difference (a cue, a jump): taken at once */
function ownAnchor(d) {
  const r = d.clock?.running ? null : fm1Row(d), t = now();
  if (r == null || !d.live?.bpm) { d.ownRow = null; return; }
  if (d.ownRow == null) { d.ownRow = r + 0.5; d.ownAt = t; return; }
  const est = d.ownRow + (t - d.ownAt) * d.live.bpm * 4 / 60000;
  let err = ((r + 0.5 - est) % 16 + 24) % 16 - 8;   /* (-8 .. 8 rows, round the phrase) */
  d.ownRow = Math.abs(err) > 3 ? r + 0.5 : est + err / 2; d.ownAt = t;
}
/* the first playing channel's phrase row, from LIVE (0.9.98), or null */
function fm1Row(d) {
  const l = d.live;
  if (!l?.rows) return null;
  const c = [0, 1, 2, 3].find(c => (l.playing >> c) & 1 && l.rows[c] != null);
  return c == null ? null : l.rows[c] & 15;
}
/* 0.9.98: LSDj's SYNC said plainly when it won't follow this page's clock */
/* ---------- the deck's FM-1 set up for this page's clock, by itself (Colin: fix it, don't ask) ----------
   Decks that wouldn't start, and FM-1s that wouldn't play by themselves after DJing, came from LSDj's SYNC and the
   FM-1's MIDI settings. The right setup: LSDj PROJECT › SYNC = KEYBD (the FM-1 switches it to MIDI for the page's
   Start and back after Stop, so START on the FM-1 plays in between), and the FM-1's CLOCK IN = ALL (or USB),
   TRANSPORT ON, PC CUE ON (CUE and Rows). Whatever can't be set is said on the deck's warning strip. */
const SYNC_NAME = {off: 'OFF', lsdj: 'LSDJ', midi: 'MIDI', keybd: 'KEYBD'};
/* the FM-1's MIDI settings, once a deck assignment: only what the deck needs changes (CLOCK OUT and the rest kept);
   live, not stored (no flash write while a deck may play: set again each time a deck takes the FM-1) */
async function deckMidi(d, l) {
  const key = d.key;
  let w = null;
  try { w = await l.midiGet(); } catch { return; }
  if (d.key !== key) return;
  if (w == null) { d.clockOut = null; d.midiKnown = true; d.ccFx = 0; return; }   /* (no MIDI settings: CLOCK OUT unknown, SYNC = LSDJ left) */
  const m = unpackMidi(w), fix = [];
  d.clockOut = !!m.clockOut; d.midiKnown = true;
  if (m.clockIn !== 1 && m.clockIn !== 2) { fix.push('CLOCK IN to ALL'); m.clockIn = 1; }
  if (!m.transport) { fix.push('TRANSPORT ON'); m.transport = 1; }
  if (!m.pcCue) { fix.push('PC CUE ON'); m.pcCue = 1; }
  if (!m.ccFx) { fix.push('CC FX to channels 1-4'); m.ccFx = 1; }   /* (the kill pads: CC 81, one channel each) */
  d.ccFx = m.ccFx;
  if (!fix.length) return;
  try {
    await l.midiSet(packMidi(m));
    say(`Deck ${NAMES[d.i]}: set the FM-1's ${fix.join(', ')} (the deck needs them).`);
  } catch (e) { d.ccFx = 0; setWarn(d, 'midi', `The FM-1's MIDI settings couldn't be set (${e.message}): GLO › MIDI › CLOCK IN = ALL, TRANSPORT ON, PC CUE ON, CC FX on.`); }   /* (kills: the whole mask then) */
}
/* LSDj's SYNC, each poll (LIVE, 0.9.98): set to KEYBD while LSDj is stopped (0.9.98-dev.2 SYNC_SET), once a value;
   SYNC = LSDJ with CLOCK OUT on is left (that FM-1 leads: choose it as the master clock) */
/* this deck's FM-1 is the one the master clock comes from (Master › Clock from its input) */
const isMasterFm1 = d => master.source !== 'page' && hooks.linkFor(d.key)?.input?.id === master.source;
async function lsdjSync(d, l) {
  const s = d.live?.sync;
  if (fwOf(d) < 998) return;   /* (older firmware doesn't say: the help says how) */
  if (s == null) return setWarn(d, 'sync', 'This FM-1 can\'t read this LSDj\'s SYNC: set PROJECT › SYNC = KEYBD on LSDj.');
  if (s === 'keybd') { d.syncTried = null; return setWarn(d, 'sync', ''); }
  /* nothing changed before the FM-1's MIDI settings are read (deckMidi, a moment after the deck takes it): a poll
     before that saw CLOCK OUT as off and set a leading FM-1 (SYNC = LSDJ) to KEYBD, and it stopped sending its clock
     to the other deck (Colin). The master clock's own FM-1 is never changed. */
  if (!d.midiKnown) return;
  const master_ = isMasterFm1(d);
  if (s === 'lsdj' && (d.clockOut !== false || master_)) {
    return setWarn(d, 'sync', master_ ? (d.clockOut === false ? 'This FM-1 is the master clock, but its CLOCK OUT is off: set GLO › MIDI › CLOCK OUT = USB.' : '')
      : 'LSDj SYNC is LSDJ with CLOCK OUT on: this FM-1 leads, so it won\'t follow this deck. Choose it as the master clock, or set SYNC = KEYBD.');
  }
  if (master_) return;
  if (d.clock?.running || d.live.playing) return;   /* (playing: MIDI is the FM-1's own switch, back after Stop) */
  if (d.syncTried === s) return;
  d.syncTried = s;
  const r = await l.syncSet('keybd').catch(() => 'no');
  if (r === 'ok') { setWarn(d, 'sync', ''); say(`Deck ${NAMES[d.i]}: set LSDj's SYNC from ${SYNC_NAME[s]} to KEYBD (the FM-1 switches it to MIDI while this page plays it).`); }
  else if (r === 'playing') d.syncTried = null;   /* (next poll) */
  else if (s === 'midi' || s === 'lsdj')   /* 0.9.98-dev.1: OFF and KEYBD switch by themselves; these don't */
    setWarn(d, 'sync', `LSDj SYNC is ${SYNC_NAME[s]}: set it to KEYBD on LSDj's PROJECT screen (0.9.98-dev.2 does it by itself), or the FM-1 ${s === 'lsdj' ? 'won\'t follow this deck' : 'won\'t play without this page'}.`);
}
/* the warning strip under the deck's name: what the page couldn't set up (one line each) */
function setWarn(d, what, text) {
  d.warn = {...d.warn, [what]: text};
  const u = d.ui;
  if (!u?.warn) return;
  const lines = Object.values(d.warn).filter(Boolean);
  u.warn.hidden = !lines.length;
  if (u.warn.textContent !== lines.join(' ')) u.warn.textContent = lines.join(' ');
}

const HELP = 'Each deck follows this page\'s clock at its own tempo. On each FM-1: LSDj PROJECT › SYNC = KEYBD (the FM-1 switches it to MIDI while a deck plays it, and back after, so START on the FM-1 plays by itself in between), GLO › MIDI › CLOCK IN = ALL or USB, TRANSPORT ON, PC CUE ON. Each deck sets these itself (LSDj SYNC with 0.9.98-dev.2) and says what it changed in the Log. The audio goes through your mixer as usual; without one, the crossfader sets each FM-1\'s volume (0.9.98). A Game Boy on an ArduinoBoy: choose its MIDI port as "(ArduinoBoy)", one port per deck. Turn a jog wheel to nudge its deck; the tempo fader sets its tempo against the master\'s.' +
  ' Tempo: − / + step it (held, faster), ◀ ▶ nudge a playing deck while held, ×½ / ×2 halve or double it, MASTER puts a deck back on the master\'s tempo; the four tempo pads keep tempos (hold one to keep the tempo now), Glide moves the master there over 1 to 16 bars, and Next bar makes pads, ×½ / ×2 and glides wait for the bar. A MIDI mixer can learn all of them.';
/* Perform's DJ panel (index.html #dj-root): built once; the decks and mixer drawn again when things change */
export function mountDj(box) {
  root = box;
  /* the page closing: the decks' FM-1s get OP4 / OP5 back at once (not after 3 s) */
  addEventListener('pagehide', () => { for (const d of decks) if (d.kind === 'fm1') djLetGo(d.key); });
  statusEl = el('p', {className: 'hint dj-status', role: 'status'});
  const deckBox = d => {
    const chip = el('span', {className: 'dj-cart-chip', hidden: true});   /* the cartridge it holds (drawLabel) */
    const pick = el('select', {onchange: () => { d.gone = null; void assign(d, pick.value); }});
    pick.setAttribute('aria-label', `Deck ${NAMES[d.i]}`);
    const body = el('div', {className: 'dj-deck-body'});
    const screen = el('canvas', {width: 160, height: 144, className: 'dj-screen', role: 'img', ariaLabel: `Deck ${NAMES[d.i]}: the FM-1's screen`});
    /* the warning strip: what the page couldn't set up on this deck's FM-1 (setWarn), kept across redraws */
    const warn = el('p', {className: 'dj-warn', role: 'status', hidden: true});
    const keyChip = el('span', {className: 'dj-key', hidden: true, role: 'status'});   /* the song's key (deckSong) */
    const presets = el('div', {className: 'dj-presets', hidden: true, role: 'group', ariaLabel: `Deck ${NAMES[d.i]} presets`});   /* (drawPresets) */
    const box = el('section', {className: 'dj-deck', ariaLabel: `Deck ${NAMES[d.i]}`}, el('h4', {className: 'dj-deck-head'},
      el('span', {className: 'dj-deck-id', title: `Deck ${NAMES[d.i]}`}, el('span', {className: 'sr-only', textContent: 'Deck '}), NAMES[d.i]), pick, chip, keyChip), warn, presets, body);
    /* the crate (crate-ui.js): a card dropped here loads onto this deck; meanwhile a cover with its progress */
    const loadText = el('span'), loadBar = el('progress', {value: 0, max: 1, hidden: true});
    const loadEl = el('div', {className: 'dj-loading', hidden: true, role: 'status'}, loadText, loadBar);
    box.append(loadEl);
    box.ondragover = e => { if ([...(e.dataTransfer?.types || [])].includes(CRATE_TYPE)) { e.preventDefault(); box.classList.add('drop'); } };
    box.ondragleave = () => box.classList.remove('drop');
    box.ondrop = e => { box.classList.remove('drop'); dropOnDeck(e, d.i); };
    d.ui = {pick, body, screen, box, warn, loadEl, loadText, loadBar, chip, keyChip, presets};
    return box;
  };
  const themePick = sel([['page', 'Page colours'], ...THEMES.map((n, i) => [String(i), n]).filter(([i]) => THEME_COLOURS[+i])], djTheme,
    v => { djTheme = v; store.set('dj-theme', v); applyDjTheme(); }, 'DJ colours');
  /* each deck's effects panel (dj-fx.js), on its outer edge: a drawer with a tab, or a column (FX: Drawers |
     Columns); ⇱ puts it in its own window (popout.js), ⇱ there or closing the window brings it back */
  const fxBox = d => {
    const ab = d.i ? 'b' : 'a';
    d.fxPanel = fxPanel({name: `Deck ${NAMES[d.i]}`, get: () => fxOf(d), set: (k, c, v) => fxEdit(d, k, c, v), mute: () => killShown(d), onFm1: () => d.live?.page ?? null,
      fw: () => fwOf(d) || Infinity, page: +store.get(`dj-fx-page-${d.i}`, 1), onPage: p => store.set(`dj-fx-page-${d.i}`, String(p)),
      actions: [btn('⇱', () => fxPop(d), {className: 'dj-fx-pop', title: 'In its own window (again: back here)', ariaLabel: `Deck ${NAMES[d.i]} FX in its own window`}),
        btn('✕', () => fxOpen(d, false), {className: 'dj-fx-close', title: 'Close the drawer', ariaLabel: `Close deck ${NAMES[d.i]} FX`})]});
    d.ui.fxBox = el('section', {className: `dj-fx dj-fx-${ab}`, ariaLabel: `Deck ${NAMES[d.i]} effects`}, d.fxPanel.el);
    d.ui.fxTab = btn(`FX ${NAMES[d.i]}`, () => fxOpen(d, !d.fxOpen), {className: `dj-fx-tab dj-fx-tab-${ab}`, title: `Deck ${NAMES[d.i]}'s effects`});
    fxOpen(d, store.get(`dj-fx-open-${d.i}`, '0') === '1');
    return d.ui.fxBox;
  };
  const deckA = deckBox(decks[0]), deckB = deckBox(decks[1]);
  const viewBtn = (v, text) => btn(text, () => setFxView(v), {className: fxView === v ? 'on' : '', ariaPressed: String(fxView === v)});
  const fxViews = el('div', {className: 'seg dj-fx-views', role: 'group', ariaLabel: 'FX panels'}, viewBtn('drawers', 'Drawers'), viewBtn('columns', 'Columns'));
  fxViews.querySelectorAll('button').forEach((b, n) => { b.dataset.fxView = n ? 'columns' : 'drawers'; });
  box.replaceChildren(
    el('div', {className: 'dj-top'}, statusEl, logBox(), el('details', {className: 'dj-help'}, el('summary', {textContent: 'How to set up'}), el('p', {textContent: HELP})),
      el('label', {className: 'hint', title: 'Each deck\'s effects: drawers that open from the outer edges, or columns always open'}, 'FX ', fxViews),
      el('label', {className: 'hint', title: 'The DJ layout\'s own colours: its background and the master and mixer. FM-1 decks keep their FM-1\'s theme.'}, 'DJ colours ', themePick)),
    el('section', {className: 'dj-master', ariaLabel: 'Master tempo'}),
    el('div', {className: `dj-grid${fxView === 'columns' ? ' fx-columns' : ''}`}, fxBox(decks[0]), deckA, el('section', {className: 'dj-mixer', ariaLabel: 'Mixer'}), deckB, fxBox(decks[1]),
      decks[0].ui.fxTab, decks[1].ui.fxTab),
    crateBox = el('section', {className: 'dj-crate', ariaLabel: 'Crate'}),
  );
  void mountCrate(crateBox);
  if (mixer.inId) setMixerIn(mixer.inId);
  applyDjTheme();
  draw();
}
/* Log: what happened to the FM-1 connections, newest last, with times (conn-log.js), to read after the status
   line has moved on; Copy puts it on the clipboard to send */
function logBox() {
  const text = el('pre', {className: 'dj-log-text mono'});
  const fill = () => { text.textContent = logText() || 'Nothing yet.'; text.scrollTop = text.scrollHeight; };
  const copy = btn('Copy', async () => { try { await navigator.clipboard.writeText(logText()); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; } setTimeout(() => { copy.textContent = 'Copy'; }, 1500); });
  const box = el('details', {className: 'dj-log', ontoggle: () => { if (box.open) fill(); }},
    el('summary', {textContent: 'Log'}), text,
    el('div', {className: 'dj-log-acts'}, copy, btn('Clear', () => { clearLog(); fill(); })));
  document.addEventListener('conn-log', () => { if (box.open) fill(); });
  return box;
}
/* the DJ layout's own colours (kept in this browser): a theme preset's page colours (page-theme.js) on the DJ panel,
   and on the page itself while the layout shows; 'page': the page's colours. FM-1 decks keep their FM-1's colours
   (paintDeck sets them on the deck box, under these). */
let djTheme = store.get('dj-theme', 'page');
function applyDjTheme() {
  const colours = djTheme === 'page' ? null : THEME_COLOURS[+djTheme];
  const vars = colours ? pageColours(colours) : null;
  const panel = root?.closest('.panel') || root;
  for (const box of [panel, document.body]) {
    if (!box) continue;
    THEME_VARS.forEach(k => box.style.removeProperty(k));
    if (vars && (box !== document.body || shown)) Object.entries(vars).forEach(([k, v]) => box.style.setProperty(k, v));
  }
  panel?.classList.toggle('dj-themed', !!vars);
}
/* the DJ layout shown or hidden: the readouts and FM-1 polls run only while it shows */
export function djShown(on) {
  if (ticker) ticker();
  clearInterval(polling); cancelAnimationFrame(animating); ticker = polling = animating = 0;
  shown = on;
  applyDjTheme();   /* the page in the DJ colours only while the layout shows */
  decks.forEach(deckScreen);   /* the screens run only while the layout shows */
  if (!on) {   /* the Effects layout: the FM-1s at full volume, their OP4 / OP5 their own */
    decks.forEach(d => { deckLevel(d, null); if (d.kind === 'fm1') djLetGo(d.key); });
    return;
  }
  applyVolumes();
  draw();
  {   /* (a hidden tab's interval comes once a second: the Worker keeps Sync on the bar meanwhile) */
    const iv = setInterval(tick, 50), stopW = workerTimer(() => { if (document.hidden) tick(); }, 50);
    ticker = () => { clearInterval(iv); stopW(); };
  }
  animating = requestAnimationFrame(animate);
  polling = setInterval(() => void poll(), 400);
}
/* the FM-1s plugged in changed: the choices follow; a deck whose FM-1 went away is emptied */
let seenFm1s = new Map();   /* key -> {title, fw, crc}: what each FM-1 in the list last said, for knowing it again */
export function djDevicesChanged() {
  fwCache.clear();
  const list = hooks.devices();
  /* its FM-1 gone (pulled, a USB hiccup, or it didn't answer a search): the deck empties, and remembers it, playing
     and Sync included, so it takes it back by itself when it's found again (until another is chosen here) */
  for (const d of decks) if (d.kind === 'fm1' && !list.some(x => x.key === d.key)) {
    const was = seenFm1s.get(d.key);
    d.gone = {key: d.key, playing: !!d.clock?.running, synced: !!d.synced, others: new Set(list.map(x => x.key)),
      info: was && {title: was.title, firmware: was.fw, saveCrc: was.crc}};
    logEvent(`Deck ${NAMES[d.i]}: its FM-1 (${d.key}) went away${d.gone.playing ? ' while playing' : ''}.`);
    if (statusEl) statusEl.textContent = `Deck ${NAMES[d.i]}: its FM-1 went away. It comes back to this deck by itself when it's found again.`;
    void assign(d, '');
  }
  for (const d of decks) {
    const g = d.gone;
    if (!g || d.key) continue;
    /* the same ports, or (Windows numbers them again when it comes back) a new FM-1 on no deck, not one of those
       there when it went, that runs the same firmware and LSDj (its songs' checksum deciding between two) */
    const free = list.filter(x => !decks.some(o => o.key === x.key));
    const back = free.find(x => x.key === g.key) || sameFm1(free.filter(x => !g.others.has(x.key)), g.info, x => ({title: x.title, firmware: x.fw, saveCrc: x.crc}));
    if (!back) continue;
    d.gone = null;
    if (back.key !== g.key) {   /* its .sav label follows it to the new ports */
      const m = savsSent();
      if (m[g.key]) { m[back.key] = m[g.key]; delete m[g.key]; store.set(SAVS, JSON.stringify(m)); }
    }
    logEvent(`Deck ${NAMES[d.i]}: its FM-1 is back${back.key !== g.key ? ` on new ports (${g.key} -> ${back.key})` : ` (${g.key})`}${g.playing ? ', playing again from the next bar' : ''}.`);
    if (statusEl) statusEl.textContent = `Deck ${NAMES[d.i]}: its FM-1 is back.`;
    void assign(d, `fm1:${back.key}`).then(() => {
      if (g.synced && !d.synced) deckSync(d);
      if (g.playing && !d.clock?.running) deckPlay(d);
    });
  }
  for (const x of list) seenFm1s.set(x.key, {title: x.title, fw: x.fw, crc: x.crc});
  /* a search that found the same FM-1s and ports (it runs on every port change): nothing to redraw */
  const seen = JSON.stringify([list.map(x => [x.key, x.label, x.fw]), mixerPorts().outs.map(p => p.id), decks.map(d => d.key)]);
  if (seen === lastSeen) return;
  lastSeen = seen;
  draw();
  crateRedraw();
}
let lastSeen = '';
/* the crate (crate-ui.js): which decks there are, stopping one, giving it an FM-1 (or none), the ports it must not
   touch (the other deck's gear, the mixer, an outside master clock: the FM-1s themselves come from app.js), and the
   cover while one loads */
let crateBox = null;
setCrateHooks({}, {
  decks: () => decks.map(d => ({i: d.i, name: NAMES[d.i], kind: d.kind, key: d.key || null})),
  held: i => heldSav(decks[i])?.crc ?? null,   /* (the crate's ON A / ON B: the checksum of the .sav that deck's FM-1 holds) */
  stop: i => { const d = decks[i]; d.clock?.stop(); setSynced(d, false); deckBend(d, 1); d.nudging = false; draw(); },
  assign: (i, key) => assign(decks[i], key ? `fm1:${key}` : ''),
  avoid: i => [...decks.filter(d => d.i !== i && d.key && d.kind !== 'fm1').map(d => d.key),
    mixer.inId, mixer.outId, master.source !== 'page' ? master.source : ''].filter(Boolean),
  loading: (i, text, n, t) => {
    const u = decks[i].ui;
    if (!u) return;
    u.loadEl.hidden = text == null; u.box.classList.toggle('loading', text != null);
    u.loadText.textContent = text || '';
    u.loadBar.hidden = !t; if (t) { u.loadBar.max = t; u.loadBar.value = Math.min(n, t); }
  },
});
export const djState = () => ({master, mixer, decks});
/* a deck's LIVE of this FM-1 asked within maxAge ms, or null: app.js takes it instead of asking the same link again */
export function djLive(key, maxAge = 1000) {
  const d = decks.find(x => x.kind === 'fm1' && x.key === key && x.live?.askedAt != null);
  return d && now() - d.live.askedAt <= maxAge ? d.live : null;
}
