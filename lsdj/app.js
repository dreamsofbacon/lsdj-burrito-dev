// SPDX-License-Identifier: GPL-3.0-only
// The page: connect to the FM-1's running LSDJ Burrito firmware (lsdj/link.js)
// for live effects, songs, colours and settings. Never writes firmware.
import {startGamepad, loadMaps, mapFor, saveMap, loadPick, savePick, assign, takenFrom, isDefaultMap, defaultMapFor, inputName, GB_ORDER, SLOTS} from './gamepad.js';
import {Link, midiPorts, findFm1s, LinkError, SAVE_SIZE, crc32, sameFm1} from './link.js';
import {confirmSaveImport} from './save-file.js';
import {mountSongsUi, setSongsHooks, drawSongsDevices, songsState} from './songs-ui.js';
import {showDeviceTheme, setMatching, matching} from './page-theme.js';
import {setBeforeInstall, installing, installTarget, usbMidiUnavailable} from './install-ui.js';
import {setCrateHooks} from './crate-ui.js';
import {logEvent} from './conn-log.js';
import {CHANNELS, pagesForFx, PARAM, paramGet, paramSet, valueText, channelSummary, unpackFx, packFx, unpackReverb, packReverb, packReverbSends, PRESETS, THEMES, COLOR_NAMES, toHex, fromHex,
        SETTINGS, unpackSettings, packSettings, MIDI_SETTINGS, MIDI_CC_MAP, unpackMidi, packMidi, CUSTOM_THEME, isMasterPage,
        firmwareNumber, FEATURES, unpackFeatures, packFeatures, effectActive} from './fx-model.js';
import {fxDiagram, pageFor} from './fx-diagram.js';
import {zipStore} from './zip.js';
import {startClock, startRelay, clampBpm} from './midiclock.js';
import {mountDj, setDjHooks, djShown, djDevicesChanged, rememberSav, djLive} from './dj-ui.js';
import {romFromSlot} from './lsdj-rom.js';
import {ScreenMirror} from './screen.js';
import {initPresets, presetsShown, readPresetList} from './presets-ui.js';
import {popOut, onPopChange, isOut, docs, seen, anyVisible, visibleWindow} from './popout.js';
import {startVirtual, virtualFirmware, mountVirtual, virtualPaused, pauseVirtual} from '../emulator/app.js';

/* by id or selector, in the page and in the panels' own windows (lsdj/popout.js) */
const $ = id => { for (const d of docs()) { const el = d.getElementById(id); if (el) return el; } return null; };
const $$ = sel => docs().flatMap(d => [...d.querySelectorAll(sel)]);
const say = (id, text, cls = 'hint') => {
  const el = $(id); el.textContent = text; el.className = cls;
  if (id === 'device' && cls !== 'hint') logEvent(text);   /* the connection's news, kept to read later (conn-log.js) */
};
let hasPresets = false;   // the FM-1 in use has presets (INFO, 0.9.98-dev.6)
const enable = on => {
  ['live-sec', 'songs-sec', 'theme-sec', 'settings-sec'].forEach(id => $(id).setAttribute('aria-disabled', on ? 'false' : 'true'));
  presetsShown(on && hasPresets);
  document.dispatchEvent(new CustomEvent('device-state', {detail: {connected: on}}));   // lsdj/ui.js: layout
};

let midi = null;   // the MIDI options (null: firmware without them)
let features = null;   // the feature switches, SETTINGS / FX+LIGHTS (null: firmware before FM-1_979)
let fwId = '', fwNum = 0;   // the firmware: "FM-1_979", 979
let link = null, ports = null, fx = null, settings = null, theme = PRESETS[0].slice(), busy = false, touched = 0;
let connected = false;
let mirror = null;   // the FM-1's screen above Effects (lsdj/screen.js)
let virtual = false;   // connected to the virtual FM-1 (emulator/app.js) over its emulated USB, not a device
const VIRTUAL = 'the virtual FM-1';

/* ---------- connect ---------- */
/* fast: a switch between FM-1s (what the page remembers of the one switched to shows at once); Connect and a
   reconnect read everything */
async function connectTo(input, output, how = 'USB', {fast = false} = {}) {
  if (busy || installing() || connecting) return;
  connecting = true;
  try { await connectOnce(input, output, how, fast); }
  finally { connecting = false; }
  drawDevPick(); syncWatchers();
  if (connected && !virtual) scanSoon();   /* (the other FM-1s plugged in, for the list) */
}
async function connectOnce(input, output, how, fast) {
  await scanning;   /* a search for FM-1s borrows their inputs: let it finish */
  await flushSend();   /* an effect moved a moment ago goes to the FM-1 it was moved for */
  remember();
  /* (the controllers keep going: those on "the FM-1 in use" move with it, the old one gets 0) */
  stopPoll(); lostAt = 0; missed = 0; lastKey = null;
  if (virtual && how !== VIRTUAL) pauseVirtual();
  for (const d of [...watchers.keys()]) if (d.input === input || d.output === output) unwatch(d);
  for (const d of [...padLinks.keys()]) if (d.input === input || d.output === output) closePadLink(d);
  connected = false; current = null;
  mirror?.stop(); mirror = null;
  showVirtual(how === VIRTUAL);
  link?.close(); link = new Link(input, output);
  try {
    const info = await link.info();
    if (info.protocol !== 1) throw new LinkError(`This page speaks link version 1; the FM-1 speaks ${info.protocol}. Update the page or the firmware.`);
    fwId = info.firmware; fwNum = firmwareNumber(info.firmware); hasPresets = info.presets;
    muteOk = fwNum >= 977;   // MUTE_SET: FM-1_977 and newer
    say('device', (virtual ? `Connected to the virtual FM-1 (the emulator on this page, not a device): ` : `Connected over ${how}: `) +
      `${info.firmware} running ${info.title || 'a game'}` + (info.liveKnown ? '' : ' (live data needs LSDj 9.3.9)'), 'ok');
    $('stage-dev').textContent = virtual ? `· virtual FM-1 (${info.firmware})` : `· ${info.firmware} over ${how}`;
    const dev = virtual ? null : devices.find(d => d.input === input && d.output === output) || {input, output, name: output.name, info};
    /* an FM-1 switched back to: what the page knew of it shows at once (each request takes ~50 ms); the live poll
       brings its effects, and the rest is read again just after (refreshDevice) */
    const known = fast && dev && remembered.get(dev);
    if (known && known.fwId === info.firmware) {
      ({settings, midi, features} = structuredClone(known));
      fx = structuredClone(known.fx); customTheme = known.customTheme.slice(); theme = customTheme.slice();
    } else {
      fx = unpackFx(await link.fxGet());
      fx.reverb = await readReverb();
      settings = unpackSettings(await link.settingsGet());
      { const w = await link.midiGet(); midi = w === null ? null : unpackMidi(w); }
      { const w = fwNum >= 979 ? await link.featGet() : null; features = w === null ? null : unpackFeatures(w); }
      theme = await link.themeGet(); customTheme = theme.slice();
    }
    buildFx(); buildSettings(); buildTheme(); enable(true);
    pageTheme();
    if (hasPresets) await readPresetList(link).catch(() => {});   /* (the live poll reads it again now and then) */
    connected = true; lostAt = 0; missed = 0; activeAt = Date.now();
    if (dev) {
      current = dev; current.info = info;
      lastDev = {inId: input.id, outId: output.id, name: output.name};
      if (known) void refreshDevice(link);
    }
    watchPorts(ports?.access);
    startPoll(250);
    if (!virtual) startMirror();
    startPad();
  } catch (e) { enable(false); say('device', e.message, 'bad'); }
}
/* ---------- a lost FM-1 ----------
   Web MIDI says when the FM-1's port goes (the cable pulled, the FM-1 turned off); the live poll
   also checks the ports, and LOST_POLLS unanswered polls in a row count as lost too. Then the page
   goes back to Not connected, and connects again by itself when the FM-1's port comes back. */
const LOST_POLLS = 4;
/* ...and only once the FM-1 has said nothing at all on that link for HEARD_MS: replies go missing now and then on
   a busy link (the DJ layout: two polls, the screen, the label reads on one FM-1), while it is still answering the
   rest. Gone for real, it falls silent, and is lost a moment after the 4th miss as before. */
