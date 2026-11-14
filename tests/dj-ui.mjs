// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout in the browser (mocked: two FM-1s and a TX-6 as MIDI ports; no device is touched). Run in a
// fresh local preview in real time (not a virtual-time browser): the deck clocks are timed.
//   Effects | DJ switches the layout; each deck takes an FM-1; Play sends Start and clocks to that FM-1 only, at the
//   deck's tempo; the second deck starts on the first's bar; Sync takes the master's tempo; a stem kill mutes;
//   the DJ filter sets all four channels' filters; Perform › Clock goes off; the TX-6 preset: a track button
//   starts / stops its deck, the crossfader sets its two channel volumes (CC 7).
import {OP, crc32} from '../lsdj/link.js';
import {djState, rememberSav, readSongAgain} from '../lsdj/dj-ui.js';
import {addToCrate} from '../lsdj/crate-ui.js';
import {unpackFx, unpackSettings, packSettings, PRESETS, unpackMidi} from '../lsdj/fx-model.js';
import {pageColours} from '../lsdj/page-theme.js';
import {crossfade, offset} from '../lsdj/dj.js';
import {buildSav, SONG_SIZE} from '../lsdj/lsdj-sav.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
/* a save with only its header filled in (names, versions, the open song, the block table): what a deck reads */
function fakeSave(songs, active) {
  const s = new Uint8Array(0x20000);
  s[0x813e] = 0x6a; s[0x813f] = 0x6b; s[0x8140] = active ?? 0xff; s.fill(0xff, 0x8141, 0x8200);
  let b = 0;
  for (const x of songs) {
    [...x.name].forEach((c, i) => s[0x8000 + x.slot * 8 + i] = c.charCodeAt(0)); s[0x8100 + x.slot] = x.version;
    s.fill(x.slot, 0x8141 + b, 0x8141 + b + x.blocks); b += x.blocks;
  }
  return s;
}
function fm1(n, title, fw = 'FM-1_997') {
  const d = {n, title, midi: [], fxSets: [], mutes: [], ccMutes: [], muteSets: 0, levels: [], seqs: [], mapReads: [], screens: 0, level: 127, seq: 0,
    settings: packSettings({...unpackSettings(0x5a000000), theme: n % PRESETS.length}),   /* each its own theme */
    infos: 0, reads: 0, begins: 0, importing: null, save: fakeSave([{slot: 0, name: 'TECHNO', version: 2, blocks: 10}], 0),
    midiWord: (0x4D000000 | 1 | 8 | 1 << 11 | 1 << 17) >>> 0, midiSets: [], sync: 5, syncSets: [], dev2: true,
    djs: [], djAsks: 0, dev4: true,   /* DJ_DECK states the page sent (0.9.98-dev.4) */
    dev6: fw >= 'FM-1_998', presetNames: ['DUB', null, 'LOFI', null, null, null, null, 'LAST'], presetCur: 0, presetLoads: []};   /* presets (0.9.98-dev.6) */   /* MIDI: CLOCK IN ALL, TRANSPORT ON, PC CUE ON; LSDj SYNC KEYBD */
  const fx = Array(68).fill(0); d.fxBytes = fx;   /* (a knob turned on the FM-1: change these) */
  fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[38] = 1;
  d.input = Object.assign(new EventTarget(), {id: `in-${n}`, name: 'FM-1', state: 'connected', onmidimessage: null});
  /* OP4 (0) / OP5 (1) pressed on this FM-1: DJ_KEY, sent never asked */
  d.djKey = k => queueMicrotask(() => d.input.onmidimessage?.({data: [0xf0, 0x7d, 0x47, 0x53, 0x34, 0, k, 0, 0xf7]}));
  d.output = {id: `out-${n}`, name: 'FM-1', state: 'connected', send(message, ts) {
    if (message[0] !== 0xf0) {
      const m = [...message]; m.ts = ts; d.midi.push(m);   /* ts: when it plays */
      /* CC 81 on a CC FX channel: that one channel muted (64+) or not, as the firmware does (lsdj_midi.h) */
      const ccFx = (d.midiWord >>> 11) & 15, c = (m[0] & 15) - (ccFx - 1);
      if ((m[0] & 0xf0) === 0xb0 && m[1] === 81 && ccFx && c >= 0 && c < 4) {
        const was = d.mutes.at(-1) || 0; d.mutes.push(m[2] >= 64 ? was | 1 << c : was & ~(1 << c)); d.ccMutes.push([c, m[2]]);
      }
      return;
    }
    const op = message[4], body = [];
    for (let i = 5; i + 1 < message.length - 1; i += 2) body.push(message[i] | (message[i + 1] & 1) << 7);
    const reply = (data = [], status = 0) => () => d.input.onmidimessage?.({   /* d.slow[op]: ms before that op's reply (a busy FM-1) */
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]});
    const send = (data, status) => d.slow?.[op] ? void setTimeout(reply(data, status), d.slow[op]) : queueMicrotask(reply(data, status));
    if (op === OP.INFO) { d.infos++; const info = Array(35).fill(0); info[0] = 1; info[34] = d.dev6 ? 8 : 0; [...fw].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); [...title].forEach((c, i) => info[9 + i] = c.charCodeAt(0));
      const crc = crc32(d.save); [0, 8, 16, 24].forEach((s, i) => info[29 + i] = (crc >>> s) & 255); return send(info); }
    if (op === OP.READ) { const off = body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24; d.reads++; return send([...d.save.subarray(off, off + 128)]); }
    /* a .sav sent (Songs › Send, the crate): taken whole at COMMIT */
    if (op === OP.ABORT) { d.importing = null; return send(); }
    if (op === OP.BEGIN) { d.importing = new Uint8Array(0x20000); d.begins++; return send(); }
    if (op === OP.CHUNK) { const off = body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24; d.importing?.set(body.slice(4, 132), off); return send(); }
    if (op === OP.COMMIT) { if (d.importing) { d.save = d.importing; d.importing = null; d.afterCommit?.(d.save); } return send(); }   /* (afterCommit: its LSDj changes them) */
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.FX_SET) { d.fxSets.push(body); fx.splice(0, body.length, ...body); return send(); }   /* (kept, as the FM-1 does: LIVE then reports it) */
    if (op === OP.MUTE_SET) { d.mutes.push(body[0]); d.muteSets++; return send(); }
    if (op === OP.SETTINGS_GET) return send([0, 8, 16, 24].map(s => (d.settings >>> s) & 255));
    if (op >= OP.SCREEN_INFO && op <= OP.SCREEN_FRAME) d.screens++;   /* (no screen here: the deck says so) */
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    const dj = fw >= 'FM-1_998' ? [0x82, 5, 5, 5, 5, 2, 2, 2, 2, d.sync, d.seq, d.level] : [];
    if (op === OP.MIDI_GET) return send([0, 8, 16, 24].map(s => (d.midiWord >>> s) & 255));
    if (op === OP.MIDI_SET) { d.midiWord = (body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24) >>> 0; d.midiSets.push(d.midiWord); return send(); }
    if (op === OP.SYNC_SET && fw >= 'FM-1_998' && d.dev2) { if (d.playing) return send([], 2); d.syncSets.push(body[0]); d.sync = body[0]; return send(); }
    if (op === OP.DJ_DECK) { d.djAsks++; if (fw >= 'FM-1_998' && d.dev4) { d.djs.push(body[0]); return send(); } return send([], 1); }
    if (d.dev6 && op === OP.PRESET_LIST) return send([d.presetCur ?? 0xFF, ...d.presetNames.flatMap(n => n ? [1, ...[...n.padEnd(12, ' ')].map(c => c.charCodeAt(0))] : Array(13).fill(0))]);
    if (d.dev6 && op === OP.PRESET_GET) { const n = d.presetNames[body[0]], b = Array(128).fill(0);
      if (n) { b[0] = 0x50; b[1] = 19; [...n.padEnd(12, ' ')].forEach((c, i) => b[2 + i] = c.charCodeAt(0)); b[16 + 42] = 0xf2; b[16 + 68] = 30; b[16 + 69] = 64; b[16 + 70] = 64; }
      return send(b); }
    if (d.dev6 && op === OP.PRESET_LOAD) { if (!d.presetNames[body[0]]) return send([], 2); d.presetLoads.push(body[0]); d.presetCur = body[0]; return send(); }
    if (op === OP.LIVE) return send([1, 1, (d.lsdjBpm ?? 120) & 255, (d.lsdjBpm ?? 120) >> 8, d.mutes.at(-1) || 0, 0, d.playing || 0, ...fx, ...dj]);   /* d.playing: the channels playing (a bit each) */
    if (fw >= 'FM-1_998' && op === OP.VOLUME_SET) { d.levels.push(body[0]); d.level = body[0]; return send(); }
    if (fw >= 'FM-1_998' && op === OP.SEQ_SET) { d.seqs.push(body[0]); d.seq = body[0]; return send(); }
    if (fw >= 'FM-1_998' && op === OP.SONG_ROWS) { d.mapReads.push(body[0]); return send([body[0], ...Array.from({length: 64}, (_, i) => i % 4 ? 0xFF : (body[0] + i / 4) & 0x3F)]); }
    return send([], 1);
  }};
  return d;
}
function tx6() {
  const t = {sent: []};
  t.input = Object.assign(new EventTarget(), {id: 'tx6-in', name: 'TX-6', state: 'connected'});
  t.output = {id: 'tx6-out', name: 'TX-6', state: 'connected', send(m) { t.sent.push([...m]); }};
  t.play = bytes => { const e = new Event('midimessage'); e.data = Uint8Array.from(bytes); t.input.dispatchEvent(e); };
  return t;
}
/* Rows: row 10 (hex) starts the second column, level with row 00 */
const rowsShown0Top = map => { const r = [...map.querySelectorAll('.dj-maprow')]; return Math.abs(r[0].getBoundingClientRect().top - r[16].getBoundingClientRect().top) < 2 && r[16].getBoundingClientRect().left > r[0].getBoundingClientRect().left; };
const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change')); };
const clocks = d => d.midi.filter(m => m[0] === 0xf8).length;

