// SPDX-License-Identifier: GPL-3.0-only
// The page's "Songs and kits" section. Open a .sav (a file, or the songs read from the FM-1) to:
//   - see which kit samples each song plays, and which songs play each sample;
//   - manage its songs: save one as .lsdsng, add .lsdsng songs, rename, delete; then download the .sav or send
//     it to the FM-1 (the FM-1's own import, as Songs › Import).
// Kit names come from the user's own LSDj: the one chosen in Install, a ROM file chosen here, or the one on the
// FM-1. Nothing is uploaded; works without an FM-1. Install's kit list shows the same ('songs-usage' event).
// The parsing is lsdj-sav.js, lsdj-kit.js, lsdj-usage.js (tested in node). A save holds 32 songs: songs added past
// that (or past its 191 blocks) are offered to Studio › Build (studio-ui.js, the 'studio-import' event), which makes
// as many cartridges as they take; making cartridges from several saves and songs is there too.
import {parseSav, songBytes, buildSav, readLsdsng, writeLsdsng, nameBytes, nameText, splitSav, SavError, SAV_SIZE, SLOTS, BLOCK_COUNT} from './lsdj-sav.js';
import {zipStore} from './zip.js';
import {kitSlots, kitSampleNibbles, BANK} from './lsdj-kit.js';
import {checkRomFile} from './lsdj-rom.js';
import {kitUsage, usageAcross, romFit, bestRom} from './lsdj-usage.js';
import {addToCrate, cartsFor} from './crate-ui.js';
import {backups, KEEP} from './backups.js';
import {storageState} from './kit-library.js';
import {cartridges, cartName, matchCart, addCartridge} from './cartridges.js';
import {cartPicker} from './carts-ui.js';
import {chooseLsdj} from './choose-lsdj.js';
import {hashOf} from './kit-library.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');

/* the open save: its bytes (as LSDj would read them), its songs (song null: damaged), the kit slots */
/* a crate card's name: the file the songs came from, else its first song */
const crateName = () => (state.from && state.from !== 'the FM-1' ? state.from : state.sav?.songs?.[0]?.name || 'Songs').replace(/\.sav$/i, '');
const state = {sav: null, from: '', items: [], edited: false, slots: null, romFrom: '', romChosen: false};
/* app.js: readSave(progress) -> .sav bytes, sendSave(bytes, progress), readRom(progress) -> ROM bytes (each fails
   with a clear message when no FM-1 is connected or another operation is running) */
let hooks = {readSave: null, sendSave: null, readRom: null, cartInfo: null, pickDevice: null};
export function setSongsHooks(h) { hooks = {...hooks, ...h}; }
/* The FM-1 the buttons here use (app.js fills it: choices [[value, label]], now: the one in use, or '').
   'scan' asks Web MIDI again and searches; picking one switches the page to it, as in My FM-1. */
export function drawSongsDevices(choices, now) {
  const s = $('st-dev');
  if (!s) return;
  const has = choices.some(([v]) => v === now);
  s.replaceChildren(...(has ? [] : [new Option(choices.length ? 'Choose an FM-1…' : 'No FM-1 connected', '')]),
    ...choices.map(([v, t]) => new Option(t, v)), new Option('Search for FM-1s (USB)', 'scan'));
  s.value = has ? now : '';
}
export const songsState = () => state;

/* a progress bar for one FM-1 operation; hidden again afterwards */
async function withProgress(fn) {
  const p = $('st-progress'); p.hidden = false; p.value = 0;
  try { return await fn((n, t) => { p.max = t; p.value = n; }); } finally { p.hidden = true; }
}
const say = (text, cls = 'hint') => { const s = $('st-status'); if (s) { s.textContent = text; s.className = cls; } };

/* names as LSDj shows them; a kit the ROM doesn't have is said plainly */
export function kitLabel(slots, n) {
  if (!slots) return `Kit ${hex(n)}`;
  const s = slots[n];
  if (!s) return `Kit ${hex(n)} (not in this LSDj)`;
  return s.empty ? `Kit ${hex(n)} (empty in this LSDj)` : s.kit.name || `Kit ${hex(n)}`;
}
export function sampleLabel(slots, n, i) {
  const smp = slots?.[n]?.kit?.samples.find(x => x.index === i);
  return smp ? smp.name.replace(/-+$/, '') || `#${i + 1}` : `#${i + 1}`;
}
/* ▶ for one kit sample: plays it as stored, at LSDj's 11468 Hz (no note pitch, loop or effects). None for an
   empty sample. */