const HEARD_MS = 4000;
const silent = l => !l || Date.now() - (l.heard ?? 0) >= HEARD_MS;
let missed = 0, lostAt = 0, watching = null, reconnecting = false;
const samePort = (a, b) => !!a && !!b && (a === b || (a.id != null && a.id === b.id));
const portGone = () => [link?.input, link?.output].some(p => p?.state === 'disconnected');
function lost(message) {
  if (!connected || installing()) return;
  if (virtual) { message = 'The virtual FM-1 stopped. Press Use the virtual FM-1 to start it again.'; showVirtual(false); }
  connected = false; lostAt = virtual ? 0 : Date.now(); missed = 0;
  /* for the log: how long it had been quiet, and what the page was waiting for */
  if (!virtual) logEvent(`Lost the FM-1 in use (${current ? portKey(current) : '?'}): quiet ${((Date.now() - (link?.heard ?? 0)) / 1000).toFixed(1)} s` +
    (link?.waiting ? `, waiting for op 0x${link.waiting.op.toString(16)}` : '') + `, ${stageMode === 'dj' ? 'DJ layout' : 'Effects layout'}.`);
  stopPoll(); mirror?.stop(); mirror = null; link?.close();
  if (![...padTargets.values()].some(v => v !== 'current' && v !== 'none')) { pad?.(); pad = null; }   /* none plays another FM-1 */
  soloAtLoss = devices.filter(d => !sameDev(d, current)).length === 0;
  /* to know it again on new ports (Windows numbers an FM-1's ports again when it comes back): the others' ports
     at this moment, and what it said it runs */
  othersAtLoss = new Set(devices.filter(d => !sameDev(d, current)).flatMap(d => [d.input.id, d.output.id]));
  lossInfo = current?.info ? {title: current.info.title, firmware: current.info.firmware, saveCrc: current.info.saveCrc} : null;
  current = null; syncWatchers(); drawDevPick();
  enable(false); say('device', message, 'warn');
}
const UNPLUGGED = 'The FM-1 was disconnected. Plug it in again: the page connects by itself (or press Connect).';
const portStates = new Map();
function onPortChange(e) {
  const p = e.port;
  if (!p) return;
  if (portStates.get(p.id) !== p.state) {   /* (opened and closed are left out: only plugged in and pulled) */
    if (portStates.has(p.id) || p.state === 'disconnected') logEvent(`MIDI ${p.type || 'port'} ${p.name || ''} (${p.id}) ${p.state}.`);
    portStates.set(p.id, p.state);
  }
  if (p.state === 'disconnected' && connected && (samePort(p, link?.input) || samePort(p, link?.output))) return lost(UNPLUGGED);
  if (p.state === 'connected' && !connected && lostAt) reconnect();
  scanSoon();   /* another FM-1 plugged in or pulled: the list follows (only the one in use is "lost") */
}
function watchPorts(access) {
  if (access === watching || !access?.addEventListener) return;   // test doubles may have no events
  watching?.removeEventListener('statechange', onPortChange);
  watching = access; access.addEventListener('statechange', onPortChange);
}
/* the FM-1's input and output come back one after the other, and it may still be starting: try a few times */
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    for (const wait of [300, 1000, 2500, 5000, 8000]) {   /* (USB back a few seconds after a hub hiccup) */
      await new Promise(r => setTimeout(r, wait));
      if (connected || !lostAt || busy || installing()) return;
      await connectUsbQuietly({again: true});   /* the same FM-1 only, never another one plugged in */
      if (connected) return;
    }
    if (!connected) say('device', 'The FM-1 is back but did not answer. Is LSDJ Burrito running? Press Connect to try again.', 'warn');
  } finally { reconnecting = false; }
}
$('connect-btn').onclick = async () => {
  if (busy || installing()) return;
  const unavailable = usbMidiUnavailable();
  if (unavailable) return say('device', unavailable, 'warn');
  try {
    ports = await midiPorts();
    const found = await scan();
    if (found.length) { const d = choose(found) || found[0]; return connectTo(d.input, d.output); }
    if (ports.input && ports.output) return connectTo(ports.input, ports.output);
    if (!ports.ins.length) return say('device', 'No MIDI devices found. Check the USB cable (a data cable) and that the FM-1 is on.', 'bad');
    const pick = $('port-pick'); pick.hidden = false; pick.replaceChildren(new Option('Choose the FM-1…', ''));
    ports.ins.forEach((p, i) => pick.append(new Option(p.name, i)));
    say('device', 'The FM-1 was not recognised by name: choose its MIDI port.', 'warn');
  } catch (e) { say('device', e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access was blocked. Allow it (with SysEx) for this page.' : e.message, 'bad'); }
};
if (usbMidiUnavailable()) {
  $('connect-btn').disabled = true;
  say('device', usbMidiUnavailable(), 'warn');
}
/* ---------- the virtual FM-1 ----------
   The emulator (emulator/app.js) with a USB cable plugged in: the page's link reaches it as it reaches a
   device, so Perform, Songs, Colours and Settings work on it. Its own picture (the playable instrument, or
   its screen) stands in the Screen panel instead of the screen mirror. */
function showVirtual(on) {
  if (virtual === on) return;
  virtual = on;
  $('virtual-box').hidden = !on;
  $('pan-screen').classList.toggle('virtual', on);
  if (on) { $('fm1-screen-box').hidden = true; $('fm1-screen-note').hidden = true; }
  mountVirtual(on ? $('virtual-mount') : null);
  virtualView();
}
let virtualLcd = false;   /* the Screen panel shows: the instrument, or only its screen */
function virtualView() {
  $('virtual-view').setAttribute('aria-pressed', String(virtualLcd));
  $('virtual-view').textContent = virtualLcd ? 'Show the instrument' : 'Show only the screen';
  if (!virtual) { $('emu-view').hidden = false; return; }
  $('emu-view').hidden = virtualLcd; $('emu-lcd').hidden = !virtualLcd;
}
$('virtual-view').onclick = () => { virtualLcd = !virtualLcd; virtualView(); };
const virtualReady = () => { $('virtual-btn').disabled = busy || installing() || !virtualFirmware(); };
document.addEventListener('firmware-selection-state', virtualReady);
document.addEventListener('firmware-install-state', virtualReady);
document.addEventListener('virtual-fm1-firmware', virtualReady);
document.addEventListener('virtual-fm1', e => { if (!e.detail.connected && virtual) lost(''); });
virtualReady();
$('virtual-btn').onclick = async () => {
  if (busy || installing()) return;
  say('device', 'Starting the virtual FM-1…');
  try {
    const {input, output} = await startVirtual();
    /* the firmware starts its USB a moment after the emulator boots: ask until it answers (~30 s at most) */
    for (let i = 0; ; i++) {
      const probe = new Link(input, output);
      try { await probe.info(); probe.close(); break; }
      catch (e) { probe.close(); if (i >= 20 || input.state !== 'connected') throw e; }
      say('device', 'Starting the virtual FM-1… (waiting for its USB)');
    }
    await connectTo(input, output, VIRTUAL);
  } catch (e) { if (!connected) say('device', `The virtual FM-1 did not connect: ${e.message}`, 'bad'); }
};
/* ---------- several FM-1s ----------
   Every FM-1 plugged in is listed (link.js findFm1s: each answers INFO on its own ports). The page talks to one
   at a time; the list (My FM-1, and Perform's head) switches. Follow: the page also watches the others (LIVE, a
   few times a second) and switches to the one being played (a knob, a page, a mute, the cursor, start / stop).
   It stays while the one in use is played too, and while two or more others are played at once (no flip-flop),
   and keeps a switch at least HOLD_MS. A pulled cable reconnects to the same FM-1 only. */
const QUIET_MS = 1500, HOLD_MS = 2500, WATCH_MS = 300;
let devices = [], current = null, lastDev = null, scanning = null, connecting = false, scanTimer = 0;
let follow = false, activeAt = 0, switchedAt = 0, lastKey = null;
const watchers = new Map();   // an FM-1 not in use -> {link, base, at, missed}
try { follow = localStorage.getItem('lsdj-burrito-follow') === '1'; } catch { /* storage blocked: off */ }
const sameDev = (a, b) => !!a && !!b && a.input === b.input && a.output === b.output;
const liveKey = l => [l.page, l.cursor, l.bpm, l.mute, l.freeze, l.playing, ...l.fx].join();
const portKey = d => String(d.output.id ?? d.name);
let searchAgain = 0;
async function scan() {
  if (!ports?.access || connecting || busy || installing()) return devices;
  if (scanning) return scanning;
  scanning = (async () => {
    const known = [...(connected && current ? [current] : []), ...watchers.keys(), ...padLinks.keys()], before = devices.slice();
    /* an FM-1 found again keeps its entry: what the page remembers of it, its screen tile, its watcher */
    devices = (await findFm1s(ports.access, {known})).map(f => {
      const old = devices.find(o => sameDev(o, f));
      return old ? Object.assign(old, {info: f.info}) : f;
    }).sort((a, b) => portKey(a).localeCompare(portKey(b)));
    for (const d of [...padLinks.keys()]) if (!devices.includes(d)) closePadLink(d);
    /* one that left the list while its ports are still plugged in did not answer the search (busy, or starting):
       searched again in a moment, a few times, so a DJ deck on it gets it back */
    const missing = before.filter(o => !devices.some(d => sameDev(d, o)));
    for (const o of missing) logEvent(`FM-1 ${portKey(o)} (${o.info?.title || 'no LSDj'}) is no longer found.`);
    for (const d of devices) if (before.length && !before.some(o => sameDev(o, d))) logEvent(`FM-1 ${portKey(d)} (${d.info.title || 'no LSDj'}) found.`);
    if (missing.some(o => o.input.state === 'connected' && o.output.state === 'connected') && searchAgain < 5) { searchAgain++; setTimeout(() => void scan(), 2000); }
    else if (!missing.length) searchAgain = 0;
    drawDevPick(); syncWatchers();
    return devices;
  })().catch(() => devices).finally(() => { scanning = null; });
  return scanning;
}
const scanSoon = () => { clearTimeout(scanTimer); scanTimer = setTimeout(() => void scan(), 700); };
/* the FM-1 used last (a reconnect, Read from my FM-1): by its ports, else the only one there is.
   again (a pulled cable): by its ports, or (its ports renamed) the only one when it was the only one: FM-1s
   share a port name, so with several a name proves nothing, and the page never takes another one. */
let soloAtLoss = true;
let othersAtLoss = new Set(), lossInfo = null;
function choose(found, again = false) {
  const byId = lastDev && found.find(d => d.input.id === lastDev.inId && d.output.id === lastDev.outId);
  if (byId) return byId;
  if (!again) return found.length === 1 ? found[0] : null;
  if (soloAtLoss && found.length === 1) return found[0];
  /* back on new ports: not one of the other FM-1s there at the loss, and the same firmware and LSDj (its songs'
     checksum when that still leaves two) */
  return sameFm1(found.filter(d => !othersAtLoss.has(d.input.id) && !othersAtLoss.has(d.output.id)), lossInfo, d => d.info);
}
/* what the page knew of each FM-1 it switched away from (this visit only) */
const remembered = new Map();
function remember() {
  if (connected && current && fx && settings)
    remembered.set(current, structuredClone({fwId, fx, settings, midi, features, customTheme: customTheme || theme}));
}
/* after a switch back: the settings, MIDI options, switches and colours read again; the page redrawn if any changed */
async function refreshDevice(l) {
  try {
    const s = unpackSettings(await l.settingsGet());
    const mw = await l.midiGet(), m = mw === null ? null : unpackMidi(mw);
    const fw = fwNum >= 979 ? await l.featGet() : null, f = fw === null ? null : unpackFeatures(fw);
    const th = await l.themeGet();
    if (l !== link || !connected || busy) return;
    if (JSON.stringify([settings, midi, features, customTheme]) === JSON.stringify([s, m, f, th])) return;
    settings = s; midi = m; features = f; customTheme = th.slice(); theme = th.slice();
    buildSettings(); buildTheme(); pageTheme();
  } catch { /* the live poll notices a lost FM-1 */ }
}
async function flushSend() {
  if (!sendTimer || !link) return;
  clearTimeout(sendTimer); sendTimer = null;
  try { await link.fxSet(packFx(fx)); if (fx.reverb) await writeReverb(fx.reverb); } catch { /* it went away */ }
}
async function switchTo(d) {
  if (connected && sameDev(d, current)) return;
  switchedAt = Date.now();
  await connectTo(d.input, d.output, 'USB', {fast: true});
}
/* All screens: every FM-1's screen at once (up to MAX_SCREENS), in Perform's Screen panel; a click on one switches
   to it. Each FM-1 not in use gets its own screen mirror on its watcher's link. */
const MAX_SCREENS = 4;
let allScreens = false;
try { allScreens = localStorage.getItem('lsdj-burrito-screens') === '1'; } catch { /* off */ }
const gridOn = () => allScreens && devices.length >= 2 && !virtual;
const tiles = new Map();   // an FM-1 -> its tile {el, canvas, caption}
function drawGrid() {
  const grid = $('screens-grid'), on = gridOn(), shown = devices.slice(0, MAX_SCREENS);
  grid.hidden = !on;
  $('screens-all').hidden = devices.length < 2 || virtual;
  $('screens-all').setAttribute('aria-pressed', String(allScreens));
  if (on) $('fm1-screen-box').hidden = $('fm1-screen-note').hidden = true;
  if (shown.length !== tiles.size || shown.some(d => !tiles.has(d))) {
    for (const d of [...tiles.keys()]) if (!shown.includes(d)) tiles.delete(d);
    grid.replaceChildren(...shown.map(d => {
      let t = tiles.get(d);
      if (!t) {
        const el = document.createElement('button'), canvas = document.createElement('canvas'), caption = document.createElement('span');
        el.type = 'button'; el.className = 'screen-tile'; canvas.width = 160; canvas.height = 144;
        el.append(canvas, caption); el.onclick = () => void switchTo(d);
        t = {el, canvas, caption}; tiles.set(d, t);
      }
      return t.el;
    }));
  }
  shown.forEach((d, i) => {
    const t = tiles.get(d), on = connected && sameDev(d, current);
    t.el.classList.toggle('on', on); t.el.setAttribute('aria-pressed', String(on));
    t.caption.textContent = `${i + 1}: ${d.info.title || 'no LSDj'}`; t.el.title = devLabel(d, i) + (on ? ' (in use)' : ': click to use it');
  });
}
function watch(d) {
  if (watchers.has(d) || sameDev(d, current)) return;
  closePadLink(d);   /* the watcher's link carries a controller's presses too */
  const w = {link: new Link(d.input, d.output), base: null, at: 0, missed: 0, mode: watchMode(), mirror: null};
  watchers.set(d, w);
  const canvas = gridOn() && tiles.get(d)?.canvas;
  if (canvas) {   /* its screen in its tile, while the grid shows and nothing else needs the link */
    w.mirror = new ScreenMirror(w.link, canvas, {every: 33, clock: visibleWindow, push: firmwareNumber(d.info.firmware) >= 990,
      active: () => gridOn() && stageMode !== 'dj' && !busy && !installing() && !connecting && seen(canvas)});   /* DJ: the decks' own */
    w.mirror.start();
  }
  const step = async () => {
    if (watchers.get(d) !== w) return;
    if (follow && !busy && !installing() && !connecting && anyVisible()) {
      try {
        const key = liveKey(await w.link.live()); w.missed = 0;
        /* played, unless by a controller on this page (that is not someone at the FM-1) */
        if (w.base !== null && key !== w.base && Date.now() - (padAt.get(portKey(d)) || 0) > QUIET_MS) { w.at = Date.now(); maybeFollow(d); }
        w.base = key;
      } catch { if (++w.missed >= LOST_POLLS && silent(w.link)) { logEvent(`FM-1 ${portKey(d)} stopped answering: looking for it again.`); unwatch(d); scanSoon(); return; } }
    }
    if (watchers.get(d) === w) visibleWindow().setTimeout(step, WATCH_MS);
  };
  step();
}
function unwatch(d) { const w = watchers.get(d); if (!w) return; watchers.delete(d); w.mirror?.stop(); w.link.close(); }
const watchMode = () => `${follow} ${gridOn()}`;
function syncWatchers() {
  const want = (follow || gridOn()) && connected && !connecting ? devices.filter(d => !sameDev(d, current)) : [];
  for (const [d, w] of [...watchers]) if (!want.includes(d) || w.mode !== watchMode()) unwatch(d);
  want.forEach(watch);
}
$('screens-all').onclick = () => {
  allScreens = !allScreens;
  try { localStorage.setItem('lsdj-burrito-screens', allScreens ? '1' : '0'); } catch { /* this visit only */ }
  drawDevPick(); syncWatchers();
  if (connected && !virtual) startMirror();   /* the FM-1 in use: into its tile, or back to the one big screen */
};
/* d was just played: switch to it, unless the FM-1 in use was played lately (or the page's own controls), a
   switch was just made, or another one is being played as well */
const CONFIRM_MS = 700;   /* played at the same moment as the one in use: its poll gets the time to say so */
let followTimer = 0;
function maybeFollow(d) {
  const stay = () => {
    const now = Date.now();
    return !follow || stageMode === 'dj' || !connected || busy || installing() || connecting || capturing || !watchers.has(d) ||
      now - activeAt < QUIET_MS || now - touched < QUIET_MS || now - switchedAt < HOLD_MS ||
      [...watchers].some(([o, w]) => o !== d && now - w.at < QUIET_MS);
  };
  if (stay() || followTimer) return;
  followTimer = setTimeout(() => {
    followTimer = 0;
    if (stay()) return;
    say('device', 'Following the FM-1 being played…');
    void switchTo(d);
  }, CONFIRM_MS);
}
function devLabel(d, i) { return `FM-1 ${i + 1}: ${d.info.title || 'no LSDj'} · ${d.info.firmware} (${d.name})`; }
function drawDevPick() {
  drawGrid(); drawPadTargets(); refreshSync(); djDevicesChanged();
  const choices = devices.map((d, i) => [String(i), devLabel(d, i)]);
  if (virtual) choices.push(['virtual', 'The virtual FM-1']);
  const now = virtual ? 'virtual' : connected ? String(devices.findIndex(d => sameDev(d, current))) : '';
  const has = choices.some(([v]) => v === now);
  for (const id of ['dev-pick', 'stage-pick']) {
    const s = $(id);
    s.hidden = choices.length < 2;
    s.replaceChildren(...(has ? [] : [new Option('Choose an FM-1…', '')]), ...choices.map(([v, t]) => new Option(t, v)));
    s.value = has ? now : '';
  }
  drawSongsDevices(choices, now);   /* Songs & kits: shown with one FM-1 too, and its Search entry */
  for (const id of ['follow-btn', 'stage-follow']) {
    const b = $(id);
    b.hidden = devices.length < 2 && !(virtual && devices.length);
    b.setAttribute('aria-pressed', String(follow));
  }
}
for (const id of ['dev-pick', 'stage-pick']) $(id).onchange = e => {
  const v = e.target.value;
  if (v === 'virtual') { if (!virtual) $('virtual-btn').onclick(); return; }
  const d = devices[+v];
  if (v !== '' && d) void switchTo(d);
};
for (const id of ['follow-btn', 'stage-follow']) $(id).onclick = () => {
  follow = !follow;
  try { localStorage.setItem('lsdj-burrito-follow', follow ? '1' : '0'); } catch { /* kept for this visit only */ }
  drawDevPick(); syncWatchers();
};
/* ---------- MIDI sync (lsdj/midiclock.js) ----------
   Clock: Off; This page (a tempo, Play / Stop: clock, Start and Stop to every FM-1 plugged in); or one FM-1 leads
   (its clock and Start / Stop, as they arrive, passed on to the others). Over each FM-1's own output, whichever FM-1
   is in use; the leader's input is listened to beside its link (addEventListener: the link keeps onmidimessage). */
let clock = null, relay = null, leader = null, syncMode = 'off';
const syncSet = new Map();   // output -> timed, as given to the clock or the relay
const leaderHear = e => relay?.feed(e.data);
function syncOuts() {
  const outs = new Map(devices.map(d => [d.output, true]));
  if (connected && link && !outs.has(link.output)) outs.set(link.output, !virtual);   /* the virtual FM-1: no timestamps */
  if (leader) outs.delete(leader.output);   /* never back to the leader */
  return outs;
}
function syncTargets() {
  const engine = clock || relay, want = engine ? syncOuts() : new Map();
  for (const [out] of [...syncSet]) if (!want.has(out)) { engine?.removeTarget(out); syncSet.delete(out); }
  for (const [out, timed] of want) if (!syncSet.has(out)) { engine.addTarget(out, {timed}); syncSet.set(out, timed); }
}
function setSync(mode) {
  if (clock) { clock.stop(); clock.close(); clock = null; }   /* (Stop to every FM-1 first) */
  relay?.close(); relay = null;
  if (leader) { leader.input.removeEventListener?.('midimessage', leaderHear); leader = null; }
  syncSet.clear(); syncMode = 'off';
  if (mode === 'page') {
    syncMode = 'page';
    clock = startClock({bpm: +$('sync-bpm').value, onState: drawSync});
  } else if (mode && mode !== 'off') {
    const d = devices.find(x => portKey(x) === mode);
    if (d) {
      syncMode = mode; leader = d; relay = startRelay({});
      d.input.open?.().catch?.(() => {});
      d.input.addEventListener?.('midimessage', leaderHear);
    }
  }
  syncTargets(); drawSync();
}
function drawSync(note) {
  $('sync-row').hidden = !connected && !devices.length;
  const sel = $('sync-mode');
  const opts = [['off', 'Off'], ['page', 'This page'], ...(devices.length >= 2 ? devices.map((d, i) => [portKey(d), `FM-1 ${i + 1} leads (${d.info.title || 'no LSDj'})`]) : [])];
  sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  sel.value = syncMode;
  $('sync-page').hidden = syncMode !== 'page';
  $('sync-play').setAttribute('aria-pressed', String(!!clock?.running));
  const n = syncSet.size;
  $('sync-note').textContent = typeof note === 'string' ? note
    : syncMode === 'page' ? `${clock?.running ? 'Playing' : 'Stopped'} · clock to ${n} FM-1${n === 1 ? '' : 's'}. On each: LSDj PROJECT › SYNC = KEYBD (the FM-1 sets MIDI at Play and puts it back at Stop, so START on the FM-1 plays by itself in between; 0.9.98-dev.2 also switches SYNC = LSDJ when CLOCK OUT is off), GLO › MIDI › CLOCK IN = ALL or USB; TRANSPORT ON lets Play and Stop start it.`
    : leader ? `${n} FM-1${n === 1 ? '' : 's'} follow${n === 1 ? 's' : ''} the leader, one SYNC DELAY behind. The leader: LSDj SYNC = LSDJ, CLOCK OUT = USB; the others: SYNC = KEYBD (the FM-1 switches it to MIDI while it follows), CLOCK IN = ALL or USB.`
    : '';
}
/* the FM-1s plugged in changed: the clock's targets follow; a leader pulled: Off */
function refreshSync() {
  if (leader && !devices.includes(leader)) { setSync('off'); drawSync('The leading FM-1 went away: the clock is off.'); return; }
  syncTargets(); drawSync();
}
$('sync-mode').onchange = e => setSync(e.target.value);
$('sync-play').onclick = () => { if (clock) { if (clock.running) clock.stop(); clock.start(); drawSync(); } };
$('sync-stop').onclick = () => { if (clock) { clock.stop(); drawSync(); } };
$('sync-bpm').onchange = () => { const v = clock ? clock.setTempo(+$('sync-bpm').value) : clampBpm(+$('sync-bpm').value); $('sync-bpm').value = v; };
$('port-pick').onchange = e => {
  const i = +e.target.value, input = ports.ins[i];
  const output = ports.outs.find(o => o.name === input.name) || ports.outs[i];
  if (input && output) connectTo(input, output);
};

/* ---------- live effects (Perform) ----------
   The FM-1's effects pages as cards. A channel page is a row per knob and a column per channel
   (PU1 PU2 WAV NOI), so all four play at once; a control shared by all channels sits once under
   the four. Each control is named with the knob that plays it there. Two or three choices:
   buttons; more: a list; ranges: a slider. A control the FM-1 just changed flashes. */
let cursorCh = 0, lastLive = null, bpm = 120, sendTimer = null;
/* The page the FM-1 shows (LIVE; a master page while FX is held there), the channel page it showed
   last, the mutes and whether this firmware takes them from the page (FM-1_977 and newer). */
let fm1Page = null, lastChPage = null, mute = 0, muteOk = false, muteTouched = 0;
/* the channel page shown: the FM-1's, unless one is picked here */
let followPage = true, pickPage = 0;
/* all the channel pages at once (FILTER, DRIVE, LFO, LO-FI), the choice kept in this browser */
let allPages = false;
try { allPages = localStorage.getItem('lsdj-burrito-allpages') === '1'; } catch { /* storage blocked: one page */ }
const shownPage = () => followPage ? (lastChPage ?? fx.page) : pickPage;
/* per channel (its own value for each of the four) or one for all */
const perChannel = key => PARAM[key].where === 'ch' || PARAM[key].where === 'q' || PARAM[key].where === 'rvch' || key === 'fxOn';
/* mutes and freeze: live only, through MUTE_SET */
function sendMute(freeze = fx.freeze ? 1 : 0) {
  if (!muteOk || busy || installing()) return;
  muteTouched = Date.now();
  link.muteSet(mute, freeze).catch(e => say('fx-status', e.message, 'bad'));
}
/* 0.9.97 and newer: the reverb (its own word, and from dev.7 the sends word), or null */
async function readReverb() {
  if (fwNum < 997) return null;
  const w = await link.reverbGet();
  return w === null ? null : unpackReverb(w, await link.reverbSendsGet());
}
async function writeReverb(r) {
  await link.reverbSet(packReverb(r));
  if (r.rvSend) await link.reverbSendsSet(packReverbSends(r));
}
/* a file's reverb (an effects file or a backup) onto the FM-1, when both have it */
async function restoreReverb(d) {
  if (d.reverb !== undefined && fx.reverb) await link.reverbSet(d.reverb);
  if (d.reverbSends !== undefined && fx.reverb?.rvSend) await link.reverbSendsSet(d.reverbSends);
}
async function reverbWords(data) {   /* into a file */
  const w = fwNum >= 997 ? await link.reverbGet() : null; if (w === null) return;
  data.reverb = w;
  const s = await link.reverbSendsGet(); if (s !== null) data.reverbSends = s;
}
/* 0.9.97 and newer: a game controller on this page plays LSDj (lsdj/gamepad.js): the one chosen under Controller
   (or every one connected), each with its own buttons (Controller buttons), kept in this browser */
let pad = null, padMaps = loadMaps(), padPick = loadPick(), padInfo = null, padList = [], capturing = null;
const GB_LABEL = {UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', A: 'A', B: 'B', START: 'START', SELECT: 'SELECT'};
/* The controller whose buttons the page shows: the one playing, else the one chosen, else a standard one */
const shownPad = () => padInfo || padList.find(p => p.id === padPick) || {id: '', name: 'Game controller', standard: true, hat: -1};
const namer = info => (info?.standard === false ? c => inputName(c, false) : c => inputName(c));
function startPad() {
  const any = fwNum >= 997 || devices.some(d => firmwareNumber(d.info.firmware) >= 997);
  $('pad-status').hidden = false;
  $('pad-pick-row').hidden = $('pad-map-box').hidden = !any;
  if (!any) {
    pad?.(); pad = null; capturing = null; padInfo = null; drawPadTargets();
    say('pad-status', `Game controller: needs LSDJ Burrito 0.9.97 or newer on the FM-1 (this one has ${fwId}).`); return;
  }
  if (!pad) {   /* (it keeps running across switches: controllers on "the FM-1 in use" move with it) */
    capturing = null; padInfo = null;
    pad = startGamepad({send: padSend, canSend: k => !busy && !installing() && !connecting && !!padLinkFor(k),
                        status: t => say('pad-status', t), getPick: () => padPick, getMap: info => mapFor(padMaps, info), getTarget: padTarget,
                        onPads: (list, used) => { padList = list; padInfo = used; drawPadPick(); drawPadTargets(); if (!capturing) drawPadMap(); },
                        onHeld: (codes, info) => drawPadHeld(codes, info), onRaw: raw => drawPadRaw(raw)});
  }
  drawPadPick(); drawPadMap(); drawPadTargets();
}
/* Which FM-1 each controller plays: 'current' (the one in use; the default), an FM-1 of the list (its port key), or
   'none'. By the controller's index|id (two alike share an id); this visit only (list places change on a replug).
   One on a fixed FM-1 stays there through switches and Follow, and its presses do not count for Follow. */
const padTargets = new Map(), padLinks = new Map(), padAt = new Map();
const padKey = info => `${info.index}|${info.id}`;
const curKey = () => !connected ? null : virtual ? 'virtual' : current ? portKey(current) : null;
function padTarget(info) {
  const v = padTargets.get(padKey(info)) || 'current';
  if (v === 'current') return curKey();
  if (v === 'none') return null;
  if (devices.some(d => portKey(d) === v)) return v;
  padTargets.set(padKey(info), 'none'); queueMicrotask(drawPadTargets);   /* its FM-1 was pulled: it plays nothing */
  return null;
}
/* a target's link: the one in use, else its watcher's, else a small one of its own (0.9.97 and newer only) */
function padLinkFor(key) {
  if (key == null) return null;
  /* not while the page connects: a Link made now on that FM-1's input takes its replies from the one being connected
     (current is set only once INFO answers), and Connect said "did not answer" with the cable fine (Colin's Log) */
  if (connecting) return null;
  if (key === curKey()) return connected && fwNum >= 997 ? link : null;
  const d = devices.find(x => portKey(x) === key);
  if (!d || firmwareNumber(d.info.firmware) < 997) return null;
  const w = watchers.get(d);
  if (w) return w.link;
  let l = padLinks.get(d);
  if (!l) { l = new Link(d.input, d.output); padLinks.set(d, l); }
  return l;
}
function closePadLink(d) { const l = padLinks.get(d); if (l) { padLinks.delete(d); l.close(); } }
async function padSend(mask, key) {
  const l = padLinkFor(key);
  if (!l) throw new LinkError('That FM-1 is not available.');
  if (key !== curKey()) padAt.set(key, Date.now());
  await l.padSet(mask);
}
function drawPadTargets() {
  const box = $('pad-targets');
  const show = !!pad && devices.length >= 2 && padList.length > 0;
  box.hidden = !show;
  if (!show) return;
  const twin = id => padList.filter(p => p.id === id).length > 1;
  box.replaceChildren(...padList.map(info => {
    const row = document.createElement('label'), sel = document.createElement('select');
    sel.append(new Option('The FM-1 in use', 'current'));
    devices.forEach((d, i) => {
      const o = new Option(devLabel(d, i), portKey(d));
      if (firmwareNumber(d.info.firmware) < 997) { o.disabled = true; o.textContent += ' (needs 0.9.97)'; }
      sel.append(o);
    });
    sel.append(new Option('Nothing', 'none'));
    sel.value = padTargets.get(padKey(info)) || 'current';
    sel.onchange = () => { padTargets.set(padKey(info), sel.value); pad?.refresh(); };
    row.append(`${info.name}${twin(info.id) ? ` (${info.index + 1})` : ''} plays`, sel);
    return row;
  }));
}
function drawPadPick() {
  const sel = $('pad-pick'), opts = [['', 'Any controller']], seen = new Set();
  for (const p of padList) if (!seen.has(p.id)) { seen.add(p.id); opts.push([p.id, `${p.name}${p.standard ? '' : ' (no standard layout)'}`]); }
  if (padPick && !seen.has(padPick)) opts.push([padPick, 'The one chosen before (not connected)']);
  sel.replaceChildren(...opts.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
  sel.value = padPick;
}
$('pad-pick').onchange = e => { cancelCapture(); padPick = e.target.value; savePick(padPick); padInfo = null; pad?.refresh(); drawPadMap();
  say('pad-map-note', '', 'hint'); };
function drawPadHeld(codes, info) {
  const name = namer(info);
  $('pad-held').textContent = !info ? 'Pressed now: (no controller playing)' : `Pressed now: ${codes.length ? codes.map(name).join(', ') : 'nothing'}`;
}
/* everything the browser reports, live: buttons lit when down, each axis's value (and its rest when off centre) */
function drawPadRaw(raw) {
  const box = $('pad-raw');
  if (!raw) { box.textContent = 'Raw input: (no controller playing)'; return; }
  const b = raw.buttons.map((v, i) => `<span class="pad-b${v >= 0.5 ? ' on' : v > 0.05 ? ' part' : ''}" title="Button ${i + 1}: ${v}">${i + 1}</span>`).join('');
  const a = raw.axes.map((v, i) => {
    const hat = raw.hats.includes(i), rest = raw.rest[i] || 0;
    return `<span class="pad-a${!hat && Math.abs(v - rest) > 0.5 ? ' on' : ''}">Axis ${i + 1}${hat ? ' (d-pad)' : ''}: ${v.toFixed(2)}${!hat && rest ? ` (rests ${rest.toFixed(2)})` : ''}</span>`;
  }).join('');
  box.innerHTML = `<div class="pad-bs">Buttons ${b || 'none'}</div><div class="pad-as">${a || 'No axes'}</div>`;
}
$('pad-recentre').onclick = () => { pad?.recentre(); say('pad-map-note', 'Re-centred: where every stick, trigger and d-pad is now is its rest.', 'hint'); };
function setPadMap(map, note) {
  padMaps = saveMap(padMaps, shownPad(), map); drawPadMap();
  if (note !== undefined) say('pad-map-note', note, 'hint');
}
function drawPadMap() {
  const info = shownPad(), def = defaultMapFor(info), map = mapFor(padMaps, info), name = namer(info);
  $('pad-map-for').textContent = info.id ? `Buttons for ${info.name}${info.standard ? '' : ' (no standard layout: check them)'}:` : 'Buttons for a standard controller:';
  const box = $('pad-map'); box.replaceChildren();
  for (const k of GB_ORDER) {
    const label = document.createElement('span'); label.textContent = GB_LABEL[k]; box.append(label);
    for (let s = 0; s < SLOTS; s++) {
      const code = map[k][s] ?? null, here = capturing?.gb === k && capturing?.slot === s;
      const cell = document.createElement('span'); cell.className = 'pad-slot';
      const b = document.createElement('button'); b.type = 'button'; b.dataset.gb = k; b.dataset.slot = s;
      b.textContent = here ? 'Press a button…' : code ? name(code) : '+ add';
      b.title = code ? `${GB_LABEL[k]}: ${name(code)} (click to change)` : `Add a controller button for ${GB_LABEL[k]}`;
      b.classList.toggle('on', here);
      b.onclick = () => (here ? cancelCapture() : startCapture(k, s));
      cell.append(b);
      if (code && !here) {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'pad-clear'; x.textContent = '✕';
        x.title = `Take ${name(code)} off ${GB_LABEL[k]}`; x.setAttribute('aria-label', x.title);
        x.onclick = () => setPadMap(assign(map, k, s, null, def), `${name(code)} no longer presses ${GB_LABEL[k]}.`);
        cell.append(x);
      }
      box.append(cell);
    }
  }
  $('pad-map-reset').disabled = isDefaultMap(map, def);
}
function startCapture(gb, slot) {
  if (!pad) return;
  if (!padInfo) { say('pad-map-note', 'No controller is playing: connect one and press a button on it (or choose it under Controller).', 'warn'); return; }
  capturing = {gb, slot}; drawPadMap();
  say('pad-map-note', `Press the controller button, or push the stick, for ${GB_LABEL[gb]} (Esc or click again: cancel).`, 'hint');
  pad.capture((code, info) => {
    capturing = null;
    const i = info || shownPad(), name = namer(i), map = mapFor(padMaps, i), from = takenFrom(map, gb, code);
    padMaps = saveMap(padMaps, i, assign(map, gb, slot, code, defaultMapFor(i))); drawPadMap();
    say('pad-map-note', `${GB_LABEL[gb]}: ${name(code)}.${from.length ? ` (Moved off ${from.map(k => GB_LABEL[k]).join(' and ')}.)` : ''}`, 'hint');
  });
}
function cancelCapture() { if (!capturing) return; pad?.cancelCapture(); capturing = null; drawPadMap(); say('pad-map-note', '', 'hint'); }
addEventListener('keydown', e => { if (e.key === 'Escape') cancelCapture(); });
$('pad-map-reset').onclick = () => { cancelCapture(); setPadMap(defaultMapFor(shownPad()), 'Back to the default buttons.'); };
const controls = [];   // {key, ch, wrap, set(v)}
function changed() {
  if (busy || installing()) return;
  touched = Date.now();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    sendTimer = null;
    link.fxSet(packFx(fx)).catch(e => say('fx-status', e.message, 'bad'));
    if (fx.reverb) writeReverb(fx.reverb).catch(e => say('fx-status', e.message, 'bad'));
  }, 80);
}
/* one control for one channel (ch: 0-3; a shared control uses 0) */
function control(key, ch) {
  const p = PARAM[key], wrap = document.createElement('div');
  wrap.className = 'fx-ctl'; wrap.dataset.key = key;
  if (perChannel(key)) { wrap.dataset.ch = ch; wrap.dataset.chn = CHANNELS[ch]; }
  const out = document.createElement('output');
  const focused = el => el.ownerDocument.activeElement === el;   // the panel may be in its own window
  let input, set;
  if (p.choices && p.choices.length <= 3) {          // a toggle: one button per choice
    input = document.createElement('div'); input.className = 'seg'; input.setAttribute('role', 'radiogroup');
    const btns = p.choices.map((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('role', 'radio');
      if (p.live && !muteOk) b.disabled = true;      // freeze: set from the page with FM-1_977 and newer
      b.onclick = () => {
        if (p.live) { fx.freeze = i; set(i); sendMute(i); refresh(); return; }
        paramSet(fx, key, ch, i); set(i); changed(); refresh();
      };
      input.append(b); return b;
    });
    set = v => btns.forEach((b, i) => { b.classList.toggle('on', i === v); b.setAttribute('aria-checked', i === v); });
  } else if (p.choices) {                            // a list
    input = document.createElement('select');
    p.choices.forEach((name, i) => input.append(new Option(name, i)));
    input.onchange = () => { paramSet(fx, key, ch, +input.value); changed(); refresh(); };
    set = v => { if (!focused(input)) input.value = v; };
  } else {                                           // a range
    input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 127;
    input.oninput = () => {
      paramSet(fx, key, ch, +input.value); out.textContent = valueText(fx, key, ch, bpm); changed();
      /* the same knob elsewhere (980: echo on MASTER), for the same channel */
      controls.forEach(it => { if (it.key === key && it.ch === ch && it.wrap !== wrap) it.set(+input.value); });
      markIdle();
    };
    set = v => { if (!focused(input)) input.value = v; };
  }
  input.setAttribute('aria-label', perChannel(key) ? `${p.name} ${CHANNELS[ch]}` : p.name);
  wrap.append(input, out);
  const item = {key, ch, set: v => { set(v); out.textContent = valueText(fx, key, ch, bpm); }, wrap};
  controls.push(item);
  return wrap;
}
/* A channel page as four blocks, PU1 PU2 WAV NOI side by side, its rows still lined up across them: each row's
   cells go on the card's grid (--r, --c) over a box per channel (marked for the cursor and mutes as the
   controls are); knobs shared by all channels come after the boxes. Narrow screens keep the rows (CSS).
   With all pages shown (no column heads above them), each box starts with its channel's name. */
function channelBlocks(card, names) {
  const rows = [...card.querySelectorAll(':scope > .fx-row')];
  const shared = r => !!r.querySelector('.fx-ctl.shared');
  const per = rows.filter(r => !shared(r)), top = names ? 3 : 2;
  [...per, ...rows.filter(shared)].forEach((r, i) => { r.style.setProperty('--r', i + top); card.append(r); });
  card.querySelectorAll('.fx-ctl[data-ch]').forEach(w => w.style.setProperty('--c', +w.dataset.ch + 3));
  const first = card.querySelector(':scope > .fx-row');
  CHANNELS.forEach((name, c) => {
    const b = document.createElement('div'); b.className = 'fx-chbox'; b.dataset.ch = c; b.setAttribute('aria-hidden', 'true');
    b.style.setProperty('--c', c + 3); b.style.setProperty('--n', per.length + (names ? 1 : 0));
    card.insertBefore(b, first);
    if (!names) return;
    const l = document.createElement('div'); l.className = 'fx-chname'; l.dataset.ch = c; l.textContent = name;
    l.style.setProperty('--c', c + 3);
    card.insertBefore(l, first);
  });
  card.classList.add('blocks');
}
function buildFx() {
  controls.length = 0;
  const box = $('fx-pages'); box.replaceChildren();
  const masterBox = $('fx-master-pages'); masterBox.replaceChildren();
  $('fx-master').hidden = !fx.v3;   // FM-1_975 and newer: shared pages apart
  pagesForFx(fx, fwNum).forEach((pg, i) => {
    if (pg.v2 && !fx.v2) return;                     // the new pages need alpha 66
    if (pg.rv && !fx.reverb) return;                 // REVERB: 0.9.97 and newer
    const card = document.createElement('div'); card.className = 'fx-card'; card.dataset.page = i;
    const master = isMasterPage(fx, i, fwNum), anyCh = pg.knobs.some(slot => slot && perChannel(slot[1]));
    /* a channel page: a column per channel (the Channels panel's heads). A shared page with a per-channel knob
       (0.9.97: ECHO K1, the send): that knob one line per channel, named, as the Master panel is narrow. */
    const perCh = anyCh && !master;
    if (perCh) card.classList.add('matrix');
    card.innerHTML = `<h3>${pg.name}<span class="fx-who">${anyCh ? '' : 'all channels'}</span><span class="fx-onfm1">on the FM-1's knobs</span></h3>`;
    pg.knobs.forEach((slot, k) => {
      if (!slot) return;
      if (slot[0] === 'rvch' && !fx.reverb?.rvSend) return;   // reverb sends: 0.9.97-dev.7 and newer
      const [where, key] = slot;
      const row = document.createElement('div'); row.className = 'fx-row';
      const p = PARAM[key];
      row.innerHTML = `<span class="knob">K${k + 1}</span><span class="fx-name">${p.name}${(where === 'comp' || where === 'echo') && anyCh ? ' <small>(all)</small>' : ''}</span>`;
      if (perCh && perChannel(key)) CHANNELS.forEach((n, c) => row.append(control(key, c)));
      else if (anyCh && perChannel(key)) CHANNELS.forEach((n, c) => { const w = control(key, c); w.classList.add('chan-line'); row.append(w); });
      else { const w = control(key, 0); if (perCh) w.classList.add('shared'); row.append(w); }
      card.append(row);
    });
    if (perCh) channelBlocks(card, allPages);
    (isMasterPage(fx, i, fwNum) ? masterBox : box).append(card);
  });
  const mutes = $('fx-mutes'); mutes.replaceChildren();
  CHANNELS.forEach((name, n) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.mute = n; b.textContent = name;
    b.disabled = !muteOk; b.title = muteOk ? `Mute or play ${name}` : 'Muting from this page needs FM-1_977 or newer (C4-F4 on the FM-1\'s MASTER page)';
    b.onclick = () => { mute ^= 1 << n; sendMute(); refresh(); };
    mutes.append(b);
  });
  const bar = $('fx-pagebar'); bar.replaceChildren();
  const pageFollow = document.createElement('button'); pageFollow.type = 'button'; pageFollow.id = 'fx-page-follow'; pageFollow.textContent = 'FM-1 page';
  /* All: every channel page at once; picking one page (or FM-1 page) goes back to one at a time */
  const setAll = on => {
    if (on === allPages) return refresh();
    allPages = on;
    try { localStorage.setItem('lsdj-burrito-allpages', on ? '1' : '0'); } catch { /* this visit only */ }
    buildFx();
  };
  pageFollow.title = 'Show the page the FM-1 is on'; pageFollow.onclick = () => { followPage = true; setAll(false); };
  bar.append(pageFollow);
  box.querySelectorAll('.fx-card').forEach(card => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.page = card.dataset.page;
    b.textContent = card.querySelector('h3').firstChild.textContent;
    b.onclick = () => { followPage = false; pickPage = +card.dataset.page; setAll(false); };
    bar.append(b);
  });
  const all = document.createElement('button'); all.type = 'button'; all.id = 'fx-page-all'; all.textContent = 'All';
  all.title = 'Show every channel page at once'; all.setAttribute('aria-pressed', String(allPages));
  all.onclick = () => setAll(!allPages);
  bar.append(all);
  box.classList.toggle('all', allPages);
  $('pan-chans').classList.toggle('allpages', allPages);
  queueFit();
  /* the column heads: the channel, what is on, under the cursor, playing */
  const head = $('fx-channels'); head.replaceChildren(document.createElement('div'), document.createElement('div'));
  CHANNELS.forEach((name, c) => {
    const d = document.createElement('div'); d.className = 'chan'; d.dataset.ch = c;
    d.innerHTML = `<b>${name}</b><small></small>`;
    head.append(d);
  });
  refresh();
}
/* All on a screen of fixed size (CSS --allfit: Perform's stage, the panel in its own window): the pages fill the
   Channels panel, 2 x 2 (a row of four when it is very wide, a column when very tall), and the text is sized, as
   large as fits, so there are no scrollbars. Again whenever the panel changes size. */
