// SPDX-License-Identifier: GPL-3.0-only
// Several FM-1s plugged in at once (mocked; no device is touched): Connect lists them all, paired by who answers
// (they share a port name), the list switches, a moved effect goes to the FM-1 it was moved on, plugging and
// pulling one not in use changes only the list, a pulled cable reconnects to the same FM-1 only, and Follow
// switches to the FM-1 being played, but stays while the one in use is played or two others are at once.
import {OP, le32} from '../lsdj/link.js';
import {unpackSettings, packSettings} from '../lsdj/fx-model.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export function fm1(n, title, fw = 'FM-1_981') {
  const d = {n, title, page: 1, lives: 0, infos: 0, fxSets: [], silent: false, settings: 0x5a000000, screens: 0, themes: 0, delay: 0, pads: [], midi: [],
    identify: false, idents: [], other: [], restart: null, restartAsked: 0};   /* restart: [why, 11 words] (RESTART, 0.9.98-dev.19) */   /* identify: answers IDENTIFY (0.9.98-dev.19); other: every op asked besides INFO, LIVE, CART_INFO */
  const fx = Array(68).fill(0);
  fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[43] = 70; fx[38] = 1;
  d.input = Object.assign(new EventTarget(), {id: `in-${n}`, name: 'FM-1', state: 'connected', onmidimessage: null});   /* (listened to beside its link: MIDI sync) */
  d.output = {id: `out-${n}`, name: 'FM-1', state: 'connected', send(message) {
    if (this.state !== 'connected') throw new DOMException('The port is not connected', 'InvalidStateError');
    if (message[0] !== 0xf0) { d.midi.push(message[0]); return; }   /* clock, Start, Stop */
    if (d.silent) return;
    const op = message[4];
    const send = (data = [], status = 0) => (d.delay ? f => setTimeout(f, d.delay) : queueMicrotask)(() => d.input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) {
      d.infos++; const info = Array(35).fill(0); info[0] = 1;
      [...fw].forEach((c, i) => info[1 + i] = c.charCodeAt(0));
      [...title].forEach((c, i) => info[9 + i] = c.charCodeAt(0));
      return send(info);
    }
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.FX_SET) { d.fxSets.push(message); return send(); }
    if (op === OP.SETTINGS_GET) return send(le32(d.settings));
    if (op === OP.THEME_GET) { d.themes++; return send(Array(16).fill(0)); }
    if (op >= OP.SCREEN_INFO && op <= OP.SCREEN_FRAME) d.screens++;
    if (op === OP.PAD_SET) { const m = message[5] | (message[6] & 1) << 7; d.pads.push(m); if (m) d.page = d.page === 1 ? 2 : 1; return send(); }   /* LSDj moves: its LIVE changes */
    if (op === OP.LIVE) { d.lives++; return send([d.page, 1, 120, 0, 0, 0, 0, ...fx]); }
    if (op === OP.RESTART && d.restart) { d.restartAsked++; return send([d.restart[0], ...d.restart.slice(1).flatMap(v => [v & 255, v >> 8 & 255, v >> 16 & 255, v >>> 24])]); }
    if (op === OP.IDENTIFY && d.identify) { d.idents.push([message[5] | (message[6] & 1) << 7, message[7] | (message[8] & 1) << 7]); return send(); }
    if (![OP.INFO, OP.LIVE, OP.CART_INFO, OP.IDENTIFY, OP.RESTART].includes(op)) d.other.push(op);
    return send([], 1);
  }};
  return d;
}
export async function runDevicesUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB'), C = fm1(3, 'LSDj-CCC');
  const access = new EventTarget();
  /* the inputs in another order than the outputs: paired by who answers, not by place or name */
  access.inputs = new Map([['c', C.input], ['b', B.input], ['a', A.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output], ['c', C.output]]);
  const plug = (d, state) => {
    d.input.state = d.output.state = state;
    for (const port of [d.input, d.output]) { const e = new Event('statechange'); e.port = port; access.dispatchEvent(e); }
  };
  const device = () => $('device').textContent;
  const using = d => document.body.classList.contains('connected') && device().includes(d.title);
  const options = () => [...$('dev-pick').options].filter(o => o.value !== '').map(o => o.textContent);
  const pick = d => { const s = $('stage-pick'); s.value = [...s.options].find(o => o.textContent.includes(d.title)).value; s.dispatchEvent(new Event('change')); };
  try { localStorage.removeItem('lsdj-burrito-follow'); localStorage.removeItem('lsdj-burrito-screens'); } catch {}
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    await $('connect-btn').onclick();
    assert(using(A), `connected to the first: ${device()}`);
    await until(() => options().length === 3, `all three listed: ${options()}`);
    assert(options().every((t, i) => t.includes([A, B, C][i].title)) && !$('stage-pick').hidden && !$('follow-btn').hidden, `the list: ${options()}`);

    // 1. switch: the poll goes to the new one only (Follow off: the others are not asked)
    pick(B);
    await until(() => using(B), `switched to B: ${device()}`);
    const a0 = A.lives, c0 = C.lives; await sleep(1200);
    assert(B.lives > 2 && A.lives === a0 && C.lives === c0, `only B polled: A ${A.lives - a0}, B ${B.lives}, C ${C.lives - c0}`);

    // 2. an effect moved just before a switch goes to B, not to A
    const slider = document.querySelector('#live-sec .fx-ctl input[type=range]');
    const bSets = B.fxSets.length, aSets = A.fxSets.length;
    slider.value = String(+slider.value === 50 ? 51 : 50); slider.dispatchEvent(new Event('input'));
    pick(A);
    await until(() => using(A), `switched to A: ${device()}`);
    assert(B.fxSets.length === bSets + 1 && A.fxSets.length === aSets, `the moved effect went to B (${B.fxSets.length - bSets}), none to A (${A.fxSets.length - aSets})`);

    // 3. pulling and plugging one not in use: the list only
    plug(C, 'disconnected');
    await until(() => options().length === 2, `C gone from the list: ${options()}`);
    assert(using(A), 'still on A');
    plug(C, 'connected');
    await until(() => options().length === 3, `C back: ${options()}`);
    assert(using(A), 'still on A');

    // 4. the one in use pulled: lost; another one plugged in meanwhile is not taken; A back: reconnects to A
    plug(A, 'disconnected');
    await until(() => !document.body.classList.contains('connected'), `A lost: ${device()}`);
    plug(C, 'disconnected'); plug(C, 'connected');
    await sleep(4500);
    assert(!document.body.classList.contains('connected'), `not connected to another FM-1: ${device()}`);
    plug(A, 'connected');
    await until(() => using(A), `reconnected to A: ${device()}`);

    // 5. Follow: B played (its page changes) while A is quiet: the page goes to B
    $('stage-follow').click();
    assert($('stage-follow').getAttribute('aria-pressed') === 'true', 'Follow on');
    await sleep(1800);   /* A quiet */
    B.page = 2;
    await until(() => using(B), `followed to B: ${device()}`, 4000);

    // 6. tolerance: B (in use) and C played at once: stays on B
    await sleep(2600);   /* past the hold after a switch */
    let playing = true;
    const play = async (d, every) => { while (playing) { d.page = d.page === 1 ? 2 : 1; await sleep(every); } };
    const both = [play(B, 400), play(C, 400)];
    await sleep(3500);
    assert(using(B), `stays on B while it is played too: ${device()}`);
    playing = false; await Promise.all(both);
    // two others played at once (A and C) while B is quiet: stays; then only A: goes to A
    await sleep(1800);
    playing = true;
    const two = [play(A, 350), play(C, 350)];
    await sleep(3000);
    assert(using(B), `stays on B while two others are played at once: ${device()}`);
    playing = false; await Promise.all(two);
    await sleep(1800);   /* both quiet again */
    A.page = A.page === 1 ? 2 : 1;
    await until(() => using(A), `then only A played: followed to A: ${device()}`, 4000);
    $('stage-follow').click();

    // 7. switching back: what the page knew shows at once (no THEME_GET first), then it is read again: A's
    // theme changed meanwhile on the FM-1 shows
    pick(B); await until(() => using(B), `to B: ${device()}`);
    const s = unpackSettings(A.settings); s.theme = (s.theme + 1) % 4; A.settings = packSettings(s);
    const themesBefore = A.themes; A.delay = 60;   /* as a real FM-1 answers (~50 ms) */
    pick(A); await until(() => using(A), `back to A: ${device()}`);
    assert(A.themes === themesBefore, 'back on A before reading its colours again');
    await until(() => document.querySelector('#settings-form select[data-key="theme"]')?.value === String(s.theme), "A's new theme read again"); A.delay = 0;

    // 8. All screens: a tile per FM-1, the one in use lit; the others' screens asked over their own links; a click switches
    $('screens-all').click();
    await until(() => document.querySelectorAll('#screens-grid .screen-tile').length === 3 && !$('screens-grid').hidden, 'three tiles');
    assert(document.querySelectorAll('#screens-grid .screen-tile.on').length === 1 && document.querySelector('.screen-tile.on').textContent.includes(A.title), 'A lit');
    const b0 = B.screens, c1 = C.screens;
    await until(() => B.screens > b0 && C.screens > c1, `B and C screens asked: ${B.screens - b0}, ${C.screens - c1}`);
    [...document.querySelectorAll('.screen-tile')].find(t => t.textContent.includes(C.title)).click();
    await until(() => using(C) && document.querySelector('.screen-tile.on')?.textContent.includes(C.title), `a click on C's screen: ${device()}`);
    $('screens-all').click();
    assert($('screens-grid').hidden, 'back to one screen');
    await sleep(800); const a2 = A.screens, b2 = B.screens; await sleep(1500);
    assert(A.screens === a2 && B.screens === b2, `the others' screens no longer asked: ${A.screens - a2}, ${B.screens - b2}`);
    return 'PASS several FM-1s: listed (paired by who answers), switching (pending effect to the right one), plug/pull of others, reconnect to the same one only, Follow (and its tolerance), switching back at once (read again after), All screens (tiles, the others screens, click to switch)';
  } finally {
    try { localStorage.removeItem('lsdj-burrito-follow'); } catch {}
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}