export function playButton(bank, index, name) {
  const word = k => bank[2 * k] | bank[2 * k + 1] << 8;
  if (word(index + 1) <= word(index)) return null;
  return el('button', {type: 'button', className: 'play', textContent: '▶', title: `Play ${name}`, ariaLabel: `Play ${name}`,
    onclick: () => guard(async () => (await import('./wav-kit.js')).playNibbles(kitSampleNibbles(bank, index)))});
}
/* a sample's name with its ▶ when the chosen LSDj has the sample */
function sampleChip(k, i) {
  const s = state.slots?.[k], label = sampleLabel(state.slots, k, i);
  const has = state.rom && s?.kit?.samples.some(x => x.index === i);
  return el('span', {className: 'smp'}, has ? playButton(state.rom.subarray(s.bank * BANK, (s.bank + 1) * BANK), i, label) : null, label);
}
const chips = (k, list) => list.flatMap((i, n) => n ? [', ', sampleChip(k, i)] : [sampleChip(k, i)]);
/* the songs the report covers: every readable song, and the working song when no saved song is open */
export function reportSongs(sav, items) {
  const list = items.filter(s => s.song).map(s => ({name: s.name, song: s.song}));
  if (sav.active == null && sav.working.some(b => b)) list.unshift({name: 'UNSAVED', song: sav.working, working: true});
  return list;
}
/* bank -> {used: [songs], maybe: [songs]} for Install's kit list, from the kit numbers in that ROM */
export function usageByBank(rom, usage) {
  const out = new Map();
  if (!rom || !usage) return out;
  for (const s of kitSlots(rom)) {
    const m = usage.get(s.number), used = new Set(), maybe = new Set();
    if (m) for (const e of m.values()) { e.songs.forEach(x => used.add(x)); e.maybe.forEach(x => maybe.add(x)); }
    used.forEach(x => maybe.delete(x));
    out.set(s.bank, {used: [...used], maybe: [...maybe]});
  }
  return out;
}
export const currentUsage = () => state.sav ? usageAcross(reportSongs(state.sav, state.items)) : null;

/* ---- the song list ---- */
function itemsOf(sav) {
  return sav.songs.map(s => {
    let song = null;
    try { song = songBytes(sav, s.slot); } catch (e) { if (!(e instanceof SavError)) throw e; }
    return {slot: s.slot, name: s.name || `SLOT ${s.slot}`, nameBytes: sav.bytes.slice(0x8000 + s.slot * 8, 0x8008 + s.slot * 8), version: s.version, song, blocks: s.blocks};
  });
}
/* after a change: the save built again from the list (damaged songs left out), read back */
function rebuild() {
  const keep = state.items.filter(s => s.song);
  const bytes = buildSav(state.sav.bytes, state.sav.working, keep, state.sav.active);
  const sav = parseSav(bytes);
  state.items = itemsOf(sav); state.sav = sav; state.edited = true;
}
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const fileName = s => `${(s.name || 'song').trim().replace(/[^A-Za-z0-9 _-]/g, '_') || 'song'}.lsdsng`;