function fitAll() {
  const box = $('fx-pages'), panel = $('pan-chans');
  if (!box || !panel) return;
  const win = box.ownerDocument.defaultView;
  const on = allPages && win.getComputedStyle(box).getPropertyValue('--allfit').trim() === '1';
  box.classList.toggle('fit', on); panel.classList.toggle('allfit', on);
  if (!on) { box.style.removeProperty('--allfs'); box.style.removeProperty('--allc'); return; }
  const n = box.querySelectorAll('.fx-card').length;
  const fits = () => panel.scrollHeight <= panel.clientHeight + 1 && panel.scrollWidth <= panel.clientWidth + 1 &&
    [...box.querySelectorAll('.fx-card')].every(c => c.scrollHeight <= c.clientHeight + 1 && c.scrollWidth <= c.clientWidth + 1);
  const largest = cols => {   // the largest text, times the panel's own size, that fits with this many columns
    box.style.setProperty('--allc', cols);
    let lo = .3, hi = 1.6;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      box.style.setProperty('--allfs', mid + 'em');
      if (fits()) lo = mid; else hi = mid;
    }
    return lo;
  };
  /* 2 x 2 unless a row (or a column) of the pages gives clearly larger text */
  let best = {cols: Math.min(2, n), fs: largest(Math.min(2, n))};
  for (const cols of n > 2 ? [n, 1] : []) { const fs = largest(cols); if (fs > best.fs * 1.15) best = {cols, fs}; }
  box.style.setProperty('--allc', best.cols); box.style.setProperty('--allfs', best.fs + 'em');
  if (best.fs < .55) {   // too small to read (a tiny window): the pages as usual, the panel scrolls
    box.classList.remove('fit'); panel.classList.remove('allfit');
    box.style.removeProperty('--allfs'); box.style.removeProperty('--allc');
  }
}
let fitQueued = false, fitWatch = null, fitWin = null;
function queueFit() {
  const panel = $('pan-chans'); if (!panel) return;
  const win = panel.ownerDocument.defaultView;
  if (fitWin !== win) {   // the panel moved to its own window or back: watch it there
    fitWatch?.disconnect();
    fitWatch = new win.ResizeObserver(() => queueFit()); fitWatch.observe(panel); fitWin = win;
  }
  if (fitQueued) return;
  fitQueued = true;
  win.requestAnimationFrame(() => { fitQueued = false; fitAll(); });
}
/* Perform's stage (wide screens): laid out at 1920 x 1080, then scaled to the window as a whole (CSS zoom), so
   every panel keeps its proportions and nothing scrolls on any screen size. */