/* Install with two FM-1s plugged in (0.9.98-dev.19): it asks which (Colin: it took whichever answered first). Each
   shows its number on its screen while asked (IDENTIFY; FM-1 2's older firmware can't: its row says so), nothing is
   picked until one is chosen, the page then uses that one and Install's question names it; Cancel installs nothing.
   The question is answered No here: nothing is written to either FM-1. */
export async function runInstallChooserUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess'), realConfirm = window.confirm;
  const A = fm1(1, 'LSDj-AAA', 'FM-1_998'), B = fm1(2, 'LSDj-BBB');   /* (INFO says FM-1_998 for every 0.9.98 build) */
  A.identify = true;
  A.restart = [1, 2, 3, 0x0200ABCD, 0x02001234, 5, 6, 0x01C10000, 812345, 0, 0x44, 0x20];   /* it crashed (FM-1 2: older, not asked) */
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output]]);
  const using = d => document.body.classList.contains('connected') && $('device').textContent.includes(d.title);
  const dialog = () => document.querySelector('dialog.choose-fm1');
  const asked = [];
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    window.confirm = m => { asked.push(m); return false; };
    await $('connect-btn').onclick();
    assert(using(A), `connected to A: ${$('device').textContent}`);
    /* its last run ended by itself: the Log says so, once, with where */
    const {logEntries} = await import('../lsdj/conn-log.js');
    const said = 'FM-1 1 (LSDj-AAA, FM-1_998) restarted by itself: a crash at 0x0200ABCD (vector 3, return 0x02001234, after 812 s running; crash 2 since power-on';
    const crashed = () => logEntries().filter(e => e.text.includes(said));
    await until(() => crashed().length === 1, `the crash in the Log: ${logEntries().slice(-3).map(e => e.text)}`);
    assert(B.restartAsked === 0, 'older firmware not asked');
    /* a firmware to install: the page's own template */
    const bytes = new Uint8Array(await (await fetch('lsdj/fm1-lsdj-template.fwsc')).arrayBuffer()), t = new DataTransfer();
    t.items.add(new File([bytes], 'test.fwsc')); $('fw-file').files = t.files; await $('fw-file').onchange({target: $('fw-file')});
    await until(() => !$('fw-install').disabled, `Install ready: ${$('fw-status').textContent}`);

    /* Install: which one? */
    let done = $('fw-install').onclick();
    await until(() => dialog()?.open, 'asked which FM-1');
    const rows = () => [...dialog().querySelectorAll('.fm1-row')].map(r => r.textContent);
    assert(rows().length === 2 && /^1FM-1 1 · LSDj-AAA/.test(rows()[0]) && /^2FM-1 2 · LSDj-BBB/.test(rows()[1]), `the rows: ${rows()}`);
    await until(() => A.idents.length && /its number is on its screen/.test(rows()[0]) && /can't show its number/.test(rows()[1]), `numbers shown: A ${JSON.stringify(A.idents)}; ${rows()}`);
    assert(JSON.stringify(A.idents[0]) === '[1,12]', `A shows 1 for 12 s: ${JSON.stringify(A.idents)}`);
    const ok = [...dialog().querySelectorAll('button')].find(b => b.classList.contains('primary'));
    assert(ok.disabled && ![...dialog().querySelectorAll('input')].some(i => i.checked), 'nothing picked until one is chosen');
    /* Cancel: nothing */
    [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Cancel').click(); await done;
    assert(!dialog() && /Nothing was installed/.test($('fw-status').textContent) && !asked.length, `cancelled: ${$('fw-status').textContent}`);
    await until(() => A.idents.some(x => x[1] === 0), `A's number taken away: ${JSON.stringify(A.idents)}`);

    /* again, FM-1 2 chosen: the page uses it, the question names it; No: nothing written */
    done = $('fw-install').onclick();
    await until(() => dialog()?.open, 'asked again');
    dialog().querySelectorAll('input')[1].click();
    assert(!ok.disabled || !dialog().querySelector('button.primary').disabled, 'Install on is on');
    assert(dialog().querySelector('button.primary').textContent === 'Install on FM-1 2', `the button: ${dialog().querySelector('button.primary').textContent}`);
    dialog().querySelector('button.primary').click(); await done;
    assert(using(B), `the page uses FM-1 2 now: ${$('device').textContent}`);
    assert(asked.some(m => /^Install .* on FM-1 2\?/.test(m)), `the question names it: ${asked.map(m => m.split('\n')[0])}`);
    assert(/Installing on FM-1 2 \(LSDj-BBB, FM-1_981\): chosen of 2/.test($('fw-log').textContent), 'the Log says which');
    const writes = [...A.other, ...B.other].filter(op => [OP.BEGIN, OP.CHUNK, OP.COMMIT, 0x08, 0x09, 0x0A, 0x0B].includes(op));   /* the song import, the swap */
    assert(!writes.length, `nothing written: ${writes}`);
    assert(crashed().length === 1 && A.restartAsked === 1, `asked and said once: ${A.restartAsked}, ${crashed().length}`);
    return 'PASS a crash restart said in the Log (RESTART), Install with two FM-1s: asks which (each its number on its screen, an older one says it can\'t), none picked until chosen, Cancel installs nothing, the one chosen used and named, nothing written when the question is answered No';
  } finally {
    window.confirm = realConfirm;
    dialog()?.remove();
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}

/* Two controllers, two FM-1s (0.9.97): each controller plays the FM-1 chosen for it. One on "the FM-1 in use" moves
   with a switch (the one left gets 0); one on a fixed FM-1 stays, and its presses there do not make Follow switch;
   its FM-1 pulled: it plays nothing. */
export async function runPadTargetsUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const hadPads = Object.getOwnPropertyDescriptor(Navigator.prototype, 'getGamepads');
  const A = fm1(1, 'LSDj-AAA', 'FM-1_997'), B = fm1(2, 'LSDj-BBB', 'FM-1_997');
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input]]); access.outputs = new Map([['a', A.output], ['b', B.output]]);
  const gp = (index, id) => ({index, id, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({length: 17}, () => ({pressed: false, value: 0}))});
  const P0 = gp(0, 'Pad One (STANDARD GAMEPAD)'), P1 = gp(1, 'Pad Two (STANDARD GAMEPAD)');
  const press = (p, b, on) => { p.buttons[b] = {pressed: on, value: on ? 1 : 0}; };
  const device = () => $('device').textContent;
  const using = d => document.body.classList.contains('connected') && device().includes(d.title);
  const plug = (d, state) => {
    d.input.state = d.output.state = state;
    for (const port of [d.input, d.output]) { const e = new Event('statechange'); e.port = port; access.dispatchEvent(e); }
  };
  try { localStorage.removeItem('lsdj-burrito-follow'); localStorage.removeItem('lsdj-burrito-screens'); localStorage.removeItem('lsdj-burrito-pad-pick'); } catch {}
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    Object.defineProperty(navigator, 'getGamepads', {configurable: true, value: () => [P0, P1]});
    await $('connect-btn').onclick();
    assert(using(A), `on A: ${device()}`);
    await until(() => !$('pad-targets').hidden && $('pad-targets').querySelectorAll('select').length === 2, 'a Plays choice per controller');
    const [s0, s1] = $('pad-targets').querySelectorAll('select');
    assert(s0.value === 'current' && s1.value === 'current', 'both on the FM-1 in use at first');
    s1.value = [...s1.options].find(o => o.textContent.includes(B.title)).value; s1.dispatchEvent(new Event('change'));
    // 1. each its own FM-1
    press(P0, 0, true); press(P1, 12, true);
    await until(() => A.pads.includes(1) && B.pads.includes(64), `A gets A (1), B gets UP (64): ${A.pads} | ${B.pads}`);
    assert(!A.pads.includes(64) && !B.pads.includes(1), 'nothing crossed over');
    // 2. a switch: the one on "the FM-1 in use" moves to B (A let go), the fixed one stays on B
    const s = $('stage-pick'); s.value = [...s.options].find(o => o.textContent.includes(B.title)).value; s.dispatchEvent(new Event('change'));
    await until(() => using(B), `on B: ${device()}`);
    await until(() => A.pads.at(-1) === 0 && B.pads.at(-1) === 65, `A let go, B gets A+UP: ${A.pads.slice(-3)} | ${B.pads.slice(-3)}`);
    press(P0, 0, false); press(P1, 12, false);
    await until(() => B.pads.at(-1) === 0, 'let go');
    // 3. Follow on, on B; the second controller set to A plays there: no switch to A
    $('stage-follow').click();
    $('pad-targets').querySelectorAll('select')[1].value = [...s1.options].find(o => o.textContent.includes(A.title)).value;
    $('pad-targets').querySelectorAll('select')[1].dispatchEvent(new Event('change'));
    await sleep(1800);
    for (let i = 0; i < 6; i++) { press(P1, 12, true); await sleep(250); press(P1, 12, false); await sleep(250); }
    assert(using(B) && A.pads.filter(m => m === 64).length >= 3, `stays on B while a controller here plays A: ${device()} (${A.pads.length} presses)`);
    $('stage-follow').click();
    // 4. A pulled: that controller plays nothing
    plug(A, 'disconnected');
    await until(() => $('pad-targets').hidden || $('pad-targets').querySelectorAll('select')[1]?.value === 'none', 'its FM-1 gone: Nothing', 5000);
    return 'PASS controllers on several FM-1s: a Plays choice each, each to its own FM-1, "the FM-1 in use" moves with a switch (the old one let go), a fixed one stays and does not make Follow switch, its FM-1 pulled: nothing';
  } finally {
    try { localStorage.removeItem('lsdj-burrito-follow'); } catch {}
    delete navigator.getGamepads;
    if (hadPads && !navigator.getGamepads) Object.defineProperty(Navigator.prototype, 'getGamepads', hadPads);
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}