function drawSongs(box) {
  const sav = state.sav, used = BLOCK_COUNT - sav.freeBlocks;
  const t = el('table', {className: 'st-table'});
  t.append(el('tr', {}, el('th', {textContent: 'Song'}), el('th', {textContent: 'Size'}), el('th', {textContent: 'Kit samples it plays'}), el('th')));
  const rows = reportSongs(sav, state.items);
  const unsaved = rows.find(r => r.working);
  if (unsaved) t.append(el('tr', {}, el('td', {className: 'mono', textContent: 'UNSAVED'}), el('td', {className: 'hint', textContent: 'open in LSDj'}), samplesCell(unsaved.song), el('td')));
  for (const s of state.items) {
    const btn = (text, title, fn) => el('button', {type: 'button', textContent: text, title, onclick: () => guard(fn)});
    const actions = el('td', {className: 'st-actions'});
    if (s.song) actions.append(
      btn('Save', 'Save this song as an .lsdsng file', () => download(writeLsdsng({nameBytes: s.nameBytes, version: s.version, song: s.song}), fileName(s))),
      btn('Rename', 'Rename (up to 8 letters and numbers)', () => {
        const n = prompt('New name (up to 8 letters and numbers):', s.name); if (n == null) return;
        s.nameBytes = nameBytes(n); s.name = nameText(s.nameBytes); rebuild(); draw(); say(`Renamed to ${s.name}.`, 'ok');
      }));
    actions.append(btn('Delete', 'Take this song out of the save', () => {
      if (!confirm(`Delete ${s.name} from this save? (The file you opened isn't changed.)`)) return;
      state.items = state.items.filter(x => x !== s); rebuild(); draw(); say(`Deleted ${s.name}.`, 'ok');
    }));
    t.append(el('tr', {}, el('td', {className: 'mono', textContent: s.name + (sav.active === s.slot ? ' (open in LSDj)' : '')}),
      el('td', {className: 'hint', textContent: `${s.blocks} block${s.blocks === 1 ? '' : 's'}`}),
      s.song ? samplesCell(s.song) : el('td', {className: 'bad', textContent: 'Damaged in this file: LSDj can\'t open it either. Sending or downloading leaves it out.'}),
      actions));
  }
  box.append(el('h3', {className: 'subhead', textContent: `${state.items.length} song${state.items.length === 1 ? '' : 's'} in ${state.from}${state.edited ? ' (changed here)' : ''}`}),
    el('p', {className: 'hint', textContent: `${used} of ${BLOCK_COUNT} blocks used, ${sav.freeBlocks} free; ${state.items.length} of ${SLOTS} song slots.`}), t);
}
function samplesCell(song) {
  const cell = el('td'), slots = state.slots, {kits} = kitUsage(song);
  if (!kits.size) cell.append(el('span', {className: 'hint', textContent: 'none'}));
  for (const [k, u] of [...kits].sort((a, b) => a[0] - b[0])) {
    const sure = [...u.samples].sort((a, b) => a - b), maybe = [...u.maybe].sort((a, b) => a - b);
    cell.append(el('div', {}, el('b', {textContent: kitLabel(slots, k) + ': '}), ...chips(k, sure),
      maybe.length ? el('span', {className: 'hint'}, `${sure.length ? '; ' : ''}maybe `, ...chips(k, maybe)) : null));
  }
  return cell;
}
function drawKits(box) {
  const slots = state.slots, across = currentUsage();
  const kt = el('table', {className: 'st-table'});
  kt.append(el('tr', {}, el('th', {textContent: 'Kit'}), el('th', {textContent: 'Sample'}), el('th', {textContent: 'Songs that play it'})));
  for (const [k, m] of [...across].sort((a, b) => a[0] - b[0]))
    [...m].sort((a, b) => a[0] - b[0]).forEach(([i, e], row) => kt.append(el('tr', {},
      el('td', {textContent: row ? '' : kitLabel(slots, k)}), el('td', {}, sampleChip(k, i)),
      el('td', {}, [...e.songs].join(', '), e.maybe.size ? el('span', {className: 'hint', textContent: `${e.songs.size ? '; ' : ''}maybe ${[...e.maybe].join(', ')}`}) : null))));
  if (across.size) box.append(el('h3', {className: 'subhead', textContent: 'Samples and the songs that play them'}), kt);
  if (slots) {
    const unused = slots.filter(s => !s.empty && !across.has(s.number)).map(s => s.kit.name || `Kit ${hex(s.number)}`);
    if (unused.length) box.append(el('p', {className: 'hint', textContent: `Kits none of these songs play: ${unused.join(', ')}. ` +
      'Install can leave them out to make room (songs you keep elsewhere may still need them).'}));
  }
  box.append(el('p', {className: 'hint', textContent: '"Maybe": a chain transpose or the instrument\'s table can change which sample plays. ' +
    (state.rom ? '▶ plays a sample on this computer as it is stored in the LSDj, without the song\'s pitch, loop or effects.' :
      'To hear the samples (▶), choose the LSDj the songs were made with: a .sav holds no samples.')}));
}
function draw() {
  const box = $('st-report');
  if (!box) return;
  box.replaceChildren();
  drawNeed();
  for (const id of ['st-add', 'st-download', 'st-send', 'st-crate', 'st-split', 'st-split-crate']) $(id).disabled = !state.sav;
  if (!state.sav) return;
  if (state.needs) box.append(el('p', {className: 'warn', textContent: `These are ${state.needs.title}'s songs. Their kits are in ${state.needs.title}'s LSDj, not in the .sav: ` +
    `install ${state.needs.title}'s LSDj on the FM-1 first, then press Send to the FM-1 (it checks the FM-1 has that LSDj).`}));
  if (state.full) box.append(fullNote());
  drawSongs(box); drawKits(box);
}
/* songs added past what the save holds: offered to Studio › Build with the save's own, all into cartridges */
function fullNote() {
  const f = state.full, n = state.items.length, used = BLOCK_COUNT - state.sav.freeBlocks;
  return el('div', {className: 'st-full', role: 'group', ariaLabel: 'The save is full'},
    el('b', {textContent: `This save is full: ${n} of ${SLOTS} songs${n < SLOTS ? `, ${used} of ${BLOCK_COUNT} blocks` : ''}. ` +
      `The other ${f.files.length === 1 ? 'song' : `${f.files.length} songs`} you added didn't go in.`}),
    el('p', {textContent: `A save holds ${SLOTS} songs, but cartridges don't stop there: Studio › Build puts all ${n + f.files.length} into as many cartridges as it takes, each with every sample its songs play.`}),
    el('div', {className: 'row'},
      el('button', {type: 'button', className: 'primary', textContent: `Make cartridges from all ${n + f.files.length} in Build →`, onclick: () => guard(async () => toBuild())}),
      el('button', {type: 'button', textContent: `Keep these ${n} only`, onclick: () => { state.full = null; draw(); say(''); }})),
    el('p', {className: 'hint', textContent: `Not added: ${f.names.join(', ')}`}));
}
async function toBuild() {
  const name = /\.sav$/i.test(state.from) ? state.from : `${state.from || 'songs'}.sav`;
  const list = [new File([state.sav.bytes], name), ...state.full.files];
  /* the LSDj the kit names come from: kept once in this browser, so Build has it too */
  if (state.rom) list.push(new File([state.rom], /\.gbc?$/i.test(state.romFrom) ? state.romFrom : 'LSDj chosen in Songs and kits.gb'));
  state.full = null; draw();
  document.dispatchEvent(new CustomEvent('studio-import', {detail: {files: list}}));
}
/* asks for the LSDj the songs were made with when it's needed: none chosen yet, or the one chosen lacks kits
   the songs play (made with another LSDj, or with kits of their own) */