export async function runDjUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB', 'FM-1_998'), T = tx6();
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input], ['t', T.input]]);
  const AB = {sent: []};
  AB.output = {id: 'ab-out', name: 'Arduinoboy', state: 'connected', send(m) { AB.sent.push([...m]); }};
  access.outputs = new Map([['a', A.output], ['b', B.output], ['t', T.output], ['ab', AB.output]]);
  for (const k of ['lsdj-burrito-stage', 'dj-mixer', 'dj-mixer-in', 'dj-mixer-out', 'dj-mixer-map', 'dj-bpm', 'dj-learned', 'dj-view-0', 'dj-view-1', 'dj-whole', 'dj-theme', 'dj-ab-ch', 'dj-fx-view', 'dj-fx-open-0', 'dj-fx-open-1', 'dj-fx-page-0', 'dj-fx-page-1', 'dj-pads', 'dj-tempo-bar', 'dj-pad-glide', 'dj-glide-bars', 'dj-range-0', 'dj-range-1', 'dj-mixer-setup']) try { localStorage.removeItem(k); } catch {}
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    await $('connect-btn').onclick();
    await until(() => $('stage-pick').options.length >= 2, 'both FM-1s listed');

    // 1. the layout switch
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    assert(document.body.classList.contains('dj') && getComputedStyle($('pan-dj')).display !== 'none', 'DJ layout shown');
    assert(getComputedStyle($('pan-chans')).display === 'none', 'the effects panels hidden');
    const [pickA, pickB] = [...document.querySelectorAll('.dj-deck h4 select')];
    await until(() => ['fm1:out-1', 'fm1:out-2', 'gear:tx6-out'].every(v => [...pickA.options].some(o => o.value === v)),
      `deck choices: both FM-1s and other MIDI gear: ${[...pickA.options].map(o => o.value)}`);

    // 2. decks: A on FM-1 A, B on FM-1 B; Perform › Clock on 'page' goes off when a deck starts
    choose($('sync-mode'), 'page');
    choose(pickA, 'fm1:out-1'); choose(pickB, 'fm1:out-2');
    await until(() => djState().decks[0].fx && djState().decks[1].fx, 'each deck read its FM-1\'s effects');

    // 2p. presets (0.9.98-dev.6): deck B's FM-1 has them, a strip of 8 (DUB current, slot 2 empty); deck A's doesn't
    //     (its firmware is older); a tap loads one (the current lit), an empty one says so and sends nothing
    { const deckEl = i => [...document.querySelectorAll('.dj-deck')][i], strip = i => deckEl(i).querySelector('.dj-presets');
      await until(() => !strip(1).hidden && strip(1).children.length === 8, 'deck B: its presets strip');
      assert(strip(0).hidden, 'deck A: no presets strip (firmware without them)');
      const btn = k => strip(1).children[k];
      assert(btn(0).classList.contains('on') && btn(1).classList.contains('empty') && /LOFI/.test(btn(2).title), `deck B's strip: ${strip(1).innerHTML}`);
      btn(2).click();
      await until(() => B.presetLoads.at(-1) === 2 && btn(2).classList.contains('on') && !btn(0).classList.contains('on'), `deck B: preset 3 loaded: ${B.presetLoads}`);
      assert(/Deck B: preset 3, LOFI/.test(document.querySelector('.dj-status').textContent), 'deck B: said so');
      btn(1).click(); await sleep(100);
      assert(B.presetLoads.length === 1 && /preset 2 is empty/.test(document.querySelector('.dj-status').textContent), 'an empty slot: nothing sent, said so');
      assert(!A.presetLoads.length, 'deck A untouched');
      assert($('preset-row').hidden, 'Perform › Master: no presets row for FM-1 A (firmware without them)'); }

    // 2b. DJ colours: the page and the DJ panel in a theme of their own (Midnight); FM-1 decks keep their FM-1's colours
    const midnight = pageColours(PRESETS[6]), deckBox = [...document.querySelectorAll('.dj-deck')][0];
    choose(document.querySelector('select[aria-label="DJ colours"]'), '6');
    assert(document.body.style.getPropertyValue('--bg') === midnight['--bg'] && $('pan-dj').style.getPropertyValue('--bg') === midnight['--bg'],
      `the page and the DJ panel in Midnight: ${document.body.style.getPropertyValue('--bg')}`);
    assert(getComputedStyle(document.body).backgroundColor !== '' && $('pan-dj').classList.contains('dj-themed'), 'the DJ panel themed');
    await until(() => deckBox.classList.contains('themed'), 'deck A in its FM-1\'s colours');
    assert(deckBox.style.getPropertyValue('--bg') !== midnight['--bg'] && getComputedStyle(deckBox).getPropertyValue('--bg').trim() === deckBox.style.getPropertyValue('--bg'),
      `deck A keeps its FM-1's colours under the DJ colours: ${deckBox.style.getPropertyValue('--bg')}`);
    A.midi.length = B.midi.length = 0;
    const play = i => [...document.querySelectorAll('.dj-deck')][i].querySelector('.dj-play').click();
    play(0);
    assert($('sync-mode').value === 'off', `Perform › Clock off: ${$('sync-mode').value}`);
    await sleep(1000);
    /* Perform › Clock's Stop first (it was running), then the deck's Start and its clocks */
    const fa = A.midi.findIndex(m => m[0] === 0xfa);
    assert(fa >= 0 && !A.midi.slice(fa).some(m => m[0] === 0xfc) && clocks(A) >= 40 && clocks(A) <= 56, `A: Start, ~48 clocks in 1 s at 120: ${A.midi.slice(0, 3)}, ${clocks(A)}`);
    assert(!B.midi.some(m => m[0] === 0xfa || m[0] === 0xf8), `B: no Start or clocks yet: ${B.midi}`);
    const gapA = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-gap').textContent;
    assert(/in sync/.test(gapA), `A started with the master: in sync: ${gapA}`);

    // 3. B at 126 starts on A's (the master's) next bar, at its own tempo; Sync: back to 120
    const deckB = djState().decks[1];
    const bpmB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-bpm-in');
    bpmB.value = '126'; bpmB.dispatchEvent(new Event('change'));
    assert(deckB.bpm === 126, 'B at 126');
    play(1);
    await until(() => B.midi.some(m => m[0] === 0xfa), 'B started', 3000);
    const at = B.midi.find(m => m[0] === 0xfa).ts, onMaster = djState().master.clock.phase(at);
    const fromBar = Math.min(onMaster % 96, 96 - (onMaster % 96));
    assert(fromBar < 0.5, `B's Start is timed on the master's bar: master at ${onMaster.toFixed(2)} clocks then`);
    await sleep(1000);
    assert(Math.abs(deckB.clock.phase() / djState().decks[0].clock.phase() - 1) > 0, 'B runs at its own tempo');
    [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-sync').click();   /* Sync */
    assert(deckB.bpm === 120, `Sync: the master's tempo: ${deckB.bpm}`);

    // 3b. Sync is a lock (Colin: flaky, and nothing on a stopped deck): lit; B pushed off the bar comes back by
    // itself; a new master tempo is followed; on a stopped deck it takes the tempo at once; typing a tempo lets go
    const deckBEl0 = () => [...document.querySelectorAll('.dj-deck')][1];
    const syncB = () => deckBEl0().querySelector('.dj-sync');
    assert(deckB.synced && syncB().classList.contains('on') && syncB().textContent === 'SYNC', 'Sync lit while on');
    const barGap = () => offset(deckB.clock.phase(), djState().master.clock.phase());
    await until(() => Math.abs(barGap()) < 0.75, `B on the master's bar: ${barGap()}`, 4000);
    deckB.clock.bend(1.6); await sleep(400); deckB.clock.bend(1);   /* pushed off, as a drift would */
    assert(Math.abs(barGap()) > 2, `B pushed off the bar: ${barGap()}`);
    await until(() => Math.abs(barGap()) < 0.75, `locked: back on the master's bar by itself: ${barGap()}`, 5000);
    const masterIn = document.querySelector('.dj-master .dj-bpm-in');
    masterIn.value = '124'; masterIn.dispatchEvent(new Event('change'));
    await until(() => deckB.bpm === 124 && deckB.clock.bpm === 124, `the master to 124: B follows: ${deckB.bpm}`, 1000);
    masterIn.value = '120'; masterIn.dispatchEvent(new Event('change'));
    await until(() => deckB.bpm === 120, 'back to 120', 1000);
    syncB().click();
    assert(!deckB.synced && !syncB().classList.contains('on'), 'Sync again: off');
    deckBEl0().querySelector('.dj-play').click();   /* B stopped */
    assert(!deckB.clock.running, 'B stopped');
    const bpmB0 = deckBEl0().querySelector('.dj-bpm-in');
    bpmB0.value = '131'; bpmB0.dispatchEvent(new Event('change'));
    syncB().click();
    assert(deckB.synced && deckB.bpm === 120 && bpmB0.value === '120', `Sync on a stopped deck: the master's tempo at once: ${deckB.bpm}`);
    bpmB0.value = '125'; bpmB0.dispatchEvent(new Event('change'));
    assert(!deckB.synced && !syncB().classList.contains('on') && deckB.bpm === 125, 'typing a tempo lets go of Sync');
    bpmB0.value = '120'; bpmB0.dispatchEvent(new Event('change'));
    deckBEl0().querySelector('.dj-play').click();   /* B playing again, on the master's bar */
    await until(() => deckB.clock.running, 'B playing again', 3000);

    // 4. a stem kill (NOI on A, now) and the DJ filter (A to low-pass): sent to A only
    const killNoi = [...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-kill')[3];
    killNoi.click();
    await until(() => A.mutes.at(-1) === 8, `NOI muted on A: ${A.mutes}`);
    assert(B.mutes.length === 0, 'B untouched');
    /* 4k. kills (Colin's test report): the pad lit at once; two quick presses both land (PU1 then PU2: 8|1|2); two
       pressed before the bar both land on it (WAV, then PU1 again: 11^4^1 = 14), blinking until then; back to NOI */
    const padsA = () => [...[...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-kill')];
    const killedA = () => padsA().map(p => p.classList.contains('killed') ? 1 : 0).join('');
    assert(killedA() === '0001', `the NOI pad lit at once: ${killedA()}`);
    const ccFrom = A.ccMutes.length, setsFrom = A.muteSets;
    padsA()[0].click(); padsA()[1].click();
    assert(killedA() === '1101', `PU1 and PU2 lit at once: ${killedA()}`);
    await until(() => A.mutes.at(-1) === 11, `two quick kills both land: ${A.mutes}`);
    /* hard mutes: each press is CC 81 for its own channel only (CC FX channels 1-4), never the whole mask */
    assert(JSON.stringify(A.ccMutes.slice(ccFrom)) === '[[0,127],[1,127]]' && A.muteSets === setsFrom,
      `CC 81 for PU1 then PU2 only, no MUTE_SET: ${JSON.stringify(A.ccMutes.slice(ccFrom))} ${A.muteSets - setsFrom}`);
    /* WAV muted on the FM-1 itself, the page not told yet: a press on PU2 changes PU2 only, WAV stays muted */
    A.mutes.push(11 | 4);
    padsA()[1].click();
    await until(() => A.mutes.at(-1) === ((11 | 4) & ~2), `PU2 back, WAV untouched on the FM-1: ${A.mutes.at(-1)}`);
    padsA()[1].click();   /* (PU2 again) */
    await until(() => A.mutes.at(-1) === 15, `PU2 muted again: ${A.mutes.at(-1)}`);
    await until(() => killedA() === '1111', `the pads follow the FM-1 (WAV muted there): ${killedA()}`, 4000);
    padsA()[2].click();   /* (WAV off again, as before this check) */
    await until(() => A.mutes.at(-1) === 11 && killedA() === '1101', `back to PU1 PU2 NOI: ${A.mutes.at(-1)} ${killedA()}`, 4000);
    const barA = [...[...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-pad')].find(p => p.textContent === 'On bar');
    if (!barA.classList.contains('on')) barA.click();
    const before4k = A.mutes.length;
    padsA()[2].click(); padsA()[0].click();
    assert(A.mutes.length === before4k && padsA()[2].classList.contains('pending') && padsA()[0].classList.contains('pending'), `on the bar: nothing sent yet, both pads blinking: ${A.mutes.slice(before4k)}`);
    await until(() => A.mutes.at(-1) === 14, `both bar kills land on the bar: ${A.mutes.slice(before4k)}`, 5000);
    assert(A.mutes.length === before4k + 2 && !padsA().some(p => p.classList.contains('pending')), `the two on the bar, no pad blinking: ${A.mutes.slice(before4k)}`);
    barA.click();   /* (On bar off again) */
    padsA()[1].click(); padsA()[2].click();
    await until(() => A.mutes.at(-1) === 8, `back to NOI only: ${A.mutes.at(-1)}`);
    /* 4m. hard mutes on a slow link (Colin: "when I click one, sometimes other channels mute as well"; the cause is
       not found yet: this checks the page's side holds): FM-1 A answers LIVE late; NOI unmuted, then PU1 pressed
       1.6 s later: only PU1 mutes; and each mute sent is in the Log, to find the cause next time */
    A.slow = {[OP.LIVE]: 1800};   /* (later than its 1.5 s timeout) */
    await sleep(500);   /* (a LIVE on its way) */
    padsA()[3].click();
    await until(() => A.mutes.at(-1) === 0, `NOI unmuted: ${A.mutes.at(-1)}`);
    await sleep(2400);
    assert(killedA() === '0000', `the pads still show nothing muted (not the stale LIVE): ${killedA()}`);
    padsA()[0].click();
    await until(() => A.mutes.at(-1) === 1, `only PU1 muted, NOI not back: ${A.mutes.at(-1)}`);
    await sleep(2600);
    assert(A.mutes.at(-1) === 1 && killedA() === '1000', `still only PU1: ${A.mutes.at(-1)} ${killedA()}`);
    const {logText: logNow4} = await import('../lsdj/conn-log.js');
    assert(/Deck A: PU1 muted \(CC 81\)\./.test(logNow4()), `the mute sent is in the Log: ${logNow4().slice(-300)}`);
    A.slow = null;
    /* the FM-1 itself mutes WAV too (its keys, a MIDI CC 81): the pads follow, and the Log says it wasn't the page */
    A.mutes.push(1 | 4);
    await until(() => killedA() === '1010', `the pads follow the FM-1: ${killedA()}`, 3000);
    assert(/Deck A: its FM-1 reports mutes PU1 WAV; this page last sent PU1\./.test(logNow4()), `logged: ${logNow4().slice(-200)}`);
    padsA()[0].click(); padsA()[2].click(); padsA()[3].click();
    await until(() => A.mutes.at(-1) === 8, `back to NOI only: ${A.mutes.at(-1)}`);
    const filt = document.querySelectorAll('.dj-mixer .dj-filter')[0];   /* deck A's FILTER, on its mixer strip */
    filt.value = '-40'; filt.dispatchEvent(new Event('input'));
    await until(() => A.fxSets.length > 0, 'the filter sent');
    const words = []; const b = A.fxSets.at(-1); for (let i = 0; i < b.length; i += 4) words.push((b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0);
    const sent = unpackFx(words);
    assert(sent.ch.every(c => c.type === 1 && c.cutoff < 60), `all four channels low-pass: ${JSON.stringify(sent.ch.map(c => [c.type, c.cutoff]))}`);
    const knob = filt.closest('.dj-knob');
    assert(filt.isConnected && parseFloat(knob.style.getPropertyValue('--deg')) < -80, `the knob turned left, not redrawn: ${knob.style.getPropertyValue('--deg')}`);
    /* the knob dragged up: towards high-pass */
    const kr = knob.getBoundingClientRect(), kx = kr.left + kr.width / 2, ky = kr.top + kr.height / 2;
    knob.dispatchEvent(new PointerEvent('pointerdown', {clientX: kx, clientY: ky, pointerId: 1, bubbles: true}));
    knob.dispatchEvent(new PointerEvent('pointermove', {clientX: kx, clientY: ky - 100, pointerId: 1, bubbles: true}));
    knob.dispatchEvent(new PointerEvent('pointerup', {clientX: kx, clientY: ky - 100, pointerId: 1, bubbles: true}));
    assert(djState().decks[0].filter > 0 && +filt.value === djState().decks[0].filter, `knob dragged up: high-pass ${djState().decks[0].filter}`);
    filt.value = '0'; filt.dispatchEvent(new Event('input'));

    // 4a. the pitch fader: the deck's tempo against the master's (+4 %: 124.8); a double-click: the master's again
    const pitchB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-pitch');
    pitchB.value = '400'; pitchB.dispatchEvent(new Event('input'));
    assert(djState().decks[1].bpm === 124.8 && !djState().decks[1].synced, `pitch +4 %: B at 124.8: ${djState().decks[1].bpm}`);
    await until(() => /\+4\.00 %/.test([...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-pitch-txt').textContent), 'the display: +4.00 %', 1000);
    pitchB.dispatchEvent(new MouseEvent('dblclick'));
    assert(djState().decks[1].bpm === 120, `double-click: the master's tempo: ${djState().decks[1].bpm}`);

    // 4a'. the jog wheel: turned clockwise, deck A runs faster while it turns, then back; anticlockwise, slower
    location.hash = '#live-sec'; await sleep(300);   /* (shown: the wheel has a size) */
    const deckA0 = djState().decks[0], jogA = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-jogwheel');
    const jr = jogA.getBoundingClientRect(), jx = jr.left + jr.width / 2, jy = jr.top + jr.height / 2, rad = jr.width * 0.4;
    const jogAt = deg => ({clientX: jx + rad * Math.cos(deg * Math.PI / 180), clientY: jy + rad * Math.sin(deg * Math.PI / 180), pointerId: 1, bubbles: true});
    jogA.dispatchEvent(new PointerEvent('pointerdown', jogAt(-90)));
    jogA.dispatchEvent(new PointerEvent('pointermove', jogAt(-60)));
    assert(deckA0.clock.factor > 1 && deckA0.nudging, `jog clockwise: faster: ${deckA0.clock.factor}`);
    await sleep(250);
    assert(deckA0.clock.factor === 1 && !deckA0.nudging, `jog stopped turning: back to its tempo: ${deckA0.clock.factor}`);
    jogA.dispatchEvent(new PointerEvent('pointermove', jogAt(-90)));
    assert(deckA0.clock.factor < 1, `jog anticlockwise: slower: ${deckA0.clock.factor}`);
    jogA.dispatchEvent(new PointerEvent('pointerup', jogAt(-90)));
    assert(deckA0.clock.factor === 1, 'let go: back to its tempo');

    // 4a'''. the jog and beat lights move every frame the screen draws (they stepped on a 50 ms tick, and skipped)
    { const turns = [];
      for (let i = 0; i < 12; i++) { await new Promise(r => requestAnimationFrame(r)); turns.push(parseFloat(jogA.style.getPropertyValue('--turn'))); }
      const moves = turns.slice(1).filter((v, i) => v !== turns[i]).length;
      assert(moves >= 9, `deck A's jog turns every frame: ${moves} of 11 frames moved (${turns.map(v => v.toFixed(1)).join(' ')})`); }

    // 4a''. stopped on the FM-1 itself: once A's FM-1 has played and then says twice running that nothing plays,
    // the page stops deck A too (the jog and beat lights with it); while it plays, nothing changes
    A.playing = 0x0f;
    await sleep(1300);
    assert(deckA0.clock.running && deckA0.seenPlaying, `A playing on its FM-1: the deck runs on: ${deckA0.clock.running}`);
    A.playing = 0;   /* (stopped with its own buttons) */
    await until(() => !deckA0.clock.running, 'stopped on the FM-1: deck A stops', 3000);
    assert(/stopped on the FM-1/.test(document.querySelector('.dj-status').textContent), `said: ${document.querySelector('.dj-status').textContent}`);
    assert(djState().decks[1].clock.running, 'B plays on, untouched');
    play(0);   /* A again, for the rest */
    await until(() => deckA0.clock.running, 'A playing again', 3000);
    await sleep(1300);
    assert(deckA0.clock.running, 'a deck the FM-1 has not played on yet is not stopped (LSDj takes a moment to start)');

    // 4b. 0.9.98 on B: no mixer, so the crossfader sets B's volume (VOLUME_SET); Hold (SEQ_SET)
    const want = x => Math.round(crossfade(x, djState().mixer.curve)[1] * 127);
    await until(() => B.level === want(0.5), `B's volume from the crossfader in the middle: ${B.levels}, want ${want(0.5)}`);
    const xf0 = document.querySelector('.dj-xfader');
    xf0.value = '0'; xf0.dispatchEvent(new Event('input'));
    await until(() => B.level === want(0), `crossfader to A: B's volume ${want(0)}: ${B.levels}`);
    xf0.value = '500'; xf0.dispatchEvent(new Event('input'));
    await until(() => B.level === want(0.5), `back to the middle: ${B.levels}`);
    assert(B.levels.length < 12, `one request at a time, the latest value: ${B.levels}`);
    /* 4b'. a busy link (Colin's test: the FM-1 in use got 3 volumes in a 2 s fade, the last 4 s late): B answers its
       polls slowly, and a 1 s sweep still reaches it smoothly and on time (sent past the queue, at most every 30 ms) */
    B.slow = {[OP.LIVE]: 500, [OP.SETTINGS_GET]: 500, [OP.THEME_GET]: 500, [OP.READ]: 300};
    const sweepFrom = B.levels.length, t0 = performance.now();
    for (let k = 0; k <= 20; k++) { xf0.value = String(500 - k * 25); xf0.dispatchEvent(new Event('input')); await sleep(50); }
    const during = B.levels.length - sweepFrom;
    await until(() => B.level === want(0), `the sweep's last value: ${B.level}, want ${want(0)}`, 1500);
    const late = performance.now() - t0;
    assert(during >= 10 && late < 2000, `smooth and on time on a busy link: ${during} volumes during the 1 s sweep, settled after ${Math.round(late)} ms`);
    B.slow = null;
    xf0.value = '500'; xf0.dispatchEvent(new Event('input'));
    await until(() => B.level === want(0.5), `back to the middle again: ${B.levels.slice(-3)}`);
    const deckBEl = [...document.querySelectorAll('.dj-deck')][1];
    const hold = [...deckBEl.querySelectorAll('button')].find(b => b.textContent === 'Loop');
    assert(hold && !hold.disabled, 'B: Loop (live mode) on 0.9.98');
    assert([...document.querySelectorAll('.dj-deck')][0].querySelector('button[title="Needs 0.9.98 on the FM-1"]')?.disabled, 'A (0.9.97): Loop off, with a note');
    hold.click();
    await until(() => B.seqs.at(-1) === 1, `Loop: SEQ_SET live: ${B.seqs}`);
    await until(() => [...deckBEl.querySelectorAll('button')].some(b => b.textContent === 'Loop' && b.classList.contains('on')), 'Loop lit while looping', 3000);
    // 4b'. the echo throw on a fresh FM-1 echo (time and feedback 0: not heard as an echo): while held a tempo echo
    //      (synced 1/8., feedback 76) with the sends up; let go, all of it as it was
    {
      const echoA = [...[...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-pad')].find(p => p.textContent === 'Echo');
      const fxOfBytes = b => { const w = []; for (let i = 0; i + 3 < b.length; i += 4) w.push((b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0); return unpackFx(w); };
      const before = A.fxSets.length, was = fxOfBytes(A.fxBytes);
      assert(!was.echo.time && !was.echo.feedback, `A's echo at its start: ${JSON.stringify(was.echo)}`);
      echoA.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 1, bubbles: true}));
      await until(() => A.fxSets.length > before, 'Echo held: sent', 3000);
      const held = fxOfBytes(A.fxSets.at(-1));
      assert(held.ch.every(c => c.send === 127) && held.echo.sync === 1 && held.echo.time === 80 && held.echo.feedback === 76 && held.echo.mix > 0,
        `held: sends up and a tempo echo: ${JSON.stringify(held.echo)} sends ${held.ch.map(c => c.send)}`);
      const n = A.fxSets.length;
      echoA.dispatchEvent(new PointerEvent('pointerup', {pointerId: 1, bubbles: true}));
      await until(() => A.fxSets.length > n, 'Echo let go: sent', 3000);
      const back = fxOfBytes(A.fxSets.at(-1));
      assert(JSON.stringify(back.echo) === JSON.stringify(was.echo) && back.ch.every((c, i) => c.send === was.ch[i].send),
        `let go: the echo as it was: ${JSON.stringify(back.echo)} vs ${JSON.stringify(was.echo)}`);
    }
    // 4b''. the song's key on the deck (song-key.js): FM-1 A's working song becomes a C major tune (phrase 00 on
    //       chain 00 on song row 00, pulse); after songs are sent the deck reads it again and shows C · 8B
    {
      const N = pc => 13 + pc, tune = [N(0), 0, N(4), 0, N(7), 0, N(12), 0, N(5), 0, N(9), 0, N(7), N(11), N(14), N(0)];
      A.save.fill(0, 0, 0x8000); A.save.fill(0xff, 0x1290, 0x1690); A.save.fill(0xff, 0x2080, 0x2880); A.save.fill(0, 0x2880, 0x3080); A.save.fill(0xff, 0x7000, 0x7ff0);
      tune.forEach((n, k) => { A.save[k] = n; }); A.save[0x7000] = 0; A.save[0x2080] = 0; A.save[0x1290] = 0; A.save[0x3080] = 0;
      const keyA = () => [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-key');
      const reads = A.reads;
      readSongAgain(djState().decks[0].key);   /* (as after Songs › Send) */
      await until(() => /^C · 8B/.test(keyA()?.textContent ?? ''), `deck A: the key C · 8B: "${keyA()?.textContent}"`, 40000);
      assert(A.reads - reads >= 100 && !keyA().hidden && /C major/.test(keyA().title), `read in parts (${A.reads - reads} READs), its title says C major`);
    }
    assert(!document.querySelector('.dj-map, .dj-maprow') && !B.mapReads.length, 'Screen first: no row map, SONG_ROWS not read');

    // 4c. each deck: its own FM-1's screen, asked on that FM-1's link (these fakes have none: the deck says so),
    // and its own FM-1's theme colours
    await until(() => A.screens > 0 && B.screens > 0, `each deck asks its own FM-1 for its screen: A ${A.screens}, B ${B.screens}`, 4000);
    const decksEl = [...document.querySelectorAll('.dj-deck')];
    await until(() => decksEl.every(e => /did not send its screen/.test(e.textContent)), 'no screen on these fakes: each deck says so', 4000);
    const accent = d => pageColours(PRESETS[unpackSettings(d.settings).theme])['--accent'];
    await until(() => decksEl.every(e => e.classList.contains('themed')), 'both decks themed', 4000);
    assert(decksEl[0].style.getPropertyValue('--accent') === accent(A) && decksEl[1].style.getPropertyValue('--accent') === accent(B) && accent(A) !== accent(B),
      `each deck in its FM-1's colours: ${decksEl.map(e => e.style.getPropertyValue('--accent'))} want ${accent(A)} ${accent(B)}`);

    // 4c2. the deck labels: the FM-1's songs from its save's header (READs: LSDj keeps playing); a .sav sent from this
    // page names the deck, "(changed since)" once the FM-1's save no longer matches; INFO (a sum over the whole save
    // on the FM-1) is not asked while the header stays the same. The label is the deck picker's tooltip (two lines).
    const labelOf = e => { const [file = '', song = ''] = e.querySelector('.dj-deck-head select').title.split('\n'); return [file, song]; };
    await until(() => decksEl.every(e => labelOf(e)[1] === 'Song TECHNO .02 · 1 song · 95 % free'), `labels: ${decksEl.map(e => labelOf(e).join(' / '))}`, 7000);
    assert(labelOf(decksEl[0])[0] === 'Its own songs', `nothing sent to A from here: ${labelOf(decksEl[0])}`);
    const readsSent = B.reads, infosSent = B.infos;
    rememberSav('out-2', 'techno-set.sav', crc32(B.save));
    await until(() => B.reads >= readsSent + 4 && B.infos > infosSent, 'read again after the send, INFO once', 7000); await sleep(200);
    await until(() => labelOf(decksEl[1])[0] === 'techno-set.sav', `B named after the .sav sent to it: ${labelOf(decksEl[1])}`, 7000);
    const infos0 = B.infos, reads0 = B.reads;
    await sleep(5600);
    assert(B.infos === infos0 && B.reads > reads0, `the header read again (${B.reads - reads0} READs), INFO not asked (${B.infos - infos0})`);
    B.save = fakeSave([{slot: 0, name: 'TECHNO', version: 3, blocks: 10}, {slot: 1, name: 'HOUSE', version: 0, blocks: 6}], 1);
    await until(() => labelOf(decksEl[1]).join(' / ') === 'techno-set.sav (changed since) / Song HOUSE .00 · 2 songs · 92 % free',
      `B's save changed: ${labelOf(decksEl[1])}`, 7000);

    // 4d. Screen | Rows: A (0.9.97) has no Rows; B shows its song row map, a click cues that row; back to Screen
    const viewBtn = (e, t) => [...e.querySelectorAll('.dj-view button')].find(b => b.textContent === t);
    assert(viewBtn(decksEl[0], 'Rows')?.disabled && viewBtn(decksEl[0], 'Screen')?.classList.contains('on'), 'A (0.9.97): Rows off, Screen on');
    /* the view box and the deck keep their size whichever view shows (Perform shown, to measure) */
    location.hash = '#live-sec'; await sleep(300);
    const boxSize = e => { const r = e.querySelector('.dj-view-box').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(e.getBoundingClientRect().height)].join(); };
    const sizeScreen = boxSize(decksEl[1]);
    viewBtn(decksEl[1], 'Rows').click();
    await until(() => decksEl[1].querySelectorAll('.dj-maprow').length === 64, 'B: Rows shows 64 song rows (4 blocks, one a poll)', 6000);
    assert(B.mapReads.join().startsWith('0,16,32,48'), `one 16-row block a request, in order: ${B.mapReads}`);
    assert(boxSize(decksEl[1]) === sizeScreen, `the same size on Rows as on Screen (box w,h, deck h): ${boxSize(decksEl[1])} vs ${sizeScreen}`);
    const map = decksEl[1].querySelector('.dj-map');
    /* columns of 16 rows (row 10 level with row 00, to its right); four fit here, or the rest sideways */
    assert(rowsShown0Top(map) && (map.scrollWidth > map.clientWidth || map.querySelectorAll('.dj-maprow')[48].getBoundingClientRect().right <= map.getBoundingClientRect().right + 1), `columns of 16 rows: ${map.scrollWidth} / ${map.clientWidth}`);
    assert(viewBtn(decksEl[1], 'Rows').classList.contains('on') && !decksEl[1].querySelector('.dj-screen'), 'B: Rows on, no screen');
    const rowsShown = [...decksEl[1].querySelectorAll('.dj-maprow')];
    assert(/^00 00 -- -- --/.test(rowsShown[0].textContent.replace(/(..)(?=.)/g, '$1 ')), `row 00: chain 00 in PU1: ${rowsShown[0].textContent}`);
    B.midi.length = 0;
    rowsShown[2].click();
    assert(B.midi.some(m => m[0] === 0xc0 && m[1] === 2), `a click on row 02 cues it (program change 2): ${B.midi}`);
    viewBtn(decksEl[1], 'Screen').click();
    const reads = B.mapReads.length, shots = B.screens;
    await sleep(1200);
    assert(!decksEl[1].querySelector('.dj-maprow') && B.mapReads.length === reads && B.screens > shots, `back to Screen: no rows read (${B.mapReads.length - reads}), the screen asked again (${B.screens - shots})`);
    B.midi.length = 0;

    // 4e. Tap pressed quickly: the tempo follows, and the layout is not redrawn (each tap redrew both decks, their
    // rows and the mixer, and froze Colin's page); then Whole BPM: every tempo snaps to a whole number
    const tapBtn = () => [...document.querySelectorAll('.dj-master button')].find(b => b.textContent === 'TAP');
    const kept = [tapBtn(), ...document.querySelectorAll('.dj-deck-body > *')];
    for (let i = 0; i < 16; i++) { tapBtn().click(); await sleep(i % 2 ? 230 : 270); }
    const tapped = djState().master.bpm, big = () => document.querySelector('.dj-master .dj-bpm.big').textContent;
    assert(tapped > 225 && tapped < 255, `16 taps 250 ms apart: about 240 BPM: ${tapped}`);
    assert(kept.every(e => e.isConnected), 'taps: nothing redrawn but the numbers');
    await until(() => big() === tapped.toFixed(1), `the master readout follows: ${big()} vs ${tapped}`, 1000);
    const wholeBox = [...document.querySelectorAll('.dj-master label')].find(l => /Whole BPM/.test(l.textContent)).querySelector('input');
    wholeBox.click();
    assert(djState().master.whole && Number.isInteger(djState().master.bpm) && djState().decks.every(d => Number.isInteger(d.bpm)), `Whole BPM: master and decks whole: ${djState().master.bpm}, ${djState().decks.map(d => d.bpm)}`);
    await until(() => !big().includes('.'), `the readout without a point: ${big()}`, 1000);
    const bpmInB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-bpm-in');
    assert(bpmInB.step === '1', `deck tempo box in steps of 1: ${bpmInB.step}`);
    bpmInB.value = '127.6'; bpmInB.dispatchEvent(new Event('change'));
    assert(djState().decks[1].bpm === 128 && bpmInB.value === '128', `typed 127.6: 128: ${djState().decks[1].bpm} (${bpmInB.value})`);
    for (let i = 0; i < 4; i++) { tapBtn().click(); await sleep(310); }
    assert(Number.isInteger(djState().master.bpm), `Whole BPM: a tapped tempo is whole: ${djState().master.bpm}`);
    [...document.querySelectorAll('.dj-master label')].find(l => /Whole BPM/.test(l.textContent)).querySelector('input').click();
    assert(!djState().master.whole, 'Whole BPM off again');
    for (const i of document.querySelectorAll('.dj-bpm-in')) { i.value = '120'; i.dispatchEvent(new Event('change')); }   /* back to 120 for the rest */

    // 4f. the tempo controls (lsdj/dj-tempo.js): − / + (held: repeating), nudge buttons, ×½ / ×2, MASTER, the
    // fader's range, the tempo pads, a glide, Next bar
    { const deckEl = i => [...document.querySelectorAll('.dj-deck')][i];
      const by = (root, label) => root.querySelector(`button[aria-label="${label}"]`);
      const press = b => b.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
      const lift = b => b.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter'}));
      const mx = document.querySelector('.dj-master'), M = djState().master, dB = djState().decks[1];
      assert(M.bpm === 120 && dB.bpm === 120, `start at 120: ${M.bpm}, ${dB.bpm}`);
      const up = by(mx, 'Master tempo up');
      press(up); lift(up);
      assert(M.bpm === 120.1, `master +: 120.1: ${M.bpm}`);
      press(by(mx, 'Master tempo down')); lift(by(mx, 'Master tempo down'));
      assert(M.bpm === 120, `master −: 120: ${M.bpm}`);
      press(up); await sleep(1000); lift(up);
      const held = M.bpm;
      assert(held >= 120.5, `master + held a second: repeating, ${held}`);
      await sleep(300);
      assert(M.bpm === held, `let go: no more steps (${held} → ${M.bpm})`);
      mx.querySelector('.dj-bpm-in').value = '120'; mx.querySelector('.dj-bpm-in').dispatchEvent(new Event('change'));
      const bUp = by(deckEl(1), 'Deck B tempo up');
      press(bUp); lift(bUp);
      assert(dB.bpm === 120.1 && !dB.synced, `deck B +: 120.1, not synced: ${dB.bpm}`);
      if (dB.clock?.running) {
        const nf = by(deckEl(1), 'Deck B nudge faster');
        assert(!nf.disabled, 'a playing deck: nudge on');
        press(nf); assert(dB.clock.factor > 1 && dB.nudging, `nudge ▶ held: faster: ${dB.clock.factor}`);
        lift(nf); assert(dB.clock.factor === 1 && !dB.nudging, `let go: back: ${dB.clock.factor}`);
      }
      by(deckEl(1), 'Deck B double time').click();
      assert(dB.bpm === 240.2, `deck B ×2: 240.2: ${dB.bpm}`);
      by(deckEl(1), 'Deck B double time').click();
      assert(dB.bpm === 240.2, `×2 again would be 480: unchanged: ${dB.bpm}`);
      by(deckEl(1), 'Deck B half time').click();
      assert(dB.bpm === 120.1, `×½: 120.1: ${dB.bpm}`);
      deckEl(1).querySelector('.dj-match').click();
      assert(dB.bpm === M.bpm && !dB.synced, `MASTER: the master's tempo: ${dB.bpm}`);
      const range = deckEl(1).querySelector('.dj-range'), pitch = deckEl(1).querySelector('.dj-pitch');
      assert(range.textContent === '±8 %' && pitch.max === '800', `the fader ±8 %: ${range.textContent} ${pitch.max}`);
      range.click();
      assert(range.textContent === '±16 %' && pitch.max === '1600' && pitch.min === '-1600', `±16 %: ${pitch.min}..${pitch.max}`);
      range.click();
      pitch.value = '5000'; pitch.dispatchEvent(new Event('input'));
      assert(dB.bpm === 180, `±50 %, fader at the top: 180: ${dB.bpm}`);
      range.click();
      assert(range.textContent === '±8 %' && localStorage.getItem('dj-range-1') === '800', 'round to ±8 % again, kept');
      deckEl(1).querySelector('.dj-match').click();
      /* pads: an empty one tapped keeps the tempo now; a full one tapped goes there; right-click keeps a new one */
      const pad = n => mx.querySelectorAll('.dj-tpad')[n];
      assert(mx.querySelectorAll('.dj-tpad').length === 4 && pad(0).classList.contains('empty'), 'four empty pads');
      pad(0).click();
      assert(M.pads[0] === 120 && pad(0).textContent === '120.0', `pad 1 kept 120: ${M.pads[0]} (${pad(0).textContent})`);
      mx.querySelector('.dj-bpm-in').value = '128'; mx.querySelector('.dj-bpm-in').dispatchEvent(new Event('change'));
      pad(1).dispatchEvent(new MouseEvent('contextmenu', {cancelable: true}));
      assert(M.pads[1] === 128, `right-click: pad 2 kept 128: ${M.pads[1]}`);
      pad(0).click();
      assert(M.bpm === 120, `pad 1 tapped: 120: ${M.bpm}`);
      assert(JSON.parse(localStorage.getItem('dj-pads'))[1] === 128, 'pads kept in this browser');
      /* a glide: 120 → 126 over a bar (2 s at 120): in between on the way, there at the end, and a hand change stops one */
      const glideTo = mx.querySelector('input[aria-label="Glide to (BPM)"]'), gBtn = () => mx.querySelector('.dj-glide button');
      choose(mx.querySelector('select[aria-label="Glide length"]'), '1');
      glideTo.value = '126'; gBtn().click();
      assert(M.glide && gBtn().textContent === 'STOP', 'gliding: STOP');
      await sleep(900);
      assert(M.bpm > 120.5 && M.bpm < 125.5, `half way or so: ${M.bpm}`);
      await until(() => !M.glide, 'the glide ends', 4000);
      assert(M.bpm === 126 && gBtn().textContent === 'GLIDE' && localStorage.getItem('dj-bpm') === '126', `there: 126, kept: ${M.bpm}`);
      glideTo.value = '120'; gBtn().click(); await sleep(200);
      press(up); lift(up);
      assert(!M.glide && gBtn().textContent === 'GLIDE', '+ by hand: the glide stops');
      mx.querySelector('.dj-bpm-in').value = '120'; mx.querySelector('.dj-bpm-in').dispatchEvent(new Event('change'));
      /* Next bar: with the master playing, ×2 waits for its next bar */
      const nextBar = [...mx.querySelectorAll('label')].find(l => /Next bar/.test(l.textContent)).querySelector('input');
      nextBar.click();
      assert(M.onBar, 'Next bar on');
      if (M.clock?.running) {
        by(mx, 'Master double time').click();
        assert((M.bpm === 120 && M.pending) || M.bpm === 240, `×2 waits for the bar (or the bar was there): ${M.bpm}`);
        await until(() => M.bpm === 240, 'on the bar: 240', 2600);
        by(mx, 'Master half time').click();
        await until(() => M.bpm === 120, 'on the bar: 120 again', 2600);
      }
      nextBar.click();
      /* SYNC TO LSDJ: the master takes deck B's LSDj tempo (as its FM-1 says), shown on the button */
      B.lsdjBpm = 137;
      const fromB = by(mx, 'Master to deck B\'s LSDj tempo');
      await until(() => fromB.lastChild.textContent === '137' && !fromB.disabled, `B's LSDj tempo shown: ${fromB.textContent}`, 3000);
      fromB.click();
      assert(M.bpm === 137, `the master: deck B's LSDj tempo, 137: ${M.bpm}`);
      delete B.lsdjBpm;
      await until(() => fromB.lastChild.textContent === '120', 'back to 120 on the FM-1', 3000);
      for (const k of ['dj-pads', 'dj-tempo-bar', 'dj-pad-glide', 'dj-glide-bars', 'dj-range-0', 'dj-range-1']) try { localStorage.removeItem(k); } catch {}
      M.pads.fill(null); M.glideBars = 8;
      for (const i of document.querySelectorAll('.dj-bpm-in')) { i.value = '120'; i.dispatchEvent(new Event('change')); } }

    // 5. the TX-6: its track 1 button stops deck A; the crossfader sets its channel 1 and 2 volumes
    const mixerSel = document.querySelector('.dj-mixer select[aria-label="Mixer"]');
    choose(mixerSel, 'tx6');
    choose(document.querySelector('.dj-mixer select[aria-label="Mixer MIDI in"]'), 'tx6-in');
    choose(document.querySelector('.dj-mixer select[aria-label="Mixer MIDI out"]'), 'tx6-out');
    T.play([0xb0, 25, 127]); T.play([0xb0, 25, 0]);
    assert(!djState().decks[0].clock.running && A.midi.some(m => m[0] === 0xfc), 'track 1 button: deck A stopped');
    const xf = document.querySelector('.dj-xfader');
    xf.value = '1000'; xf.dispatchEvent(new Event('input'));
    const vol = ch => T.sent.filter(m => m[0] === (0xb0 | (ch - 1)) && m[1] === 7).at(-1)?.[2];
    assert(vol(1) === 0 && vol(2) === 127, `crossfader to B: ch 1 ${vol(1)}, ch 2 ${vol(2)}`);
    T.play([0xb0, 1, 64]);
    assert(Math.abs(djState().mixer.faders[1] - 64 / 127) < 1e-9, 'fader 1 mirrored');
    /* a fader moved fast (200 messages): the meter follows, the mixer panel is not rebuilt */
    const head = document.querySelector('.dj-mixer > h4');
    xf.value = '500'; xf.dispatchEvent(new Event('input'));   /* (the crossfader in the middle: A's meter is its fader times its share) */
    for (let i = 0; i < 200; i++) T.play([0xb0, 1, i & 127]);
    const meterA = document.querySelector('.dj-meter span');
    assert(head.isConnected && xf.isConnected, 'mixer messages: the panel not rebuilt');
    const shareA = crossfade(0.5, djState().mixer.curve)[0];
    assert(Math.abs(parseFloat(meterA.style.getPropertyValue('--v')) - (199 & 127) / 127 * shareA) < 0.01, `the meter follows the fader times the crossfader: ${meterA.style.getPropertyValue('--v')}`);
    xf.value = '1000'; xf.dispatchEvent(new Event('input'));
    assert(parseFloat(meterA.style.getPropertyValue('--v')) < 0.01, `crossfader to B: A's meter down: ${meterA.style.getPropertyValue('--v')}`);
    T.play([0xb0, 1, 64]);
    await until(() => B.level === 127, `with a mixer, B's own volume full again: ${B.levels}`);

    // 6. back to Effects: the effects panels again; the FM-1s at full volume
    xf.value = '250'; xf.dispatchEvent(new Event('input'));
    choose(mixerSel, 'none');
    await until(() => B.level === want(0.25) && want(0.25) < 127, `no mixer again: B's volume from the crossfader: ${B.levels}`);
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    assert(!document.body.classList.contains('dj') && getComputedStyle($('pan-chans')).display !== 'none', 'Effects layout back');
    assert(!document.body.style.getPropertyValue('--bg'), 'the Effects layout: the page\'s own colours again');
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    assert(document.body.style.getPropertyValue('--bg') === pageColours(PRESETS[6])['--bg'], 'DJ again: its colours again');
    choose(document.querySelector('select[aria-label="DJ colours"]'), 'page');
    assert(!document.body.style.getPropertyValue('--bg') && !$('pan-dj').classList.contains('dj-themed'), 'Page colours: the DJ colours gone');
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    await until(() => B.level === 127, `the Effects layout: B at full volume: ${B.levels}`);

    // 7. an ArduinoBoy deck: listed for each MIDI output; normal speed at the start; the speed notes on channel 16;
    //    the clock, Start and Stop; the FM-1-only controls hidden; no row cue
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    await until(() => [...pickA.options].some(o => o.value === 'ab:ab-out'), `the ArduinoBoy choice: ${[...pickA.options].map(o => o.value)}`);
    choose(pickA, 'ab:ab-out');
    const deckA = [...document.querySelectorAll('.dj-deck')][0], dA = djState().decks[0];
    assert(dA.kind === 'ab' && AB.sent.length === 2 && AB.sent[0].join() === '159,50,100' && AB.sent[1].join() === '143,50,0',
      `ArduinoBoy: normal speed sent on ch 16: ${JSON.stringify(AB.sent)}`);
    const speeds = () => [...deckA.querySelectorAll('[aria-label="Deck A: LSDj speed"] button')];
    assert(speeds().length === 4 && speeds()[0].classList.contains('on'), 'four speeds, Normal lit');
    speeds()[1].click();
    assert(AB.sent.at(-2).join() === '159,51,100' && dA.abSpeed === 1 && speeds()[1].classList.contains('on'), `half speed: note 51, lit: ${AB.sent.at(-2)}`);
    choose(deckA.querySelector('select[aria-label="ArduinoBoy MIDI channel"]'), '3');
    assert(AB.sent.at(-2).join() === '146,51,100', `channel 3: the speed sent again there: ${AB.sent.at(-2)}`);
    assert(!deckA.querySelector('.dj-kill') && !deckA.querySelector('.dj-view-box') && !deckA.querySelector('.dj-deck-head select').title && !/Cue row/.test(deckA.textContent),
      'no kills, screen, rows, label or Cue row on an ArduinoBoy deck');
    assert(dA.filterBy === 'mixer' && dA.throwBy === 'mixer', 'its filter and throws by the mixer');
    AB.sent.length = 0;
    play(0);
    /* (it starts on the master's next bar) */
    await until(() => AB.sent[0]?.[0] === 0xfa && AB.sent.filter(m => m[0] === 0xf8).length >= 20, `Play: Start and clocks to the ArduinoBoy: ${AB.sent.slice(0, 2)}, ${AB.sent.length}`, 4000);
    play(0);
    assert(AB.sent.at(-1)[0] === 0xfc, `Stop: ${AB.sent.at(-1)}`);
    choose(pickA, '');
    try { localStorage.removeItem('dj-ab-ch'); } catch {}

    // 8. the crate: a .sav loads onto deck A's FM-1 while deck B plays on (its clocks keep coming, nothing else goes
    //    to it). Never the browser's confirm() (it stops the page, and B's clock: Colin's test): Load asks on the card,
    //    held it loads at once. ON A on the card and the deck's cartridge chip; Songs: straight into a chosen song;
    //    search; ✕ asks on the card; Grab B copies B's songs while it plays
    try { for (const k of ['dj-crate', 'dj-crate-on', 'dj-crate-view', 'dj-crate-sort', 'dj-crate-open']) localStorage.removeItem(k); } catch {}
    choose(pickA, 'fm1:out-1');
    await until(() => djState().decks[0].fx, 'deck A on FM-1 A again');
    const dB = djState().decks[1];
    if (!dB.clock?.running) play(1);
    await until(() => clocks(B) > 0, 'deck B playing');
    const song = n => new Uint8Array(SONG_SIZE).map((_, k) => (k * n + n) & 0x7f);
    const friday = buildSav(fakeSave([], 0), song(9), [{slot: 0, name: 'HOUSE', song: song(3)}, {slot: 1, name: 'ACID', song: song(5)}], 0);
    await addToCrate({name: 'Friday', sav: friday});
    const crate = document.querySelector('.dj-crate');
    const cart = name => [...crate.querySelectorAll('.crate-cart')].find(c => c.querySelector('.crate-name').value === name);
    const card = () => cart('Friday');
    await until(() => card() && /HOUSE/.test(card().textContent) && /2 songs/.test(card().textContent), `the card: its songs: ${crate.textContent}`);
    const cardBtn = (text, c = card()) => [...c.querySelectorAll('button')].find(b => b.textContent === text);
    assert(cardBtn('Load A') && cardBtn('Load B'), 'Load A and Load B on the card');
    /* its label: the dot opens the editor; a swatch, any colour (light: dark text), a picture (kept in this browser), No picture */
    card().querySelector('.crate-colour').click();
    await until(() => card().querySelector('.cart-label-edit'), 'the label editor');
    card().querySelector('.cart-swatch[data-color=purple]').click();
    await until(() => card().dataset.color === 'purple', 'purple');
    { const cc = card().querySelector('.cart-custom'); cc.value = '#ffee00'; cc.dispatchEvent(new Event('change')); }
    await until(() => card().style.getPropertyValue('--lab') === '#ffee00' && card().style.getPropertyValue('--lab-ink') === '#2a2925', 'any colour; a light one gets dark text');
    { const cv = Object.assign(document.createElement('canvas'), {width: 64, height: 64}); cv.getContext('2d').fillRect(0, 0, 64, 64);
      const pt = new DataTransfer(); pt.items.add(new File([await new Promise(r => cv.toBlob(r, 'image/png'))], 'art.png', {type: 'image/png'}));
      const fi = card().querySelector('.cart-label-edit input[type=file]'); fi.files = pt.files; fi.dispatchEvent(new Event('change')); }
    await until(() => card().querySelector('.crate-art'), 'the picture on the label');
    { const kept = JSON.parse(localStorage.getItem('dj-crate')).find(i => i.name === 'Friday');
      assert(kept.color === '#ffee00' && /^[0-9a-f]{64}$/.test(kept.img), `kept: ${JSON.stringify(kept)}`); }
    [...card().querySelectorAll('.cart-pic-acts button')].find(b => b.textContent === 'No picture').click();
    await until(() => !card().querySelector('.crate-art'), 'No picture');
    card().querySelector('.crate-colour').click();
    await until(() => !card().querySelector('.cart-label-edit'), 'the editor closed');
    const realConfirm = window.confirm, bSend = B.output.send;
    let confirmed = 0;
    window.confirm = () => { confirmed++; return true; };
    try {
      const bOps = [];
      B.output.send = (m, ts) => { if (m[0] === 0xf0) bOps.push(m[4]); return bSend(m, ts); };
      const ticksBefore = clocks(B);
      /* a click asks on the card; Cancel: nothing sent */
      cardBtn('Load A').click();
      const ask = () => card().querySelector('.crate-ask');
      assert(ask() && /Replace deck A's songs/.test(ask().textContent), `asked on the card: ${card().textContent}`);
      const beginsA = A.begins;
      [...ask().querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      await sleep(300);
      assert(!ask() && A.begins === beginsA, 'Cancel: nothing sent');
      cardBtn('Load A').click();
      [...ask().querySelectorAll('button')].find(b => b.textContent === 'Load A').click();
      await until(() => crc32(A.save) === crc32(friday), 'FM-1 A has the crate\'s songs', 20000);
      await until(() => /Deck A has "Friday"/.test(crate.textContent), `the crate says so: ${crate.querySelector('.crate-status').textContent}`);
      await until(() => clocks(B) > ticksBefore + 20 && dB.clock.running, `deck B kept playing: ${ticksBefore} -> ${clocks(B)}`, 3000);
      assert(!bOps.some(op => [OP.BEGIN, OP.CHUNK, OP.COMMIT, OP.ABORT].includes(op)), `nothing of the load went to B: ${[...new Set(bOps)]}`);
      const bTs = B.midi.filter(m => m[0] === 0xf8).map(m => m.ts).filter(Number.isFinite);
      const gap = Math.max(...bTs.slice(1).map((t, i) => t - bTs[i]));
      assert(gap < 40, `deck B's clocks evenly spaced during the load (one each 20.8 ms at 120): the widest gap ${gap.toFixed(1)} ms`);
      /* ON A: on the card, and the deck's cartridge chip */
      const chipA = () => [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-cart-chip');
      await until(() => /ON A/.test(card().textContent) && !chipA().hidden && chipA().textContent === 'Friday', `ON A and the chip: ${card().textContent} / ${chipA().textContent}`, 8000);
      /* held: loads at once, no question (Load A again: the same songs) */
      const heldFrom = A.begins, holdBtn = cardBtn('Load A');
      holdBtn.dispatchEvent(new PointerEvent('pointerdown', {button: 0, bubbles: true}));
      await sleep(1100);
      holdBtn.dispatchEvent(new PointerEvent('pointerup', {button: 0, bubbles: true}));
      await until(() => A.begins > heldFrom, 'held: it loads, unasked', 5000);
      assert(!ask(), 'held: no question');
      await until(() => /Deck A has "Friday"/.test(crate.querySelector('.crate-status').textContent) && !document.querySelector('.dj-deck.loading'), 'held: loaded', 20000);
      /* an FM-1 whose LSDj changes the songs once it starts on them: the crate says it doesn't hold them, and why to look */
      A.afterCommit = s => s.fill(0x11, 0, 64);
      cardBtn('Load A').click(); [...card().querySelectorAll('.crate-ask button')].find(b => b.textContent === 'Load A').click();
      await until(() => /doesn't hold the songs sent/.test(crate.querySelector('.crate-status').textContent) && !document.querySelector('.dj-deck.loading'), `not held: said: ${crate.querySelector('.crate-status').textContent}`, 20000);
      assert(/LSDj-AAA, firmware FM-1_99\d/.test(crate.querySelector('.crate-status').textContent), 'names its LSDj and firmware');
      A.afterCommit = null;
      /* Songs: every song; A on ACID asks on the row, then FM-1 A opens on ACID (in its working area, slot 1) */
      [...crate.querySelectorAll('[data-crate-view]')].find(b => b.dataset.crateView === 'songs').click();
      const row = name => [...crate.querySelectorAll('.crate-songview .crate-song')].find(r => r.querySelector('.crate-song-name').textContent === name);
      await until(() => row('HOUSE') && row('ACID'), `Songs: both: ${crate.textContent}`);
      [...row('ACID').querySelectorAll('.crate-song-acts button')].find(b => b.textContent === 'A').click();
      assert(row('ACID').querySelector('.crate-ask') && /opens on ACID/.test(row('ACID').textContent), `asked on the row: ${row('ACID').textContent}`);
      [...row('ACID').querySelectorAll('.crate-ask button')].find(b => b.textContent === 'Load A').click();
      await until(() => A.save[0x8140] === 1 && A.save.subarray(0, 64).every((b, k) => b === song(5)[k]), 'FM-1 A opens on ACID', 20000);
      await until(() => /Deck A has "Friday › ACID"/.test(crate.querySelector('.crate-status').textContent), 'said');
      await until(() => /ON A/.test(row('ACID').textContent) && !/ON A/.test(row('HOUSE').textContent), `ON A on ACID only: ${row('ACID').textContent} | ${row('HOUSE').textContent}`, 8000);
      /* search, in Songs: by song */
      const search = crate.querySelector('.crate-search');
      search.value = 'aci'; search.dispatchEvent(new Event('input'));
      assert(row('ACID') && !row('HOUSE'), 'search: ACID only');
      search.value = ''; search.dispatchEvent(new Event('input'));
      [...crate.querySelectorAll('[data-crate-view]')].find(b => b.dataset.crateView === 'cards').click();
      /* Grab B: a copy of B's songs as a new card; B keeps its songs and keeps playing */
      const bBegins = B.begins;
      [...crate.querySelectorAll('.crate-top button')].find(b => b.textContent === 'Grab B').click();
      await until(() => [...crate.querySelectorAll('.crate-cart')].some(c => /TECHNO/.test(c.textContent)), `Grab B: B's songs in the crate: ${crate.textContent}`, 20000);
      assert(B.begins === bBegins && dB.clock.running, 'B: nothing written, still playing');
      /* ✕ asks on the card, Remove takes it out */
      cardBtn('✕').click();
      assert(/Take "Friday" out of the crate/.test(ask()?.textContent || ''), 'remove: asked on the card');
      [...ask().querySelectorAll('button')].find(b => b.textContent === 'Remove').click();
      await until(() => !card(), 'removed');
      assert(confirmed === 0, `the browser's confirm() never used: ${confirmed}`);
    } finally { window.confirm = realConfirm; B.output.send = bSend; }
    try { for (const k of ['dj-crate', 'dj-crate-on', 'dj-crate-view', 'dj-crate-open']) localStorage.removeItem(k); } catch {}

    // 9. deck B's FM-1 drops off USB while playing and comes back: the deck empties, then takes it back by itself,
    //    playing again; both are in the Log
    assert(dB.clock?.running && dB.key === 'out-2', 'deck B playing on FM-1 B');
    const port = (p, state) => { p.state = state; const e = new Event('statechange'); e.port = p; access.dispatchEvent(e); };
    access.inputs.delete('b'); access.outputs.delete('b'); port(B.input, 'disconnected'); port(B.output, 'disconnected');
    await until(() => !dB.key && dB.gone?.key === 'out-2', `deck B empties and remembers its FM-1: ${dB.key}`, 6000);
    access.inputs.set('b', B.input); access.outputs.set('b', B.output); port(B.input, 'connected'); port(B.output, 'connected');
    await until(() => dB.key === 'out-2' && dB.clock?.running, `deck B takes its FM-1 back, playing: ${dB.key} ${dB.clock?.running}`, 8000);
    const log = document.querySelector('.dj-log');
    log.open = true; log.dispatchEvent(new Event('toggle'));
    const logged = log.querySelector('.dj-log-text').textContent;
    assert(/Deck B: its FM-1 \(out-2\) went away while playing/.test(logged) && /Deck B: its FM-1 is back \(out-2\)/.test(logged) && /disconnected/.test(logged),
      `the Log has it: ${logged}`);
    log.open = false;

    // 9b. ...and back on new port ids (Windows numbers an FM-1's ports again when it comes back): known by what it
    //     runs (firmware, LSDj, its songs' checksum); its .sav label follows; then back on its first ids for step 10
    const savLabel = k => { try { return JSON.parse(localStorage.getItem('dj-savs') || '{}')[k]; } catch { return null; } };
    rememberSav('out-2', 'Friday set', 1234);
    const renumber = async (inId, outId, key) => {
      access.inputs.delete(key.from); access.outputs.delete(key.from); port(B.input, 'disconnected'); port(B.output, 'disconnected');
      await until(() => !dB.key && dB.gone, `deck B empties: ${dB.key}`, 6000);
      B.input.id = inId; B.output.id = outId;
      access.inputs.set(key.to, B.input); access.outputs.set(key.to, B.output); port(B.input, 'connected'); port(B.output, 'connected');
      await until(() => dB.key === outId && dB.clock?.running, `deck B takes its FM-1 back on ${outId}, playing: ${dB.key} ${dB.clock?.running}`, 8000);
    };
    await renumber('in-2b', 'out-2b', {from: 'b', to: 'b2'});
    assert(savLabel('out-2b')?.name === 'Friday set' && !savLabel('out-2'), `its .sav label follows: ${JSON.stringify(savLabel('out-2b'))}`);
    log.open = true; log.dispatchEvent(new Event('toggle'));
    assert(/Deck B: its FM-1 is back on new ports \(out-2 -> out-2b\)/.test(log.querySelector('.dj-log-text').textContent), 'logged: back on new ports');
    log.open = false;
    assert(djState().decks[0].key === 'out-1', 'deck A untouched');
    await renumber('in-2', 'out-2', {from: 'b2', to: 'b'});

    // 10. each deck sets its FM-1 up for the page's clock by itself (0.9.98-dev.2): the MIDI settings it needs
    // (CLOCK IN, TRANSPORT, PC CUE; CLOCK OUT kept) and LSDj's SYNC to KEYBD while stopped; what it can't, on the
    // deck's warning strip
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    const warnB = () => [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-warn');
    const logNow = () => { const l = document.querySelector('.dj-log'); l.open = true; l.dispatchEvent(new Event('toggle')); const t = l.querySelector('.dj-log-text').textContent; l.open = false; return t; };
    B.midiWord = (0x4D000000 | 3 | 1 << 15) >>> 0;   /* CLOCK IN TRS, TRANSPORT OFF, PC CUE OFF, CLOCK OUT USB */
    B.sync = 3; B.dev2 = true; B.playing = 0; B.midiSets.length = 0; B.syncSets.length = 0;
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await until(() => B.midiSets.length === 1, 'deck B sets its FM-1\'s MIDI settings');
    const mB = unpackMidi(B.midiSets[0]);
    assert(mB.clockIn === 1 && mB.transport === 1 && mB.pcCue === 1 && mB.clockOut === 1, `CLOCK IN ALL, TRANSPORT ON, PC CUE ON, CLOCK OUT kept: ${JSON.stringify(mB)}`);
    await until(() => B.syncSets.join() === '5' && B.sync === 5, `LSDj's SYNC MIDI -> KEYBD: ${B.syncSets}`, 4000);
    await sleep(1200);
    assert(B.syncSets.length === 1 && B.midiSets.length === 1 && warnB().hidden, `once each, no warning: ${B.syncSets} ${B.midiSets.length} ${warnB().textContent}`);
    const logB = logNow();
    assert(/Deck B: set the FM-1's CLOCK IN to ALL, TRANSPORT ON, PC CUE ON/.test(logB) && /Deck B: set LSDj's SYNC from MIDI to KEYBD/.test(logB), `logged: ${logB.slice(-400)}`);
    /* SYNC = LSDJ with CLOCK OUT on: that FM-1 leads; left as it is, said on the strip */
    B.sync = 1;
    await until(() => !warnB().hidden && /CLOCK OUT on/.test(warnB().textContent), `LSDJ + CLOCK OUT: the warning: ${warnB().textContent}`, 3000);
    assert(B.syncSets.length === 1, 'LSDJ with CLOCK OUT on: not changed');
    /* a leading FM-1 (SYNC = LSDJ, CLOCK OUT on) taken by a deck while its MIDI settings come back late: its SYNC is
       never touched before they're known (it was set to KEYBD, and stopped sending its clock: Colin) */
    B.midiWord = (0x4D000000 | 1 | 8 | 1 << 11 | 1 << 15 | 1 << 17) >>> 0; B.slow = {[OP.SETTINGS_GET]: 1200}; B.sync = 1;   /* (its colours read late: the deck's polls come in before its MIDI settings are read) */
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await sleep(2500);
    assert(B.syncSets.length === 1 && B.sync === 1, `a leading FM-1 taken by a deck, its settings late: SYNC left LSDJ: ${B.syncSets} (${B.sync})`);
    B.slow = null;
    /* the master clock's own FM-1: never changed, even with CLOCK OUT off; the strip says to turn CLOCK OUT on */
    B.midiWord = (0x4D000000 | 1 | 8 | 1 << 11 | 1 << 17) >>> 0;
    choose(document.querySelector('.dj-master select[aria-label="Master clock"]'), 'in-2');
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await until(() => !warnB().hidden && /master clock, but its CLOCK OUT is off/.test(warnB().textContent), `the master's FM-1, CLOCK OUT off: the strip: ${warnB().textContent}`, 4000);
    assert(B.syncSets.length === 1 && B.sync === 1, `the master clock's FM-1: SYNC left LSDJ: ${B.syncSets}`);
    choose(document.querySelector('.dj-master select[aria-label="Master clock"]'), 'page');
    /* 0.9.98-dev.1 (no SYNC_SET) with SYNC = MIDI: nothing set, the strip says how */
    B.dev2 = false; B.sync = 3; B.midiWord = (0x4D000000 | 1 | 8 | 1 << 11 | 1 << 17) >>> 0;
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await until(() => !warnB().hidden && /SYNC is MIDI: set it to KEYBD/.test(warnB().textContent), `dev.1, SYNC MIDI: the warning: ${warnB().textContent}`, 3000);
    assert(B.syncSets.length === 1 && B.midiSets.length === 1, 'dev.1: nothing more sent');
    /* fixed by hand on LSDj: the strip goes */
    B.sync = 5;
    await until(() => warnB().hidden, 'SYNC KEYBD: the strip goes', 3000);
    B.dev2 = true;

    // 11. the FM-1 in use switched (Perform's FM-1 list) while the decks poll: no deck makes a link of its own on that
    // FM-1 meanwhile (it took the replies, and the switch said "did not answer" with the cable fine: Colin's Log);
    // and Follow stays put in the DJ layout (a kill on the other deck switched the FM-1 in use mid-set)
    B.slow = {[OP.INFO]: 700};   /* (INFO answered late: the decks poll meanwhile) */
    const toB = [...$('stage-pick').options].find(o => /LSDj-BBB/.test(o.textContent));
    choose($('stage-pick'), toB.value);
    await until(() => /running LSDj-BBB/.test($('device').textContent), `switched to B while the decks poll: ${$('device').textContent}`, 9000);
    assert(!/did not answer/.test($('device').textContent), 'no "did not answer"');
    B.slow = null;
    const followBtn = $('stage-follow');
    if (followBtn.getAttribute('aria-pressed') !== 'true') followBtn.click();
    const killA = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-kill');
    await sleep(3000); killA.click(); await sleep(400); killA.click();   /* deck A played (its FM-1 not the one in use) */
    await sleep(3000);
    assert(/running LSDj-BBB/.test($('device').textContent), `Follow in the DJ layout: the FM-1 in use stays: ${$('device').textContent}`);
    if (followBtn.getAttribute('aria-pressed') === 'true') followBtn.click();
    play(1);

    // 12. each FM-1 deck's screen, unframed; each deck's FX panel (lsdj/dj-fx.js): a drawer from its outer
    //     edge, changes only its own FM-1, follows a knob turned on the FM-1, a Columns view, its own window and back
    choose(pickA, ''); choose(pickA, 'fm1:out-1');
    await until(() => djState().decks[0].fx, 'deck A read FM-1 A\'s effects again');
    const deckBoxA = [...document.querySelectorAll('.dj-deck')][0];
    assert(deckBoxA.querySelector('.dj-view-box') && !deckBoxA.querySelector('.bezel, .dj-label'), 'deck A: its screen unframed, no label panel');
    const fxA = document.querySelector('.dj-fx-a'), tabA = document.querySelector('.dj-fx-tab-a');
    assert(fxA && !fxA.classList.contains('open') && getComputedStyle(fxA).visibility === 'hidden', 'drawer A closed at first');
    tabA.click();
    await until(() => getComputedStyle(fxA).visibility === 'visible', 'drawer A opens', 2000);
    [...fxA.querySelectorAll('.dj-fx-pages button')].find(b => b.textContent === 'FILTER').click();
    const cut = () => fxA.querySelector('input[aria-label="Deck A Cutoff PU1"]');
    assert(cut(), `the FILTER page: a cutoff for each channel: ${fxA.textContent.slice(0, 200)}`);
    const aSets = A.fxSets.length, bSets = B.fxSets.length;
    cut().value = 90; cut().dispatchEvent(new Event('input', {bubbles: true}));
    await until(() => A.fxSets.length > aSets && A.fxSets.at(-1)[1] === 90 && A.fxSets.at(-1)[0] === 1, `PU1 cutoff 90 (and a filter type) sent to FM-1 A: ${A.fxSets.at(-1)?.slice(0, 3)}`, 2000);
    assert(B.fxSets.length === bSets, 'nothing to FM-1 B');
    /* a knob turned on FM-1 A (PU1 resonance): the panel follows, once the page's own change has settled */
    A.fxBytes[2] = 9;
    const resoOut = () => fxA.querySelector('input[aria-label="Deck A Resonance PU1"]')?.closest('.dj-fx-cell')?.querySelector('output')?.textContent;
    await until(() => resoOut() === '9', `the panel follows FM-1 A's knob: ${resoOut()}`, 5000);
    /* Columns: both panels open beside the decks; Drawers again */
    document.querySelector('[data-fx-view=columns]').click();
    assert(document.querySelector('.dj-grid').classList.contains('fx-columns') && getComputedStyle(document.querySelector('.dj-fx-b')).position === 'static', 'Columns: both panels in the grid');
    document.querySelector('[data-fx-view=drawers]').click();
    assert(!document.querySelector('.dj-grid').classList.contains('fx-columns'), 'Drawers again');
    /* its own window, and back */
    fxA.querySelector('.dj-fx-pop').click();
    await until(() => document.body.classList.contains('pop-dj-fx-0') && fxA.ownerDocument !== document, 'drawer A in its own window', 3000);
    /* there, the full Effects view (no screen): the wiring and every page's card, the compact view hidden; a change
       made there goes to FM-1 A only */
    const win = fxA.ownerDocument.defaultView, fullA = fxA.querySelector('.dj-fxw');
    assert(win.getComputedStyle(fullA).display !== 'none' && win.getComputedStyle(fxA.querySelector('.dj-fx-panel')).display === 'none',
      'its own window: the full view shown, the compact one hidden');
    assert(fullA.querySelector('svg.fxd') && fullA.querySelectorAll('.fx-card').length >= 6 && fullA.querySelector('.fx-card.matrix.blocks .fx-chname'),
      `the wiring and the cards, as Perform's: ${fullA.querySelectorAll('.fx-card').length} cards`);
    const cutFull = fullA.querySelector('input[aria-label="Deck A Cutoff PU1 (full)"]');
    const aFull = A.fxSets.length, bFull = B.fxSets.length;
    cutFull.value = 33; cutFull.dispatchEvent(new win.Event('input', {bubbles: true}));
    await until(() => A.fxSets.length > aFull && A.fxSets.at(-1)[1] === 33, `PU1 cutoff 33 from its own window to FM-1 A: ${A.fxSets.at(-1)?.[1]}`, 2000);
    assert(B.fxSets.length === bFull, 'nothing to FM-1 B');
    fxA.querySelector('.dj-fx-pop').click();
    await until(() => !document.body.classList.contains('pop-dj-fx-0') && fxA.ownerDocument === document && fxA.isConnected, 'back in the layout', 3000);
    fxA.querySelector('.dj-fx-close').click();
    assert(!fxA.classList.contains('open'), 'closed with ✕');

    // 13. 0.9.98-dev.4: FM-1 B's own OP4 / OP5 play and stop its deck (DJ_KEY), its lights told the deck's state each
    //     poll (DJ_DECK: 1 stopped, 2 waiting for the bar, 3 playing); FM-1 A (FM-1_997) has no such keys: never told
    {
      const dB = djState().decks.find(d => d.key === 'out-2');
      assert(dB, 'a deck on FM-1 B');
      const deckEl = [...document.querySelectorAll('.dj-deck')][dB.i];
      if (dB.clock?.running) deckEl.querySelector('.dj-play').click();
      await until(() => B.djs.at(-1) === 1, `B told: stopped (${B.djs.slice(-5)})`, 3000);
      const sent = B.djs.length;
      B.djKey(0);
      await until(() => dB.clock?.running, 'OP4 on FM-1 B started its deck');
      await until(() => B.djs.at(-1) === 3, `B told: playing (${B.djs.slice(sent)})`, 3000);
      assert(B.djs.slice(sent).includes(2), `B told: waiting for the bar first (${B.djs.slice(sent)})`);
      B.djKey(0); await sleep(100);
      assert(dB.clock.running, 'OP4 again while playing: still playing (Play never stops)');
      B.djKey(1);
      await until(() => !dB.clock?.running, 'OP5 on FM-1 B stopped its deck');
      await until(() => B.djs.at(-1) === 1, `B told: stopped again (${B.djs.slice(-3)})`, 3000);
      B.djKey(1); await sleep(100);
      assert(!dB.clock.running, 'OP5 again while stopped: still stopped');
      const n = B.djs.length; await sleep(1000);
      assert(B.djs.length - n >= 2, `told each poll: ${B.djs.length - n} in 1 s`);
      assert(!A.djs.length && A.djAsks <= 8, `FM-1 A (no DJ keys): asked ${A.djAsks} times, once a deck assignment`);
    }

    document.querySelector('#stage-mode [data-mode="fx"]').click();
    assert(B.djs.at(-1) === 0, `the Effects layout: FM-1 B let go at once (${B.djs.slice(-3)})`);
    djState().decks.forEach(d => d.clock?.stop());
    /* never two links on one FM-1 input (link.js says so in the Log: the older one would stop hearing) */
    { const {logEntries} = await import('../lsdj/conn-log.js'); const two = logEntries().filter(e => /Two links on one FM-1 input/.test(e.text));
      assert(!two.length, `two links on one input: ${two.map(e => e.text).join(' | ')}`); }
    return 'PASS DJ layout: switch, decks on FM-1s, Start and clocks per deck, the next bar, its own tempo, Sync (a lock: lit, keeps the bar, follows the master, on a stopped deck, lets go when typed), stem kill, DJ filter, the echo throw (a tempo echo on a fresh FM-1, all back on let go), Loop (LSDj live mode), On bar, the key of the song (read in parts, C · 8B), Perform › Clock off, 0.9.98 (crossfader to FM-1 volume, Hold), DJ colours (the page and panel; FM-1 decks keep theirs), each deck its FM-1 colours, its label (the .sav sent, the open song, changed since), Screen | Rows (screen, song row map, click to cue), Tap quickly (no redraw), Whole BPM, the tempo controls (− / + held, nudge buttons, ×½ / ×2, MASTER, the fader range, pads, a glide, Next bar), TX-6 button and crossfader, fader mirrored, full volume after, an ArduinoBoy deck (speed notes, its channel, Start and clocks, FM-1 controls hidden), the crate (asked on the card, never confirm(); held to load; a .sav onto deck A while B plays on, untouched; ON A and the deck chip; Songs straight into a chosen song; search; Grab B; remove), an FM-1 pulled and back (the deck takes it back, playing, also on new port ids with its .sav label; the Log), stopped on the FM-1 (the deck stops too), never two links on one input, each deck sets its FM-1 up (MIDI settings, LSDj SYNC to KEYBD; the warning strip), the jog every frame, a switch while the decks poll, Follow put in the DJ layout, the screens unframed (the label a tooltip), each deck FX panel (a drawer, only its own FM-1, follows its knobs, Columns, its own window), OP4 / OP5 on the FM-1 (Play, Stop, its lights told each poll, let go on Effects; older firmware not asked again)';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess;
  }
}

/* for a look at the layout (screenshots; never in the suite): the DJ layout on two mocked FM-1s and a mocked
   ArduinoBoy port, left in place */
export async function djDemo() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const A = fm1(1, 'LSDj-AAA', 'FM-1_998'), B = fm1(2, 'LSDj-BBB', 'FM-1_998');
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output], ['ab', {id: 'ab-out', name: 'Arduinoboy', state: 'connected', send() {}}]]);
  Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
  await $('connect-btn').onclick();
  await until(() => $('stage-pick').options.length >= 2, 'both FM-1s listed');
  location.hash = '#live-sec';
  document.querySelector('#stage-mode [data-mode="dj"]').click();
  const [pickA, pickB] = [...document.querySelectorAll('.dj-deck h4 select')];
  await until(() => [...pickA.options].some(o => o.value === 'fm1:out-2'), 'deck choices');
  choose(pickA, 'fm1:out-1'); choose(pickB, 'fm1:out-2');
  await until(() => djState().decks.every(d => d.fx), 'the decks read their FM-1s');
  [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-view button:nth-child(2)').click();   /* B: Rows */
  [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-play').click();
  await sleep(1500);
  return 'demo';
}