const STAGE = '(min-width:961px) and (min-height:440px) and (orientation:landscape)';
function stageZoom() {
  const on = document.body.classList.contains('perform') && matchMedia(STAGE).matches && CSS.supports('zoom', '1');
  document.body.classList.toggle('stage-zoom', on);
  if (on) document.body.style.setProperty('--stagez', String(Math.min(innerHeight, innerWidth * 9 / 16) / 1080));
  else document.body.style.removeProperty('--stagez');
  queueFit();
}
addEventListener('resize', stageZoom);
new MutationObserver(stageZoom).observe(document.body, {attributes: true, attributeFilter: ['class']});
/* Everything shown from fx (and the live state): values, the page, the cursor, mutes. */
/* Effects doing nothing now are dimmed (fx-model.js effectActive), so what is on shows at a glance: each control;
   a row whose controls are all idle; a page with nothing on (its title and its button in the page bar). The
   switches (All FX, Channel FX, Freeze) are never dimmed, and don't make a page count as on. */
function markIdle() {
  const pageOn = new Map();
  controls.forEach(it => {
    const on = effectActive(fx, it.key, it.ch), sw = ['master', 'flags'].includes(PARAM[it.key].where);
    it.wrap.classList.toggle('idle', !on);
    const page = it.wrap.closest('.fx-card')?.dataset.page;
    if (page != null) pageOn.set(page, (pageOn.get(page) || false) || (on && !sw));
  });
  $$('.fx-card:not(.dj-card)').forEach(card => {   /* (not the DJ decks' own: dj-fx.js) */
    card.querySelectorAll('.fx-row').forEach(r => {
      const c = [...r.querySelectorAll('.fx-ctl')];
      r.classList.toggle('idle', c.length > 0 && c.every(w => w.classList.contains('idle')));
    });
    card.classList.toggle('idle', pageOn.get(card.dataset.page) === false);
  });
  $$('#fx-pagebar [data-page]').forEach(b => b.classList.toggle('idle', pageOn.get(b.dataset.page) === false));
}
function refresh(hot = []) {
  if (!fx) return;
  controls.forEach(it => it.set(paramGet(fx, it.key, it.ch)));
  markIdle();
  $('fx-master-status').textContent = fx.v3
    ? (fx.bypass ? 'All FX OFF: dry output. Settings are kept; MASTER K1 turns them back on.' : '')
    : 'Older firmware layout: the MASTER page and All FX switch require FM-1_975 or newer.';
  const cards = $$('#fx-pages .fx-card');
  const want = cards.some(card => +card.dataset.page === shownPage()) ? shownPage() : +(cards[0]?.dataset.page ?? 0);
  cards.forEach(card => card.classList.toggle('shown', allPages || +card.dataset.page === want));
  $('fx-page-follow').classList.toggle('on', followPage && !allPages);
  $('fx-page-all').classList.toggle('on', allPages);
  const onFm1 = fm1Page ?? fx.page;
  $$('#fx-pagebar [data-page]').forEach(b => {
    b.classList.toggle('on', !allPages && +b.dataset.page === want);
    b.classList.toggle('fm1', !!lastLive && +b.dataset.page === onFm1);
  });
  $$('#fx-mutes [data-mute]').forEach(b => {
    const playing = !((mute >> +b.dataset.mute) & 1);
    b.classList.toggle('on', playing); b.setAttribute('aria-pressed', String(playing));
  });
  $$('#fx-channels .chan').forEach(d => {
    const n = +d.dataset.ch, tags = [];
    if ((mute >> n) & 1) tags.push('muted');
    if (lastLive && (lastLive.playing >> n) & 1) tags.push('▶');
    d.querySelector('small').textContent = [channelSummary(fx, n), ...tags].join(' · ');
  });
  /* the column under the FM-1's cursor marked; a muted channel's column grey (still adjustable), as the FM-1 does */
  $$('#pan-chans [data-ch], .fx-ctl.chan-line:not(.dj-ctl)').forEach(el => {
    const n = +el.dataset.ch;
    el.classList.toggle('cursor', !!lastLive && n === cursorCh);
    el.classList.toggle('muted', !!((mute >> n) & 1));
  });
  const silent = CHANNELS.filter((n, c) => (mute >> c) & 1);
  $('fx-muted').hidden = !silent.length;
  if (silent.length) $('fx-muted').textContent = `${silent.join(', ')} muted: changes are kept, but you won't hear them until ${silent.length > 1 ? 'they play' : 'it plays'} again ` +
    `(Master${muteOk ? '' : ' needs FM-1_977'}, or C4-F4 on the FM-1's MASTER page).`;
  drawWiring();
  $$('#live-sec .fx-card:not(.dj-card), .pop-body .fx-card:not(.dj-card)').forEach(card => card.classList.toggle('fm1', !!lastLive && +card.dataset.page === onFm1));
  hot.forEach(key => {
    $$(`.fx-ctl[data-key="${key}"]:not(.dj-ctl)`).forEach(el => {
      const row = el.closest('.fx-row'); row.classList.remove('hot'); void row.offsetWidth; row.classList.add('hot');
    });
  });
}
/* ---------- the wiring (lsdj/fx-diagram.js) ----------
   Upright (a column per channel) or across (a row per channel), the choice kept in this browser;
   narrower on a phone. A block opens the effects page it is on, with its channel marked. */