/* MIDI sync: the page as the clock (tempo, Play / Stop to every FM-1), then one FM-1 leading (its clock and
   Start / Stop passed on to the others, never back to it); the leader pulled: Off */
export async function runSyncUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB'), C = fm1(3, 'LSDj-CCC');
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input], ['c', C.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output], ['c', C.output]]);
  const plug = (d, state) => {
    d.input.state = d.output.state = state;
    for (const port of [d.input, d.output]) { const e = new Event('statechange'); e.port = port; access.dispatchEvent(e); }
  };
  const count = (d, b) => d.midi.filter(x => x === b).length;
  const mode = v => { const s = $('sync-mode'); s.value = v; s.dispatchEvent(new Event('change')); };
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    await $('connect-btn').onclick();
    await until(() => !$('sync-row').hidden && $('sync-mode').options.length === 5, `Clock: Off, This page, three leaders: ${$('sync-mode').options.length}`);
    // 1. the page as the clock at 150 BPM: Start then 24 clocks a beat to all three; Stop: FC to all, no clocks after
    mode('page');
    assert(!$('sync-page').hidden, 'tempo and Play / Stop shown');
    $('sync-bpm').value = '150'; $('sync-bpm').dispatchEvent(new Event('change'));
    $('sync-play').click();
    await sleep(2000);
    for (const d of [A, B, C]) {
      const f8 = count(d, 0xf8);
      assert(d.midi[0] === 0xfa && f8 >= 110 && f8 <= 135, `${d.title}: Start, then ~120 clocks in 2 s at 150 BPM: ${d.midi[0]?.toString(16)}, ${f8}`);
    }
    $('sync-stop').click();
    await sleep(100);
    const after = A.midi.length;
    await sleep(500);
    assert([A, B, C].every(d => d.midi.includes(0xfc)) && A.midi.length === after, `Stop to all, nothing after: ${A.midi.length - after}`);
    // 2. A leads: what A sends goes on to B and C, not back to A
    mode('off'); [A, B, C].forEach(d => { d.midi.length = 0; });
    mode('out-1');
    assert($('sync-page').hidden && /follow the leader/.test($('sync-note').textContent), $('sync-note').textContent);
    const hear = b => { const e = new Event('midimessage'); e.data = Uint8Array.of(b); A.input.dispatchEvent(e); };
    hear(0xfa); for (let i = 0; i < 24; i++) hear(0xf8); hear(0x90); hear(0xfc);
    assert(count(B, 0xf8) === 24 && count(C, 0xf8) === 24 && B.midi[0] === 0xfa && B.midi.at(-1) === 0xfc, `B and C follow A: ${B.midi.length}, ${C.midi.length}`);
    assert(A.midi.length === 0 && !B.midi.includes(0x90), 'nothing back to the leader; notes not passed on');
    // 3. the leader pulled: the clock goes off and says so
    plug(A, 'disconnected');
    await until(() => $('sync-mode').value === 'off' && /leading FM-1 went away/.test($('sync-note').textContent), `leader gone: ${$('sync-mode').value} ${$('sync-note').textContent}`, 5000);
    return 'PASS MIDI sync: the page as the clock (tempo, Start, 24 a beat, Stop to every FM-1), one FM-1 leading (passed on to the others, not back), the leader pulled: off';
  } finally {
    try { $('sync-mode').value = 'off'; $('sync-mode').dispatchEvent(new Event('change')); } catch {}
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