const kitList = ms => [...new Set(ms.map(m => m.kit))].map(k => `${kitLabel(state.slots, k)} (${[...new Set(ms.filter(m => m.kit === k).flatMap(m => m.songs))].join(', ')})`).join('; ');
function drawNeed() {
  const p = $('st-rom'), usage = currentUsage();
  const kits = usage ? [...usage.keys()].sort((a, b) => a - b) : [];
  if (!state.slots) {
    p.className = state.sav && kits.length ? 'warn' : 'hint';
    p.textContent = state.sav && kits.length
      ? `These songs play kits ${kits.map(hex).join(', ')}. Choose the LSDj they were made with (a .gb file, or read it from the FM-1) to see kit and sample names and check they're all there.`
      : 'Kit names come from your LSDj: choose it here or in Install, or read it from the FM-1.';
    return;
  }
  const fit = usage ? romFit(state.slots, usage) : null;
  p.className = fit && !fit.ok ? 'warn' : 'hint';
  p.textContent = `Kit names from ${state.romFrom}. ` + (!fit ? '' :
    fit.ok ? `It has every kit these songs play.` :
    `It doesn't have kits these songs play: ${kitList(fit.kits)}. They were probably made with another LSDj ` +
    '(other kits, or the same kits in another order) or with kits of their own: choose that LSDj (you can pick several .gb files; the page uses the one that fits best). ' +
    'Installing this one, those songs play nothing there.') +
    (fit?.empty.length ? ` Some notes play sample slots their kit leaves empty (silent in LSDj too): ${kitList(fit.empty)}.` : '');
}
const missingKits = fit => { const n = new Set(fit.kits.map(m => m.kit)).size; return n ? `${n} kit${n === 1 ? '' : 's'} missing` : 'every kit is there'; };
/* several .gb files: each checked against the songs; the best fit is used */
export function probeRoms(roms) {
  const usage = currentUsage();
  const list = roms.map(r => ({...r, slots: kitSlots(r.rom)})).filter(r => r.slots.length);
  if (!list.length) throw new SavError('None of these files has LSDj sample kits.');
  const {best, fits} = usage ? bestRom(list, usage) : {best: list[0], fits: []};
  useRom(best.rom, best.name);
  if (fits.length > 1) say(`Checked ${fits.length} files: ${best.name} fits best` +
    ` (${missingKits(best.fit)}). ` + fits.slice(1).map(f => `${f.name}: ${missingKits(f.fit)}`).join('; ') + '.', best.fit.ok ? 'ok' : 'warn');
  else say(`Kit names from ${best.name}.`, 'ok');
}
function announce() {
  draw();
  document.dispatchEvent(new CustomEvent('songs-usage', {detail: {usage: currentUsage()}}));
}