const PHONE = '(max-width:700px), (max-height:480px) and (pointer:coarse)';
let wireDir = 'v', lastWiring = '';
try { if (localStorage.getItem('wiring-direction') === 'h') wireDir = 'h'; } catch { /* storage blocked: upright */ }
function drawWiring() {
  if (!fx) return;
  const box = $('fx-diagram');
  const svg = fxDiagram(fx, {mute, layout: wireDir, compact: wireDir === 'v' && !isOut('wire') && matchMedia(PHONE).matches});
  if (svg !== lastWiring || !box.firstChild) { box.innerHTML = svg; lastWiring = svg; }   // the same: keep keyboard focus
  $$('#wire-dir [data-dir]').forEach(b => { const on = b.dataset.dir === wireDir; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('pan-wire').dataset.size = wireDir === 'h' ? '900x420' : '700x620';   // its own window: shaped to fit
}
matchMedia(PHONE).addEventListener?.('change', drawWiring);
$$('#wire-dir [data-dir]').forEach(b => {
  b.onclick = () => {
    wireDir = b.dataset.dir;
    try { localStorage.setItem('wiring-direction', wireDir); } catch { /* not kept: fine */ }
    drawWiring();
  };
});
/* a block: its page, shown and brought into view (the channel's controls flash) */
function openFromWiring(blk) {
  if (!fx || !blk?.dataset.go) return;
  const ch = blk.dataset.ch === undefined ? null : +blk.dataset.ch;
  const name = pageFor(blk.dataset.go, !fx.v3);
  const i = pagesForFx(fx, fwNum).findIndex(pg => pg.name === name);
  if (i < 0) return;
  const master = isMasterPage(fx, i, fwNum);
  if (!master) { followPage = false; pickPage = i; refresh(); }
  const card = $(master ? 'fx-master-pages' : 'fx-pages')?.querySelector(`.fx-card[data-page="${i}"]`);
  if (!card) return;
  const panel = card.closest('.panel') || card;
  if (panel.ownerDocument !== document) panel.ownerDocument.defaultView.focus();   // in its own window
  else if (!(document.body.classList.contains('perform') && matchMedia('(min-width:900px) and (min-height:440px) and (orientation:landscape)').matches))
    panel.scrollIntoView({behavior: 'smooth', block: 'start'});   // the stage shows every panel already
  const flash = el => { el.classList.remove('picked'); void el.offsetWidth; el.classList.add('picked'); };
  const ctls = ch == null ? [] : [...card.querySelectorAll(`.fx-ctl[data-ch="${ch}"]`)];
  (ctls.length ? ctls : [card]).forEach(flash);
  const first = ctls[0]?.querySelector('input, select, button') || card.querySelector('input, select, button');
  first?.focus({preventScroll: true});
}
$('fx-diagram').addEventListener('click', e => openFromWiring(e.target.closest?.('[data-go]')));
$('fx-diagram').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const blk = e.target.closest?.('[data-go]'); if (!blk) return;
  e.preventDefault(); openFromWiring(blk);
});
/* the phone's quick links: one panel each */
$$('#stage-nav [data-to]').forEach(b => { b.onclick = () => $(b.dataset.to)?.scrollIntoView({behavior: 'smooth', block: 'start'}); });
/* First thing after connecting (FM-1_995): note mode and LSDj's SYNC = KEYBD, until dismissed. */
{ const tip = $('tip-keybd'); let seen = false;
  try { seen = localStorage.getItem('burrito.tipKeybd') === '1'; } catch {}
  if (tip) { tip.hidden = seen;
    $('tip-keybd-ok').onclick = () => { tip.hidden = true; try { localStorage.setItem('burrito.tipKeybd', '1'); } catch {} }; } }
/* the quick link of the panel at the top of the screen is marked */
function markStageNav() {
  const nav = $('stage-nav'); if (!nav || getComputedStyle(nav).display === 'none') return;
  let cur = null;
  for (const b of nav.querySelectorAll('[data-to]')) { const p = $(b.dataset.to);
    if (p?.offsetParent && (!cur || p.getBoundingClientRect().top < innerHeight * .4)) cur = b; }
  nav.querySelectorAll('[data-to]').forEach(b => b.classList.toggle('on', b === cur));
}
addEventListener('scroll', markStageNav, {passive: true}); addEventListener('resize', markStageNav);
/* what changed between two setups (every channel, and the shared effects) */
function changedKeys(a, b) {
  if (!a || !b) return [];
  return Object.keys(PARAM).filter(k => k !== 'freeze' && (PARAM[k].where !== 'q' || b.v2) && (PARAM[k].where !== 'rv' || (a.reverb && b.reverb)) &&
    (PARAM[k].where !== 'rvch' || (a.reverb?.rvSend && b.reverb?.rvSend)) &&
    [0, 1, 2, 3].some(c => paramGet(a, k, c) !== paramGet(b, k, c)));
}
let lastBadges = '';
async function tick() {
  if (!link || busy || !anyVisible() || (virtual && virtualPaused())) return;   /* a paused virtual FM-1 answers nothing */
  if (portGone()) return lost(UNPLUGGED);
  /* the DJ layout: its decks poll their FM-1s (dj-ui.js); this poll only keeps the FM-1 in use known (and lost when
     gone), every other time, without the reverb and theme reads: they queued the deck's own polls behind them on the
     same link, and deck A's jog and beat lights came unevenly (Colin) */
  const dj = stageMode === 'dj';
  if (dj && ++ticks % 2) return;
  try {
    if (!dj && ++ticks % 8 === 0) await followThemeSetting();
    if (!dj && hasPresets && ticks % 8 === 4 && await readPresetList(link)) await reloadConfig();
    const l = (dj && djLive(curKey())) || await link.live();   /* a deck already polls this FM-1: its answer, not another LIVE on the link */
    { const key = liveKey(l); if (lastKey !== null && key !== lastKey) activeAt = Date.now(); lastKey = key; }   /* played: Follow stays */
    const live = unpackFx(l.fx);
    live.reverb = fx.reverb && ticks % 2 === 0 && !dj ? await readReverb()
      : fx.reverb && {...fx.reverb, rvSend: fx.reverb.rvSend && [...fx.reverb.rvSend]};   /* every other poll */
    live.freeze = l.freeze; cursorCh = l.cursor < 4 ? l.cursor : cursorCh; bpm = l.bpm;
    fm1Page = l.page < pagesForFx(live, fwNum).length ? l.page : live.page;
    if (!isMasterPage(live, fm1Page, fwNum)) lastChPage = fm1Page;
    if (Date.now() - muteTouched > 1000) mute = l.mute & 15;
    let hot = [];
    if (Date.now() - touched > 1000) {   /* not while the user is moving a control */
      hot = changedKeys(fx, live);
      fx = live;
    } else if (Date.now() - muteTouched > 1000) fx.freeze = l.freeze;
    lastLive = l; missed = 0;
    refresh(hot);
    const bat = l.battery;   // {bars, usb} or null (lsdj/link.js)
    const badges = `<span class="badge">${pagesForFx(live, fwNum)[fm1Page]?.name || ''}</span><span class="badge">${l.bpm} BPM</span>` +
      (live.bypass ? '<span class="badge">ALL FX OFF</span>' : '') +
      (l.freeze ? '<span class="badge on">FROZEN</span>' : '') +
      (bat ? `<span class="badge" title="The FM-1's battery (3 bars: full)">${bat.usb ? 'USB power' : 'Battery ' + '▮'.repeat(bat.bars) + '▯'.repeat(3 - bat.bars)}</span>` : '');
    if (badges !== lastBadges) { lastBadges = badges; $('live-badges').innerHTML = badges; }
  } catch (e) {   /* a missed poll: try again on the next; LOST_POLLS in a row: the FM-1 is gone */
    if (portGone()) lost(UNPLUGGED);
    else if (e.cause === 'timeout' && ++missed >= LOST_POLLS && silent(link)) lost('The FM-1 stopped answering. Check the cable and that LSDJ Burrito is running, then press Connect.');
  }
}
/* The live poll: one after another, timed by a window on screen (the page, or one of its own
   windows while the page is behind: a hidden window's timers are slowed down) */
let pollGen = 0;
function startPoll(ms) {
  const gen = ++pollGen;
  const next = () => { if (gen === pollGen) visibleWindow().setTimeout(step, ms); };
  const step = () => { if (gen === pollGen) tick().finally(next); };
  next();
}
const stopPoll = () => { pollGen++; };
/* ---------- the FM-1's screen (FM-1_983 and newer) ----------
   Read only while it can be seen (Perform shown, or the screen in its own window, on screen) and
   no other device operation runs; it shares the link with the live poll above. */
function startMirror() {
  mirror?.stop(); mirror = null;
  /* All screens: the FM-1 in use draws in its own tile (lit), else in the one big screen */
  const tile = gridOn() && current && tiles.get(current);
  const box = $('fm1-screen-box'), note = $('fm1-screen-note'), canvas = tile ? tile.canvas : $('fm1-screen');
  box.hidden = !!tile; note.hidden = true;
  mirror = new ScreenMirror(link, canvas, {every: 33, clock: visibleWindow,
    push: fwNum >= 990,   // FM-1_990: the FM-1 sends each new picture by itself
    active: () => connected && !busy && !installing() && seen(canvas) && (isOut('screen') || !$('live-sec').hidden) &&
      stageMode !== 'dj',   /* the DJ layout: each deck shows its FM-1's screen on the same link (one mirror a link) */
    onSupport: ok => {
      if (tile) return;
      box.hidden = !ok; note.hidden = ok;
      if (!ok) note.textContent = `The FM-1's screen shows here with FM-1_983 or newer (this FM-1 runs ${fwId}).`;
    }});
  mirror.start();
}
/* ⇱: a panel in its own window (lsdj/popout.js) */
document.querySelectorAll('#live-sec .panel[data-pop] .pop').forEach(b => {
  const panel = b.closest('.panel');
  b.onclick = () => {
    const [w, h] = (panel.dataset.size || '800x500').split('x').map(Number);
    if (!popOut(panel.dataset.pop, panel, {title: panel.dataset.title, width: w, height: h}))
      say('fx-status', 'The browser blocked the new window: allow pop-ups for this page.', 'warn');
  };
});
onPopChange(() => { if (fx) refresh(); });
$('fx-help-btn').onclick = () => $('fx-help').showModal();
/* A preset brings settings, MIDI options, switches and colours with its effects (the live poll brings the
   effects): read them again */
async function reloadConfig() {
  settings = unpackSettings(await link.settingsGet());
  { const w = await link.midiGet(); midi = w === null ? null : unpackMidi(w); }
  { const w = fwNum >= 979 ? await link.featGet() : null; features = w === null ? null : unpackFeatures(w); }
  theme = await link.themeGet(); customTheme = theme.slice();
  buildSettings(); buildTheme(); pageTheme();
}
initPresets({link: () => link, run, say, download, firmware: () => fwId, afterLoad: reloadConfig});
$('fx-keep').onclick = () => run('fx-status', async () => { await link.fxSet(packFx(fx)); if (fx.reverb) await writeReverb(fx.reverb); await link.store(); say('fx-status', 'Kept on the FM-1.', 'ok'); });