/* ---- opening ---- */
/* needs: for a cartridge's .sav made in Studio › Build, {title, dataCrc: async () -> its LSDj's slot data CRC} (studio-ui.js) */
export function openSave(bytes, from, needs = null) {
  if (bytes.length === SAV_SIZE + 16) bytes = bytes.subarray(0, SAV_SIZE);   /* (as Songs › Import, which asks first) */
  const sav = parseSav(bytes.slice());
  Object.assign(state, {sav, from, items: itemsOf(sav), edited: false, needs, full: null});
  announce();
  const bad = state.items.filter(s => !s.song).length;
  say(`Opened ${from}: ${sav.songs.length} song${sav.songs.length === 1 ? '' : 's'}` + (bad ? `, ${bad} damaged.` : '.'), bad ? 'warn' : 'ok');
}
/* "Send to the FM-1": asks first; a made cartridge's songs (needs: {title, dataCrc}, studio-ui.js) only after checking
   the FM-1 has that cartridge's LSDj, which holds their kits (a .sav holds no samples) */
export async function sendOpenSave() {
  if (!state.sav) throw new SavError('Open a .sav first.');
  if (!confirm('Replace the songs on the FM-1 with these? Export them first (Songs › Back up) if you want to keep them.')) return false;
  const n = state.needs;
  if (n) {
    let info = null, why = '';
    try { say('Checking which LSDj the FM-1 has…'); info = await hooks.cartInfo(); } catch (e) { why = e.message; }
    if (!info || info.dataCrc !== await n.dataCrc()) {
      const text = info ? `The FM-1 has a different LSDj installed, not ${n.title}'s.` : `Couldn't check which LSDj the FM-1 has (${why}).`;
      say(`${text} ${n.title}'s songs play the kits in ${n.title}'s LSDj (a .sav holds no samples): install it first: ` +
        `in Studio › Build, ${n.title}'s "Install on the FM-1…" does both.`, 'bad');
      if (!confirm(`${text}\n\n${n.title}'s songs play the kits in ${n.title}'s own LSDj; a .sav holds no samples. ` +
        `With another LSDj their kit notes play the wrong samples or none.\n\nSend the songs anyway?`)) return false;
    }
  }
  say('Sending songs to the FM-1…');
  await withProgress(pr => hooks.sendSave(state.sav.bytes, pr));
  say('Sent. LSDj restarted with these songs.', 'ok');
  return true;
}
/* A made cartridge's songs that follow its LSDj: after the next successful install (install-ui.js
   'firmware-installed') they are sent by themselves, once the restarted FM-1 answers and reports that LSDj. The user
   agreed to replace the FM-1's songs when starting (studio-ui.js, Install on the FM-1…). Anything else installed:
   nothing is sent. */