/* ---------- songs ---------- */
async function run(statusId, fn) {
  if (installing()) return say(statusId, 'Wait for the firmware installation to finish.', 'warn');
  if (busy) return; busy = true;
  const buttons = $$('section:not(#rom-step):not(#install-sec):not(#emulator-sec) button, .pop-body button');
  const disabled = buttons.map(b => b.disabled);
  buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { say(statusId, e.message, 'bad'); }
  finally { busy = false; buttons.forEach((b, i) => b.disabled = disabled[i]); $('save-progress').hidden = true; }
}
/* Not connected: connect over USB as the Connect button does, when the FM-1 is found by name. */
/* again: after a pulled cable, the same FM-1 only. Several plugged in and none used yet: none (choose in My FM-1). */
async function connectUsbQuietly({again = false} = {}) {
  if (connected || busy || installing() || usbMidiUnavailable()) return;
  try {
    ports = await midiPorts();
    const found = await scan(), d = choose(found, again);
    if (d) await connectTo(d.input, d.output);
    else if (!again && !found.length && ports.input && ports.output) await connectTo(ports.input, ports.output);
  } catch { /* MIDI blocked or unavailable: the message below says what to do */ }
}
/* Songs & kits › FM-1 › Search: asks Web MIDI, lists every FM-1 plugged in, and uses the one found when there's
   only one (or the one used before). Several: the list says choose. */
async function searchFm1s() {
  const unavailable = usbMidiUnavailable();
  if (unavailable) throw new LinkError(unavailable);
  try { ports = await midiPorts(); }
  catch (e) { throw new LinkError(e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access was blocked. Allow it (with SysEx) for this page.' : e.message); }
  const found = await scan();
  if (!found.length) { drawDevPick(); throw new LinkError('No FM-1 found over USB. Turn it on with LSDJ Burrito running, plug it in with a data cable, then search again.'); }
  if (!connected) { const d = choose(found); if (d) await connectTo(d.input, d.output); }
  drawDevPick();
  if (connected) return virtual ? VIRTUAL : devLabel(current, devices.indexOf(current));
  say('device', `${found.length} FM-1s found: choose one.`, 'warn');
  throw new LinkError(`${found.length} FM-1s found: choose one in the FM-1 list.`);
}
export async function readInstalledCartridge(progress, signal) {
  await connectUsbQuietly();
  if (!link || !connected) throw new LinkError('No FM-1 found over USB. Turn it on and plug it in with a data cable, or connect to the running FM-1 in My FM-1 (choose its MIDI port; with several plugged in, choose the one to read), then try Read from my FM-1 again.');
  if (busy || installing() || sendTimer) throw new LinkError('Wait for the current device operation to finish.');
  const active = link;
  busy = true;
  // Lock all physical controls while leaving the cartridge Cancel button available.
  const controls = $$('section:not(#rom-step):not(#install-sec):not(#emulator-sec) button, section:not(#rom-step):not(#install-sec):not(#emulator-sec) input, section:not(#rom-step):not(#install-sec):not(#emulator-sec) select, .pop-body button, .pop-body input, .pop-body select');
  const disabled = controls.map(el => el.disabled);
  controls.forEach(el => el.disabled = true);
  try {
    const slot = await active.exportCartridge(progress, signal);
    if (link !== active || !connected) throw new LinkError('The connected device changed. Read its cartridge again.');
    return slot;
  } finally {
    busy = false;
    controls.forEach((el, i) => el.disabled = disabled[i]);
  }
}
const progress = () => { const p = $('save-progress'); p.hidden = false; p.value = 0; return (n, t) => { p.max = t; p.value = n; }; };
/* a file to this computer */
function download(bytes, name, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], {type})); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
/* Songs & kits (songs-ui.js): the FM-1's songs and LSDj, read or sent with the same checks as Songs */
async function exclusive(fn) {
  if (installing()) throw new LinkError('Wait for the firmware installation to finish.');
  await connectUsbQuietly();
  if (!link || !connected) throw new LinkError(devices.length > 1
    ? 'Several FM-1s are plugged in: choose one in the FM-1 list above, then try again.'
    : 'No FM-1 connected: choose Search for FM-1s in the FM-1 list above (or connect in My FM-1), or open a .sav file instead.');
  if (busy) throw new LinkError('Another FM-1 operation is running. Wait for it to finish.');
  busy = true;
  try { return await fn(link); } finally { busy = false; }
}
/* a .sav sent to the FM-1 in use: its name on that FM-1's DJ deck (dj-ui.js rememberSav; the CRC says later
   whether the FM-1 still holds it) */
function sentSav(bytes, name) { if (!virtual && current) rememberSav(portKey(current), name, crc32(bytes)); }
setSongsHooks({
  readSave: pr => exclusive(l => l.exportSave(pr)),
  sendSave: (bytes, pr) => exclusive(async l => {
    await l.importSave(bytes, pr);
    const from = songsState().from;
    sentSav(bytes, from && from !== 'the FM-1' ? from : 'Songs sent from this page');
  }),
  readRom: async pr => romFromSlot(await readInstalledCartridge(pr)),
  cartInfo: () => exclusive(l => l.cartridgeInfo()),
  /* the FM-1 list in Songs & kits: returns the label of the FM-1 now in use */
  pickDevice: async v => {
    if (installing()) throw new LinkError('Wait for the firmware installation to finish.');
    if (busy) { drawDevPick(); throw new LinkError('Another FM-1 operation is running. Wait for it to finish.'); }
    if (v === 'scan') return searchFm1s();
    const d = devices[+v];
    if (v === '' || v === 'virtual' || !d) { drawDevPick(); return null; }
    await switchTo(d);
    drawDevPick();
    if (!connected || !sameDev(d, current)) throw new LinkError('That FM-1 did not answer. Check it is on with LSDJ Burrito running, then choose it again.');
    return devLabel(d, devices.indexOf(d));
  },
});
mountSongsUi($('songtools'));
/* Songs & kits opened while not connected: look for FM-1s by itself when MIDI is already allowed (no prompt).
   One found (or the one used before): it's used; several: the FM-1 list there shows them. */
async function songsAutoConnect() {
  if (location.hash !== '#songtools' || connected || busy || installing() || usbMidiUnavailable()) return;
  try { if ((await navigator.permissions?.query({name: 'midi', sysex: true}))?.state !== 'granted') return; } catch { return; }
  await connectUsbQuietly();
  drawDevPick();
}
addEventListener('hashchange', () => void songsAutoConnect());
void songsAutoConnect();

/* ---------- Perform's DJ layout (lsdj/dj-ui.js) ----------
   Effects | DJ at the top of Perform (kept in this browser). The DJ layout clocks its decks itself, so Perform ›
   Clock goes off when a deck starts. Its FM-1s: the one in use, or another plugged in (its watcher's link, or a
   small link of its own, as a game controller's). */
function djLinkFor(key) {
  if (key == null) return null;
  /* not while the page connects: a Link made now on that FM-1's input takes its replies from the one being connected
     (current is set only once INFO answers), and Connect said "did not answer" with the cable fine (Colin's Log) */
  if (connecting) return null;
  if (key === curKey() && !virtual) return connected ? link : null;
  const d = devices.find(x => portKey(x) === key);
  if (!d) return null;
  const w = watchers.get(d);
  if (w) return w.link;
  let l = padLinks.get(d);
  if (!l) { l = new Link(d.input, d.output); padLinks.set(d, l); }
  return l;
}
setDjHooks({
  devices: () => devices.map((d, i) => ({key: portKey(d), label: `FM-1 ${i + 1}: ${d.info.title || 'no LSDj'}`, fw: d.info.firmware, title: d.info.title, crc: d.info.saveCrc,
    presets: !!d.info.presets})),
  linkFor: djLinkFor,
  outputFor: key => devices.find(x => portKey(x) === key)?.output || null,
  access: () => ports?.access || null,
  takeClock: () => { if (syncMode !== 'off') { setSync('off'); drawSync('The DJ layout clocks the FM-1s now: Clock here is off.'); } },
  /* a deck's FM-1 screen: a mirror of its own on the deck's link, as Perform › Screen (paused there meanwhile) */
  screen: (key, l, canvas, onSupport) => {
    const d = devices.find(x => portKey(x) === key);
    const fw = d ? firmwareNumber(d.info.firmware) : 0;
    if (fw && fw < 983) { onSupport(false); return null; }
    const m = new ScreenMirror(l, canvas, {every: 33, clock: visibleWindow, push: fw >= 990, onSupport,
      active: () => stageMode === 'dj' && !busy && !installingHere(key) && !connecting && seen(canvas) && djLinkFor(key) === l});
    m.start();
    return m;
  },
});
mountDj($('dj-root'));
/* an install pauses this FM-1's deck screen: Install's, everything; the DJ crate's, only the FM-1 it updates */
function installingHere(key) { const t = installTarget(); return installing() && (t === null || t === key); }

/* The DJ crate (crate-ui.js): one FM-1 takes a .sav or an LSDj while the others play on. Its link is the deck's
   own (djLinkFor). For an install the page lets go of that FM-1 only; the others keep their links. */
const devOf = key => devices.find(x => portKey(x) === key) || null;
function crateLink(key) {
  if (key === curKey() && busy) throw new LinkError('Another operation is running on that FM-1. Wait for it to finish.');
  const l = djLinkFor(key);
  if (!l) throw new LinkError(connecting ? 'Wait a moment: the page is connecting to an FM-1.' : 'That FM-1 is gone. Choose it for the deck again.');
  return l;
}
setCrateHooks({
  access: () => ports?.access || null,
  ports: key => { const d = devOf(key); return d ? {input: d.input.id, output: d.output.id} : null; },
  otherPorts: key => devices.filter(d => portKey(d) !== key).flatMap(d => [d.input.id, d.output.id]),
  release: key => {
    const d = devOf(key);
    if (!d) return;
    if (connected && !virtual && sameDev(d, current)) {   /* as before Install's install, for this FM-1 only */
      stopPoll(); link?.close(); link = null; connected = false; lostAt = 0;
      enable(false); say('device', 'Disconnected: the DJ crate is installing on this FM-1. Connect again when it is done.', 'hint');
    }
    unwatch(d); closePadLink(d);
  },
  rescan: async () => (await scan()).map(d => ({key: portKey(d), title: d.info.title})),
  readSave: (key, pr) => crateLink(key).exportSave(pr),
  readRom: async (key, pr) => romFromSlot(await crateLink(key).exportCartridge(pr)),
  sendSave: async (key, bytes, name, pr) => { await crateLink(key).importSave(bytes, pr); rememberSav(key, name, crc32(bytes)); },
  info: key => crateLink(key).info(),
  volumeFull: async key => { try { await djLinkFor(key)?.volumeSet(127); } catch { /* older firmware, or gone: full at its next start */ } },
}, {});
let stageMode = 'fx';
try { if (localStorage.getItem('lsdj-burrito-stage') === 'dj') stageMode = 'dj'; } catch { /* Effects */ }
function setStageMode(m) {
  stageMode = m === 'dj' ? 'dj' : 'fx';
  try { localStorage.setItem('lsdj-burrito-stage', stageMode); } catch { /* this visit only */ }
  document.body.classList.toggle('dj', stageMode === 'dj');
  $$('#stage-mode [data-mode]').forEach(b => { const on = b.dataset.mode === stageMode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  djShown(stageMode === 'dj');
  queueFit();
}
$$('#stage-mode [data-mode]').forEach(b => { b.onclick = () => setStageMode(b.dataset.mode); });
setStageMode(stageMode);
/* The three exports (each its own file): songs, the installed LSDj (read back from the FM-1:
   FM-1_974 and newer web-installed builds), the effects setup. Nothing is written to the FM-1. */
async function songsFile() {
  say('save-status', 'Reading songs from the FM-1…');
  return {name: 'lsdj.sav', bytes: await link.exportSave(progress())};
}
async function romFile() {
  say('save-status', 'Reading the installed LSDj from the FM-1 (no device writes)…');
  const rom = romFromSlot(await link.exportCartridge(progress()));
  return {name: 'lsdj-installed.gb', bytes: rom};
}
async function fxFile() {
  const data = {format: 'lsdj-burrito-fx', version: 1, firmware: fwId, fx: await link.fxGet()};
  await reverbWords(data);   /* 0.9.97 and newer */
  return {name: 'lsdj-burrito-effects.json', bytes: new TextEncoder().encode(JSON.stringify(data, null, 1))};
}
$('export').onclick = () => run('save-status', async () => {
  const f = await songsFile(); download(f.bytes, f.name);
  say('save-status', 'Exported lsdj.sav.', 'ok');
});
$('export-rom').onclick = () => run('save-status', async () => {
  const f = await romFile(); download(f.bytes, f.name);
  say('save-status', 'Exported lsdj-installed.gb: the LSDj installed on the FM-1, for your own use. Kit banks left out at install are empty in it.', 'ok');
});
$('export-fx').onclick = () => run('save-status', async () => {
  const f = await fxFile(); download(f.bytes, f.name, 'application/json');
  say('save-status', 'Exported the effects setup (all pages, every channel).', 'ok');
});
$('export-all').onclick = () => run('save-status', async () => {
  const files = [await songsFile(), await fxFile()];
  let note = '';
  try { files.splice(1, 0, await romFile()); }
  catch (e) { note = ` The installed LSDj was left out: ${e.message}`; }
  download(zipStore(files), `lsdj-burrito-${fwId || 'fm1'}-${stamp()}.zip`, 'application/zip');
  say('save-status', `Exported ${files.map(f => f.name).join(', ')} in one .zip.${note}`, note ? 'warn' : 'ok');
});
$('import-fx-pick').onclick = () => $('import-fx').click();
$('import-fx').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('save-status', async () => {
    let d; try { d = JSON.parse(await file.text()); } catch { throw new LinkError('This is not an effects file.'); }
    const words = d.format === 'lsdj-burrito-fx' && d.version === 1 ? d.fx : d.format === 'lsdj-burrito-backup' && d.version === 1 ? d.fx : null;
    if (!Array.isArray(words) || ![11, 17].includes(words.length)) throw new LinkError('This is not an LSDJ Burrito effects file.');
    const loaded = unpackFx(words);
    if (loaded.v3 && !fx.v3) throw new LinkError('These effects need FM-1_975 or newer firmware.');
    if (d.reverb !== undefined) unpackReverb(d.reverb, d.reverbSends ?? null);   /* checks */
    await link.fxSet(words);
    await restoreReverb(d);
    await link.store();
    fx = unpackFx(await link.fxGet()); fx.reverb = await readReverb(); buildFx();
    say('save-status', `Loaded the effects from ${file.name} and kept them on the FM-1.`, 'ok');
  });
};
$('import-pick').onclick = () => $('import').click();
$('import').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('save-status', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const payload = confirmSaveImport(bytes, file.name, message => confirm(message));
    if (!payload) return say('save-status', 'Import cancelled. Nothing was sent.');
    const note = bytes.length > SAVE_SIZE ? ' The final 16 bytes were excluded with your confirmation; the original file is unchanged.' : '';
    say('save-status', 'Sending songs to the FM-1…' + note);
    await link.importSave(payload, progress());
    sentSav(payload, file.name);
    say('save-status', `Imported ${file.name}. LSDj restarted with it.${note}`, 'ok');
  });
};

/* ---------- colours ---------- */
function buildTheme() {
  const pick = $('theme-preset'); pick.replaceChildren(new Option('the current custom theme', -1));
  THEMES.forEach((n, i) => { if (PRESETS[i]) pick.append(new Option(n, i)); });   // every preset (not Custom)
  pick.onchange = () => { if (+pick.value >= 0) { theme = PRESETS[+pick.value].slice(); drawColors(); } };
  if (settings.theme !== CUSTOM_THEME && PRESETS[settings.theme]) {   // start from the theme the FM-1 shows
    pick.value = settings.theme; theme = PRESETS[settings.theme].slice();
  }
  drawColors();
}
function drawColors() {
  const box = $('theme-colors'); box.replaceChildren();
  COLOR_NAMES.forEach((n, i) => {
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'color'; c.value = toHex(theme[i]); c.oninput = () => { theme[i] = fromHex(c.value); preview(); };
    l.append(n, c); box.append(l);
  });
  preview();
}
function preview() {   /* a sketch of LSDj's song screen with the effects panel, in the theme */
  const cv = $('theme-preview'), g = cv.getContext('2d'), col = i => toHex(theme[i]);
  g.fillStyle = col(3); g.fillRect(0, 0, 160, 96);
  g.font = '8px monospace'; g.textBaseline = 'top';
  g.fillStyle = col(0); g.fillText('FILTER WAV 1/4', 1, 0);
  const vals = ['08', 'LP', '40', '00'], lv = [2, 9, 6, 0];
  for (let k = 0; k < 4; k++) {
    const x = 24 + 24 * k;
    if (k === 2) { g.fillStyle = col(6); g.globalAlpha = .2; g.fillRect(x - 4, 8, 24, 80); g.globalAlpha = 1; }
    g.fillStyle = k === 0 ? col(1) : col(3); if (k === 0) g.fillRect(x, 16, 16, 8);
    g.fillStyle = k === 0 ? col(3) : col(0); g.fillText(vals[k], x + 1, 16);
    for (let i = 0; i < 8; i++) {
      const y = 80 - i * 8;
      if (i < lv[k]) { g.fillStyle = col(1); g.fillRect(x, y, 16, 7); } else { g.fillStyle = col(0); g.fillText('--', x + 1, y); }
    }
  }
  g.fillStyle = col(1); g.fillRect(0, 88, 120, 8); g.fillStyle = col(3); g.fillText('K1 DRIVE 08', 1, 88);
  g.fillStyle = col(2); g.fillRect(128, 0, 32, 96); g.fillStyle = col(0); g.fillText('PU1', 132, 0);
}
/* The page in the FM-1's own theme (lsdj/page-theme.js). The FM-1 can change THEME in its own
   settings (GLO), so the setting is read again every couple of seconds. */
let customTheme = null, deviceThemeId = -1, ticks = 0;
function pageTheme(id = settings.theme) {
  deviceThemeId = id;
  const colours = id === CUSTOM_THEME ? customTheme : PRESETS[id];
  if (colours) showDeviceTheme(colours);
}
async function followThemeSetting() {
  const id = unpackSettings(await link.settingsGet()).theme;
  if (id === deviceThemeId) return;
  if (id === CUSTOM_THEME) customTheme = await link.themeGet();
  settings.theme = id;
  const sel = document.querySelector('#settings-form select[data-key="theme"]');
  if (sel && document.activeElement !== sel) sel.value = id;
  pageTheme(id);
}
$('page-theme').checked = matching();
$('page-theme').onchange = () => { setMatching($('page-theme').checked); if ($('page-theme').checked && connected) pageTheme(); };
$('theme-send').onclick = () => run('theme-status', async () => {
  await link.themeSet(theme);
  settings.theme = 7; await link.settingsSet(packSettings(settings)); buildSettings();
  await link.store();
  customTheme = theme.slice(); pageTheme();
  say('theme-status', 'Sent: the FM-1 now uses THEME: CUSTOM.', 'ok');
});

/* ---------- settings and backup ---------- */
function selects(box, list, obj) {
  list.forEach(s => {
    const l = document.createElement('label'), sel = document.createElement('select');
    s.choices.forEach((c, i) => sel.append(new Option(c, i))); sel.value = obj[s.key];
    sel.dataset.key = s.key;
    sel.onchange = () => { obj[s.key] = +sel.value; };
    l.append(s.name, sel); box.append(l);
  });
}
function buildSettings() {
  const box = $('settings-form'); box.replaceChildren();
  selects(box, SETTINGS, settings);
  if (features) {   // FX panel colours (FM-1_979: FX THEME) right under Theme, as on the FM-1 (SETTINGS / DISPLAY)
    const tmp = document.createElement('div'), theme = box.querySelector('select[data-key="theme"]')?.parentElement;
    selects(tmp, FEATURES.filter(f => f.key === 'fxTheme'), features);
    if (theme) theme.after(...tmp.children); else box.append(...tmp.children);
    if (fwNum >= 981) {   // AUTOSAVE first, as on the FM-1's SETTINGS page
      const as = document.createElement('div');
      selects(as, FEATURES.filter(f => f.key === 'autosave'), features);
      box.prepend(...as.children);
    }
    if (fwNum >= 989) {   // SCREEN RATE under CPU meter, as on the FM-1 (SETTINGS / DISPLAY)
      const sr = document.createElement('div'), meter = box.querySelector('select[data-key="meter"]')?.parentElement;
      selects(sr, FEATURES.filter(f => f.key === 'screenRate'), features);
      if (meter) meter.after(...sr.children); else box.append(...sr.children);
    }
  }
  const mbox = $('midi-form'); mbox.replaceChildren();
  $('midi-sec').hidden = !midi;
  if (midi) selects(mbox, MIDI_SETTINGS, midi);
  const fbox = $('feat-form'); fbox.replaceChildren();
  $('feat-sec').hidden = !features;
  if (features) selects(fbox, FEATURES.filter(f => f.key !== 'fxTheme' && f.key !== 'autosave' && f.key !== 'screenRate' &&
    (f.key !== 'presetGlide' || hasPresets)), features);
}
/* The CC map: per channel, then the shared ones */
{
  const rows = [];
  for (const [scope, title] of [['channel', 'Per channel (PU1 on the first CC FX channel, PU2 the next, then WAV, NOI)'], ['shared', 'Shared (any of the four channels)']]) {
    const th = document.createElement('tr'), cell = document.createElement('th'); cell.colSpan = 2; cell.textContent = title; th.append(cell); rows.push(th);
    for (const [cc, what] of MIDI_CC_MAP.filter(m => m[2] === scope)) {
      const tr = document.createElement('tr'); tr.insertCell().textContent = 'CC ' + cc; tr.insertCell().textContent = what; rows.push(tr);
    }
  }
  $('cc-map').replaceChildren(...rows);
}
$('settings-apply').onclick = () => run('settings-status', async () => {
  await link.settingsSet(packSettings(settings));
  if (midi) await link.midiSet(packMidi(midi));
  if (features) await link.featSet(packFeatures(features));
  await link.store();
  pageTheme();
  say('settings-status', 'Applied and kept on the FM-1.', 'ok');
});
$('backup').onclick = () => run('settings-status', async () => {
  const data = {format: 'lsdj-burrito-backup', version: 1, settings: await link.settingsGet(), fx: await link.fxGet(), theme: await link.themeGet()};
  const m = await link.midiGet(); if (m !== null) data.midi = m;
  if (features) data.features = await link.featGet();
  await reverbWords(data);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'})); a.download = 'lsdj-burrito-backup.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  say('settings-status', 'Backup saved (settings, effects, custom colours). Songs: use Export in Songs.', 'ok');
});
$('restore-pick').onclick = () => $('restore').click();
$('restore').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('settings-status', async () => {
    const d = JSON.parse(await file.text());
    if (d.format !== 'lsdj-burrito-backup' || d.version !== 1 || !Array.isArray(d.fx) || ![11, 17].includes(d.fx.length) || !Array.isArray(d.theme) || d.theme.length !== 8)
      throw new LinkError('This is not an LSDJ Burrito backup.');
    unpackSettings(d.settings);
    const restoredFx = unpackFx(d.fx);
    if (restoredFx.v3 && !fx.v3) throw new LinkError('This effects backup requires FM-1_975 or newer firmware.');
    if (d.midi !== undefined) unpackMidi(d.midi);   /* checks */
    if (d.features !== undefined) unpackFeatures(d.features);
    if (d.reverb !== undefined) unpackReverb(d.reverb, d.reverbSends ?? null);
    await link.themeSet(d.theme); await link.settingsSet(d.settings); await link.fxSet(d.fx);
    await restoreReverb(d);
    if (d.midi !== undefined && midi) await link.midiSet(d.midi);
    if (d.features !== undefined && features) await link.featSet(d.features);
    await link.store();
    settings = unpackSettings(d.settings); fx = unpackFx(await link.fxGet()); fx.reverb = await readReverb(); theme = d.theme;
    if (d.midi !== undefined && midi) midi = unpackMidi(d.midi);
    if (d.features !== undefined && features) features = unpackFeatures(d.features);
    buildSettings(); buildFx(); drawColors();
    customTheme = d.theme.slice(); pageTheme();
    say('settings-status', `Restored ${file.name} and kept it on the FM-1.`, 'ok');
  });
};

/* Installing firmware restarts the FM-1: the page lets go of it first */
setBeforeInstall(async () => {
  if (busy) throw new LinkError('A song or settings operation is running. Wait for it to finish before installing firmware.');
  stopPoll();
  link?.close(); link = null;
  connected = false; lostAt = 0;
  enable(false); say('device', 'Disconnected for the install. Connect again when it is done.', 'hint');
});