let pending = null;
export function sendAfterInstall(bytes, from, needs) {
  openSave(bytes, from, needs);
  pending = {bytes: bytes.slice(), needs};
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function sendPending() {
  if (!pending) return;
  const {bytes, needs} = pending;
  pending = null;
  location.hash = '#songtools';
  say(`Installed. Waiting for the FM-1 to start, then sending ${needs.title}'s songs…`);
  const want = await needs.dataCrc();
  let info = null, why = '';
  for (let n = 0; n < 20 && !info; n++) {
    try { info = await hooks.cartInfo(); } catch (e) { why = e.message; await wait(1500); }
  }
  if (!info) return say(`Couldn't reach the FM-1 after the install (${why}). Press Send to the FM-1 here (it has ${needs.title}'s songs open) when it's connected.`, 'warn');
  if (info.dataCrc !== want) return say(`The FM-1 now has a different LSDj, not ${needs.title}'s (kits unticked in Install, or another file), so its songs were not sent.`, 'warn');
  let done = false;
  for (let n = 0; n < 5 && !done; n++) {
    try { await withProgress(pr => hooks.sendSave(bytes, pr)); done = true; } catch (e) { why = e.message; await wait(1500); }
  }
  say(done ? `Done: ${needs.title}'s LSDj and songs are on the FM-1.` : `Installed, but sending the songs failed (${why}). Press Send to the FM-1 here (it has ${needs.title}'s songs open) to try again.`, done ? 'ok' : 'bad');
}
/* chosen: picked here (a file or the FM-1's), which a ROM chosen later in Install doesn't replace */
/* songs read from the FM-1: kit names from the cartridge it has, when it's kept here and none was chosen */
async function namesFromFm1() {
  if (state.romChosen || !hooks.cartInfo) return;
  try {
    const m = await matchCart((await hooks.cartInfo()).dataCrc);
    if (m) { useRom(m.cart.bytes, `${cartName(m.cart)} (what the FM-1 has)`); return; }
  } catch { /* can't tell: names come from an LSDj chosen here */ }
}
/* one song per save (lsdj-sav.js splitSav): each song alone in a save of its own, open, so LSDj starts on it */
const savName = (s, i, all) => `${String(i + 1).padStart(String(all.length).length, '0')} ${(s.name || 'song').trim().replace(/[^A-Za-z0-9 _-]/g, '_') || 'song'}.sav`;
function splitSongs() {
  const list = splitSav(state.sav.bytes);
  if (!list.length) throw new SavError('No saved songs to split: save the song in LSDj first (the open, unsaved song is not one of them).');
  return list;
}
/* the LSDj for a cartridge of these songs: asked (choose-lsdj.js), the one chosen here picked first */
async function lsdjFor(title) {
  const prefer = state.rom && state.romChosen ? await hashOf(state.rom) : null;
  return chooseLsdj({title, savs: [state.sav.bytes], prefer, action: 'Use this LSDj'});
}
async function splitDownload() {
  const list = splitSongs(), c = await lsdjFor(`these ${list.length} songs`);
  if (!c) return say('Nothing was exported: a cartridge needs its LSDj.', 'warn');
  say('Making each song\'s cartridge (only the kits and samples it plays, when the whole LSDj is too big for the FM-1)…');
  const carts = await cartsFor({name: crateName(), rom: c.bytes, sav: state.sav.bytes, each: true});
  const files = carts.flatMap((s, i, all) => { const n = savName(s, i, all).replace(/\.sav$/, ''); return [{name: `${n}/${n}.gb`, bytes: s.rom}, {name: `${n}/${n}.sav`, bytes: s.sav}]; });
  download(zipStore(files), `${crateName().replace(/[^A-Za-z0-9 _-]/g, '_') || 'songs'} - a cartridge per song.zip`);
  say(`${list.length} cartridge${list.length === 1 ? '' : 's'} in a .zip, one a song: a folder each with ${c.name} as NAME.gb and the song as NAME.sav, opening on its song.`, 'ok');
}
async function splitCrate() {
  const list = splitSongs(), c = await lsdjFor(`these ${list.length} songs`);
  if (!c) return say('Nothing was added: a cartridge needs its LSDj.', 'warn');
  say('Making each song\'s cartridge (only the kits and samples it plays, when the whole LSDj is too big for the FM-1)…');
  for (const s of await cartsFor({name: crateName(), rom: c.bytes, sav: state.sav.bytes, each: true})) await addToCrate({name: s.name, rom: s.rom, sav: s.sav});
  say(`${list.length} cartridge${list.length === 1 ? '' : 's'} in the DJ crate (Perform › DJ), one a song with ${c.name}: each loads onto a deck straight into its song.`, 'ok');
}
async function wholeToCrate() {
  const c = await lsdjFor(crateName());
  if (!c) return say('Nothing was added: a cartridge needs its LSDj.', 'warn');
  await addToCrate({name: crateName(), rom: c.bytes, sav: state.sav.bytes});
  say(`In the DJ crate (Perform › DJ) with ${c.name}: drag it onto a deck, or press Load.`, 'ok');
}
/* a cartridge (Cartridges, or the picker here) for the kit names */
function useCart(c) { useRom(c.bytes, cartName(c)); say(`Kit names from ${cartName(c)}.`, 'ok'); }
export function useRom(rom, from, chosen = true) {
  state.rom = rom ?? null; state.slots = rom ? kitSlots(rom) : null; state.romFrom = from; state.romChosen = chosen;
  announce();
}
/* .lsdsng songs into the open save, in order, until it is full (32 songs or its 191 blocks); the ones after that are
   kept aside (state.full) and offered to Studio › Build, which takes them all */
export async function addLsdsng(files) {
  const added = [], left = [];
  for (const f of files) {
    const s = readLsdsng(new Uint8Array(await f.arrayBuffer()));
    if (left.length || state.items.length >= SLOTS) { left.push({file: f, name: s.name}); continue; }
    const before = state.items;
    state.items = [...before, {slot: null, name: s.name, nameBytes: s.nameBytes, version: s.version, song: s.song}];
    try { rebuild(); } catch (e) {
      state.items = before;
      if (!(e instanceof SavError)) throw e;
      left.push({file: f, name: s.name}); continue;
    }
    added.push(s.name);
  }
  state.full = left.length ? {files: [...(state.full?.files ?? []), ...left.map(x => x.file)], names: [...(state.full?.names ?? []), ...left.map(x => x.name)]} : state.full;
  draw(); announce();
  if (left.length) say(`${added.length ? `Added ${added.join(', ')}. ` : ''}The save is full: ${left.length === 1 ? 'one song' : `${left.length} songs`} didn't go in. Build can take them all.`, 'warn');
  else say(`Added ${added.join(', ')}.`, 'ok');
}
/* an LSDj chosen here, kept with the cartridges (Studio › Build and Install use them); never one made by the cart
   makers (their LSDj holds only some kits: cart-built, studio-ui.js) */
export async function rememberRom(rom, name, from = 'file') {
  let made = [];
  try { made = JSON.parse(localStorage.getItem('cart-built') || '[]') || []; } catch { /* none kept */ }
  if (made.includes(await hashOf(rom))) return;
  await addCartridge(rom, name, {from});
}

async function guard(fn) { try { await fn(); } catch (e) { say(e.message, 'bad'); } }
/* the song backups (backups.js: made before songs are sent to an FM-1, the last KEEP per FM-1): open one here
   (then send it back, or save it), or download it */
async function drawBackups() {
  if (!$('st-backup-list')) return;
  const list = await backups();
  const box = $('st-backup-list'), sum = $('st-backups')?.querySelector('summary');   /* (again: redrawn meanwhile) */
  if (!box || !sum) return;
  sum.textContent = `Song backups (${list.length}): what an FM-1 held before songs were sent to it, the last ${KEEP} per FM-1`;
  box.replaceChildren(list.length ? el('ul', {className: 'st-backups'}, ...list.map(f => el('li', {},
    el('span', {textContent: f.name + ' '}),
    el('button', {type: 'button', textContent: 'Open', title: 'Open these songs here: then send them back, or save them', onclick: () => guard(async () => openSave(f.bytes, `Backup: ${f.name}`))}),
    el('button', {type: 'button', textContent: 'Download .sav', onclick: () => download(f.bytes, `${f.name.replace(/[^\w .-]+/g, '-')}.sav`)}))))
    : el('p', {className: 'hint', textContent: 'None yet. Before songs are sent to an FM-1, what it holds is kept here first.'}));
}
/* this browser's storage, when it doesn't keep things (a private window, full, refused): said, not hidden */
async function drawStorage() {
  if (!$('st-storage')) return;
  const s = await storageState(), p = $('st-storage');
  if (!p) return;
  const full = s.quota && s.used != null && s.used / s.quota > 0.9;
  const text = s.trouble || (!s.kept ? 'This browser keeps no files for this page: your LSDj files, songs and backups last only until it closes.'
    : full ? `This browser's storage for this page is nearly full (${Math.round(s.used / 1048576)} of ${Math.round(s.quota / 1048576)} MB): new backups and files may not be kept.` : '');
  p.textContent = text; p.hidden = !text;
}
export function mountSongsUi(root) {
  const file = (accept, multiple, f) => {
    const i = el('input', {type: 'file', accept, multiple, hidden: true});
    i.onchange = () => { const x = [...i.files]; i.value = ''; if (x.length) guard(() => f(x)); };
    return i;
  };
  const savIn = file('.sav', false, async ([f]) => openSave(new Uint8Array(await f.arrayBuffer()), f.name));
  const romIn = file('.gb,.gbc', true, async fs => {
    const roms = await Promise.all(fs.map(async f => {
      const rom = new Uint8Array(await f.arrayBuffer());
      try { checkRomFile(rom, f.name); } catch (e) { throw new SavError(e.message); }
      return {name: f.name, rom};
    }));
    probeRoms(roms);
    for (const r of roms) if (kitSlots(r.rom).length) await rememberRom(r.rom, r.name);
  });
  const songIn = file('.lsdsng', true, addLsdsng);
  const b = (text, fn, props = {}) => el('button', {type: 'button', textContent: text, onclick: () => guard(fn), ...props});
  const dev = el('select', {id: 'st-dev', ariaLabel: 'The FM-1 to read from and send to', title: 'The FM-1 to read from and send to'});
  dev.onchange = () => guard(async () => {
    const v = dev.value;
    if (v === 'scan') say('Looking for FM-1s over USB…');
    const label = await hooks.pickDevice?.(v);
    if (label) say(`Reading and sending use ${label}.`, 'ok');
  });
  root.replaceChildren(
    el('p', {className: 'hint', textContent: 'Which kit samples your songs play, and which songs play each sample; save songs one by one, add, rename or delete them. Works on a .sav file without the FM-1. Nothing is uploaded.'}),
    el('div', {className: 'row'}, el('label', {className: 'row'}, 'FM-1 ', dev)),
    el('div', {className: 'row'},
      b('Open a .sav…', () => savIn.click()), savIn,
      b('Read songs from the FM-1', async () => { say('Reading songs from the FM-1…'); openSave(await withProgress(hooks.readSave), 'the FM-1'); await namesFromFm1(); }),
      b('Add .lsdsng songs…', () => songIn.click(), {id: 'st-add', disabled: true}), songIn,
      b('Download .sav', () => download(state.sav.bytes, 'lsdj.sav'), {id: 'st-download', disabled: true}),
      b('Send to the FM-1', sendOpenSave, {id: 'st-send', disabled: true}),
      b('Add to the DJ crate', wholeToCrate,
        {id: 'st-crate', disabled: true, title: 'These songs and their LSDj, as one cartridge in the DJ crate, to load onto a deck while the other plays'})),
    el('div', {className: 'row'}, el('span', {className: 'hint', textContent: 'A cartridge per song: '}),
      b('Download them (.zip)', splitDownload, {id: 'st-split', disabled: true, title: 'Each song alone in its own .sav (open, so LSDj starts on it) with its LSDj: a folder a song, NAME.gb and NAME.sav'}),
      b('Each song to the DJ crate', splitCrate, {id: 'st-split-crate', disabled: true, title: 'A crate cartridge per song, with its LSDj: each loads onto a deck straight into its song'})),
    el('div', {className: 'row'},
      b('Choose your LSDj (.gb)…', () => romIn.click(), {title: 'Pick one, or several: the one that fits these songs best is used'}), romIn,
      b('Read LSDj from the FM-1', async () => { say('Reading the installed LSDj from the FM-1 (no writes)…'); const rom = await withProgress(hooks.readRom); useRom(rom, 'the LSDj on the FM-1'); await rememberRom(rom, `LSDj read from the FM-1 ${new Date().toLocaleDateString([], {dateStyle: 'medium'})}.gb`, 'fm1'); say('Kit names read from the FM-1.', 'ok'); }),
      cartPicker({id: 'st-cart', label: 'From my cartridges', onPick: useCart})),
    el('p', {id: 'st-rom', className: 'hint'}),
    el('progress', {id: 'st-progress', value: 0, max: 1, hidden: true}),
    el('p', {id: 'st-status', className: 'hint', role: 'status'}),
    el('div', {id: 'st-report'}),
    el('p', {id: 'st-storage', className: 'warn', hidden: true}),
    el('details', {id: 'st-backups'}, el('summary', {textContent: 'Song backups'}), el('div', {id: 'st-backup-list'})),
    el('p', {className: 'st-tobuild'}, el('span', {className: 'hint', textContent: 'Making cartridges from several saves and songs, with every sample they play, is in one place: '}),
      el('a', {href: '#studio', textContent: 'Studio › Build'}), '.'));
  drawSongsDevices([], '');
  void drawBackups(); void drawStorage();
  document.addEventListener('kit-library', () => void drawBackups());
  document.addEventListener('kit-library-trouble', () => void drawStorage());
  document.addEventListener('firmware-installed', () => guard(sendPending));
  document.addEventListener('songs-this-cart', e => guard(async () => {
    const c = (await cartridges()).find(x => x.id === e.detail.id);
    if (!c) throw new SavError('That cartridge is no longer kept in this browser.');
    useCart(c);
  }));
  document.addEventListener('install-rom', e => { if (e.detail?.rom && !state.romChosen) useRom(e.detail.rom, `the LSDj chosen in Install (${e.detail.name})`, false); });
  draw();
}
