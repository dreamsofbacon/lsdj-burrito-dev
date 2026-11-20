// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate (Perform › DJ, under the decks): saves and LSDj ROMs to load onto one deck's FM-1 while the other
// deck plays on. A .sav goes over that FM-1's link (only it pauses, as Songs › Send does). An LSDj is installed on
// that FM-1 alone (install.js installOn: nothing is sent to the other FM-1s, the other decks' gear or the mixer),
// then a paired .sav follows. lsdj/crate.js holds the list; the files stay in this browser (kit-library.js).
import {KEY, fileKind, loadItems, saveItems, addItem, removeItem, renameItem, pairItems, unusedSaves, describe,
  recolorItem, setImage, unusedImages, moveItem, viewItems, formatOfTitle, installedFm1} from './crate.js';
import {labelEditor, paintLabel, shrinkImage, imageUrl, isHex} from './cart-label.js';
import {opens, needsText} from './lsdj-sets.js';
import {libraryFiles, addToLibrary, removeFromLibrary} from './kit-library.js';
import {listKits, crc32, planRom} from './lsdj-rom.js';
import {withOpenSong, savBody, splitSav, HEADER, HEADER_SIZE} from './lsdj-sav.js';
import {openCartMaker, fitInWorker} from './cart-maker.js';
import {logEvent} from './conn-log.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {installOn, checkPackage, REPLUG} from './install.js';
import {installing, setInstallTarget} from './install-ui.js';
import {chooseLsdj} from './choose-lsdj.js';
import {matchCart, notePrint} from './cartridges.js';
import {zipStore} from './zip.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};

/* app.js: access() -> MIDIAccess, ports(key) -> {input, output} port ids, otherPorts(key) -> every other FM-1's port
   ids, release(key) (the page lets go of that FM-1), rescan() -> [{key, title}] the FM-1s found, readSave(key, pr),
   readRom(key, pr), sendSave(key, bytes, name, pr), info(key) -> the link's INFO, volumeFull(key), cartInfo(key) -> its
   CART_INFO (which LSDj it has).
   dj-ui.js: decks() -> [{i, name, kind, key}], stop(i) (its clock, Play, Sync), assign(i, key), avoid(i) -> the
   other decks' and the mixer's port ids, loading(i, text | null, done, total). */
let app = {}, dj = {};
export function setCrateHooks(a, d) { app = {...app, ...a}; dj = {...dj, ...d}; }

let items = loadItems(store.get(KEY, '[]')), files = new Map(), root = null, statusEl = null, busyDeck = -1, pairFrom = null;
/* the card asking before a load ({id, i}) or a removal ({id, remove: true}); the search, the sort */
let asking = null, query = '', sort = store.get('dj-crate-sort', 'mine'), view = store.get('dj-crate-view', 'cards') === 'songs' ? 'songs' : 'cards';
/* what the crate last loaded on each FM-1 (its key): {id, slot, crc}, for the ON A / ON B badges (a song chosen makes
   another .sav than the card's, so its checksum alone won't say which card) */
let loadedOn = (() => { try { return JSON.parse(store.get('dj-crate-on', '{}')) || {}; } catch { return {}; } })();
const save = () => store.set(KEY, saveItems(items));
const say = (text, cls = 'hint') => { if (statusEl) { statusEl.textContent = text; statusEl.className = `${cls} crate-status`; } };
async function refreshFiles() { files = new Map((await libraryFiles()).map(f => [f.id, f])); }
const bytesOf = id => files.get(id)?.bytes || null;

/* a ROM and a save (bytes) -> a crate item; used by Songs & kits, Sets and New cart… too. color: a preset or
   #rrggbb; img: a picture's bytes (cart-label.js shrinkImage). A cartridge is never made without its LSDj (Colin):
   songs given alone ask which LSDj goes with them (choose-lsdj.js; prefer: a cartridge id to pick first). -> the
   item, or null (cancelled: nothing added). An LSDj alone is a cartridge with no songs yet. */
export async function addToCrate({name, rom = null, sav = null, color = 'grey', img = null, prefer = null, from = 'made'}) {
  if (!rom && !sav) return null;
  if (!rom) {
    const c = await chooseLsdj({title: name, savs: [sav], prefer, action: 'Add to the crate'});
    if (!c) return null;
    rom = c.bytes; from = 'file';
  }
  /* an LSDj too big for the FM-1 (all its kits): made smaller for its songs, as the cart maker does */
  if (sav && !(await fitsAsIs(rom))) {
    say(`${name}: making its LSDj fit the FM-1 (only the kits and samples its songs play)…`);
    const carts = await cartsFor({name, rom, sav});
    let first = null;
    for (const c of carts) { const it = await keep({...c, color, img, from: 'made'}); first ??= it; }
    fitSaid(name, carts);
    return first;
  }
  return keep({name, rom, sav, color, img, from});
}
/* the FM-1's slot for LSDj (template.json), once */
let capacityP = null;
const capacity = () => capacityP ??= fetch('lsdj/template.json').then(r => r.json()).then(m => Number.isInteger(m?.cartridge_capacity) ? m.cartridge_capacity : 502016).catch(() => 502016);
let capacityNow = null; void capacity().then(c => { capacityNow = c; fitCache.clear(); drawList(); });
/* does this LSDj, all its kits in, fit the FM-1? (then a card keeps it whole: an FM-1 that has it takes only songs) */
const fitCache = new Map();
function fitsNow(rom, id = null) {
  if (capacityNow == null) return true;   /* (not known yet: said once it is) */
  if (id && fitCache.has(id)) return fitCache.get(id);
  let ok = true;
  try { ok = planRom(rom, listKits(rom).map(k => k.bank), capacityNow).fits; } catch { ok = true; }
  if (id) fitCache.set(id, ok);
  return ok;
}
async function fitsAsIs(rom) { await capacity(); return fitsNow(rom); }
/* songs (a .sav) and an LSDj -> cartridges [{name, rom, sav}] that load on the FM-1: the LSDj whole when it fits,
   else holding only the kits and samples the songs play (cart-core.js fitCarts, in the cart maker's worker: the
   decks keep time). each: a cartridge a song. Also Songs & kits' cartridge-per-song download. */
export async function cartsFor({name, rom, sav, each = false}) {
  if (await fitsAsIs(rom))
    return each ? splitSav(sav).map(s => ({name: s.name, rom, sav: s.bytes})) : [{name, rom, sav}];
  const out = await fitInWorker({rom, savs: [{name, bytes: sav}], each, cap: await capacity()});
  return out.map((c, k) => ({name: each ? c.songs[0] ?? `${name} ${k + 1}` : out.length > 1 ? `${name} ${k + 1}` : name,
    rom: c.rom, sav: c.sav, fits: c.fits, warnings: c.warnings}));
}
let fitNote = '';   /* (the last fit said, for a message that follows: Open files…) */
function fitSaid(name, carts) {
  const warn = [...new Set(carts.flatMap(c => c.warnings ?? []))], big = carts.filter(c => c.fits === false);
  fitNote = `${name}: ${carts.length > 1 ? `${carts.length} cartridges (the songs' samples need more than one FM-1 holds)` : 'its LSDj made to fit'}, holding only the kits and samples its songs play.` +
    (big.length ? ' Still too big for the FM-1: some songs lose samples.' : '') + (warn.length ? ` ${warn.slice(0, 3).join(' ')}` : '');
  say(fitNote, warn.length || big.length ? 'warn' : 'ok');
}
/* a card too big to load (made before cartridges were fitted): made to fit now, its card keeping its name and label */
async function makeFit(item) {
  const rom = bytesOf(item.rom), sav = bytesOf(item.sav);
  if (!rom || !sav) return say(`${item.name}: its file is no longer in this browser. Nothing was changed.`, 'bad');
  say(`${item.name}: making its LSDj fit the FM-1 (only the kits and samples its songs play)…`);
  try {
    const carts = await cartsFor({name: item.name, rom, sav}), before = items;
    const [first, ...more] = carts;
    const r = await addToLibrary('rom', `${first.name}.gb`, first.rom, {from: 'made'}), s = await addToLibrary('sav', `${first.name}.sav`, first.sav, {crc: crc32(first.sav)});
    items = items.map(i => i.id === item.id ? {...i, rom: r.id, sav: s.id} : i); save();
    for (const c of more) await keep({...c, color: item.color, from: 'made'});
    await tidy(before); drawList();
    fitSaid(item.name, carts);
  } catch (e) { say(`${item.name}: couldn't make it fit (${e.message}). Nothing was changed.`, 'bad'); }
}
async function keep({name, rom, sav = null, color = 'grey', img = null, from = 'made'}) {
  const r = await addToLibrary('rom', `${name}.gb`, rom, {from});
  const s = sav ? await addToLibrary('sav', `${name}.sav`, sav, {crc: crc32(sav)}) : null;   /* (crc: backups.js knows it kept) */
  const p = img ? await addToLibrary('img', `${name}.jpg`, img) : null;
  items = addItem(items, {name, rom: r?.id || null, sav: s?.id || null, color, img: p?.id || null});
  save(); await refreshFiles(); setOpen(true); draw();
  return items.find(i => i.rom === r.id && i.sav === (s?.id || null)) ?? null;
}
/* does a deck's FM-1 have this LSDj already (its CART_INFO matches this cartridge, cartridges.js)? Then a card's
   songs go alone, in seconds, as before every card had its LSDj; else the LSDj is installed first. false: it hasn't,
   or can't tell */
async function hasLsdj(key, romId) {
  try { return (await matchCart((await app.cartInfo(key)).dataCrc, null, {only: [romId]}))?.cart.id === romId; } catch { return false; }
}
/* a card that has songs but no LSDj (made before cartridges needed one): its LSDj chosen now */
async function completeItem(item) {
  const sav = bytesOf(item.sav);
  const c = await chooseLsdj({title: item.name, savs: sav ? [sav] : [], action: 'Put it in this cartridge'});
  if (!c) return;
  const r = await addToLibrary('rom', `${item.name}.gb`, c.bytes);
  items = items.map(i => i.id === item.id ? {...i, rom: r.id} : i); save(); await refreshFiles(); drawList();
  say(`${item.name}: a whole cartridge now, with ${c.name}.`, 'ok');
  if (sav && !(await fitsAsIs(c.bytes))) await makeFit(items.find(i => i.id === item.id));
}
/* complete cartridges (an LSDj and its songs) out as files: each a folder with NAME.gb and NAME.sav (the same name,
   so emulators and flash carts pair them). Cards without an LSDj are left out (said). */
const safeName = t => String(t || 'cartridge').trim().replace(/[^A-Za-z0-9 _().-]+/g, '_').slice(0, 60) || 'cartridge';
function cartFiles(item, folder = '') {
  const n = safeName(item.name), rom = bytesOf(item.rom), sav = item.sav ? bytesOf(item.sav) : null;
  if (!rom) return null;
  return [{name: `${folder}${n}.gb`, bytes: rom}, ...(sav ? [{name: `${folder}${n}.sav`, bytes: sav}] : [])];
}
function downloadZip(files, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([zipStore(files)], {type: 'application/zip'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function exportCart(item) {
  const f = cartFiles(item);
  if (!f) return say(`${item.name} has no LSDj: choose its LSDj first. Nothing was exported.`, 'warn');
  downloadZip(f, `${safeName(item.name)}.zip`);
  say(`${item.name}: its LSDj and songs, as ${safeName(item.name)}.gb and .sav in a .zip.`, 'ok');
}
function exportAll() {
  const done = [], left = [], files = [], used = new Set();
  for (const i of items) {
    let dir = safeName(i.name);
    for (let k = 2; used.has(dir.toLowerCase()); k++) dir = `${safeName(i.name)} ${k}`;
    const f = cartFiles(i, `${dir}/`);
    if (!f) { left.push(i.name); continue; }
    used.add(dir.toLowerCase()); files.push(...f); done.push(i.name);
  }
  if (!done.length) return say('No complete cartridges to export: each needs its LSDj. Nothing was exported.', 'warn');
  downloadZip(files, 'lsdj-cartridges.zip');
  say(`Exported ${done.length} cartridge${done.length === 1 ? '' : 's'} (each a folder with its .gb and .sav).` +
    (left.length ? ` Left out, no LSDj: ${left.join(', ')}. Press Choose its LSDj on them to include them.` : ''), left.length ? 'warn' : 'ok');
}
/* files no item uses any more, out of the library (saves and pictures: ROMs are shared with Sets) */
async function tidy(before) {
  /* (an LSDj the crate made smaller for a card's songs goes with its last card; your own LSDj files stay) */
  const madeRoms = [...new Set(before.map(i => i.rom).filter(Boolean))].filter(r => !items.some(i => i.rom === r) && files.get(r)?.from === 'made');
  for (const id of [...unusedSaves(items, before), ...unusedImages(items, before), ...madeRoms]) await removeFromLibrary(id);
  await refreshFiles();
}
/* a card's label: its colour, its picture (Picture…: made small here, kept in this browser) */
const labelOpen = new Set();
async function setPicture(item, file) {
  try {
    const bytes = await shrinkImage(file), p = await addToLibrary('img', `${item.name}.jpg`, bytes);
    const before = items; items = setImage(items, item.id, p.id); save(); await tidy(before);
    say(`${item.name}: picture set.`, 'ok');
  } catch (e) { say(`${item.name}: ${e.message}`, 'bad'); }
  drawList();
}

async function openFiles(list) {
  const byName = new Map();
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer()), kind = fileKind(bytes), name = f.name.replace(/\.(sav|gbc?)$/i, '');
    if (!kind) { say(`${f.name} is neither an LSDj save nor an LSDj ROM.`, 'warn'); continue; }
    const e = byName.get(name.toLowerCase()) ?? {name};
    e[kind] = kind === 'sav' ? savBody(bytes).slice() : bytes;   /* (a save's footer left out) */
    byName.set(name.toLowerCase(), e);
  }
  /* lsdj.gb with lsdj.sav: one cartridge; a .sav alone asks which LSDj goes with it */
  let n = 0;
  fitNote = '';
  for (const e of byName.values()) if (await addToCrate({...e, from: 'file'})) n++;
  if (n) say(`${n} cartridge${n === 1 ? '' : 's'} in the crate.${fitNote ? ` ${fitNote}` : ''}`, 'ok');
}

/* after songs are sent: does that FM-1 hold them once LSDj has started on them? -> {bad: what to say} when it doesn't,
   else {crc: its save's checksum now (the deck's badge)}. The page said "has" as soon as the transfer ended before;
   an FM-1 that kept or changed its songs (another LSDj, older firmware) said nothing.
   The whole save's checksum is no test: COMMIT already checked every byte arrived, and LSDj then rewrites its working
   song (the save's first 32 KiB) as it starts, so it differed after every load that worked (Colin's DJ test,
   2026-11-17: "doesn't hold the songs sent" with the song playing). The songs' header (names, versions, the open song,
   the block table) is read back instead: an LSDj that kept its own songs or cleared them changes it. */
const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');
export async function checkHeld(key, sav, deck, hooks = app, pause = wait) {
  await pause(2500);   /* (LSDj restarted on the songs) */
  let info = null, head = null;
  try { info = await hooks.info?.(key); } catch (e) { return {bad: `couldn't ask that FM-1 what it holds now (${e.message})`}; }
  if (!info || info.saveCrc === crc32(sav)) return {crc: info?.saveCrc ?? null};
  try { head = await hooks.readSaveAt(key, HEADER, HEADER_SIZE); } catch (e) { return {bad: `couldn't read back what that FM-1 holds now (${e.message})`}; }
  const at = head.findIndex((b, i) => b !== sav[HEADER + i]);
  if (at < 0) return {crc: info.saveCrc};
  const what = `${info.title || 'its LSDj'}, firmware ${info.firmware || '?'}`;
  logEvent(`Deck ${deck}: songs sent, but the FM-1 (${what}) holds different ones (its song list differs from byte 0x${(HEADER + at).toString(16)}; ` +
    `whole save checksum ${hex8(info.saveCrc)}, sent ${hex8(crc32(sav))}).`);
  return {bad: `the FM-1 (${what}) doesn't hold the songs sent: its LSDj may have kept or changed them. See the Log`};
}
const fm1Decks = () => (dj.decks?.() || []).filter(d => d.kind === 'fm1' && d.key != null);
/* the LSDj a deck's FM-1 has: the cartridge kept here that it matches (nothing read), else read from it */
async function deckLsdj(d) {
  try {
    const m = await matchCart((await app.cartInfo(d.key)).dataCrc, null, {only: []});   /* (saved CRCs only: B plays on) */
    if (m) return {rom: m.cart.bytes, kept: true};
  } catch { /* older firmware, or can't tell: read it */ }
  return {rom: await app.readRom(d.key, (n, t) => dj.loading?.(d.i, 'Copying its LSDj (2 of 2)…', n, t)), kept: false};
}
async function grab(d) {
  if (busyDeck >= 0) return;
  busyDeck = d.i; draw();
  try {
    const sav = await app.readSave(d.key, (n, t) => dj.loading?.(d.i, 'Copying its songs (1 of 2)…', n, t));
    const {rom, kept} = await deckLsdj(d);
    const title = (await app.info?.(d.key).catch(() => null))?.title;
    await addToCrate({name: `Deck ${d.name}${title ? ` ${title}` : ''} ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`, rom, sav, from: 'fm1'});
    say(`Deck ${d.name}'s songs and LSDj are in the crate as one cartridge${kept ? ' (its LSDj from your cartridges: nothing more read)' : ''}.`, 'ok');
  } catch (e) { say(`Deck ${d.name}: ${e.message}`, 'bad'); }
  finally { busyDeck = -1; dj.loading?.(d.i, null); draw(); }
}

/* the firmware for a crate ROM, with all its kits (as Install starts) */
async function prepare(rom) {
  const r = await fetch('lsdj/versions.json', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw Error(`Version catalogue unavailable (${r.status}).`);
  const versions = await r.json(), {template, metadata} = await loadTemplate();
  try {
    return await prepareLsdjFirmware(rom, listKits(rom).map(k => k.bank), template, metadata, {versions, experimental: true});
  } catch (e) {
    if (/only \d+ are available/.test(e.message)) throw Error('This LSDj with all its kits is too big for the FM-1: press Make it fit on its card (only the kits its songs play), or prepare it in Install, leaving some kits out. Nothing was installed.');
    throw e;
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* item -> deck i: one FM-1 stops and takes it; the other deck carries on. Asked first on the card itself (askLoad)
   or by holding Load: never with the browser's confirm(), which stops the whole page, the other deck's MIDI clock
   included, so its FM-1 stopped too (Colin's test). */
export async function loadOnto(id, i, slot = null) {
  const item = items.find(x => x.id === id), d = (dj.decks?.() || [])[i];
  asking = null;
  if (!item || !d) return draw();
  if (d.kind !== 'fm1' || d.key == null) { draw(); return say(`Deck ${d.name}: choose an FM-1 for it first.`, 'warn'); }
  if (busyDeck >= 0 || installing()) { draw(); return say('Another FM-1 is loading. Wait for it to finish.', 'warn'); }
  await refreshFiles();
  let rom = item.rom && bytesOf(item.rom), sav = item.sav && bytesOf(item.sav), label = item.name;
  if ((item.rom && !rom) || (item.sav && !sav)) { draw(); return say(`${item.name}: its file is no longer in this browser. Add it again.`, 'bad'); }
  /* its FM-1 has this LSDj already: only the songs go (nothing installed) */
  if (rom && await hasLsdj(d.key, item.rom)) {
    if (!sav) { draw(); return say(`Deck ${d.name}'s FM-1 already has ${item.name}'s LSDj: nothing to load.`, 'ok'); }
    rom = null;
  }
  if (sav && slot != null) {   /* straight into the chosen song */
    try { const song = describe(item, bytesOf).songList.find(x => x.slot === slot); sav = withOpenSong(sav, slot); label = `${item.name} › ${song?.name ?? slot}`; }
    catch (e) { draw(); return say(`${item.name}: ${e.message}`, 'bad'); }
  }
  const loaded = (key, crc) => { loadedOn[key] = {id: item.id, slot, crc: crc ?? crc32(sav)}; store.set('dj-crate-on', JSON.stringify(loadedOn)); };
  busyDeck = i; draw();
  const show = (text, n, t) => { dj.loading?.(i, text, n, t); say(`Deck ${d.name}: ${text}`, 'hint'); };
  const leave = e => { e.preventDefault(); e.returnValue = ''; };
  let wake = null, released = false, failed = false, backKey = null;
  try {
    if (!rom) {
      dj.stop?.(i);
      show('Sending the songs…');
      await app.sendSave(d.key, sav, label, (n, t) => show('Sending the songs…', n, t));
      show('Checking the FM-1 holds them…');
      const {bad, crc} = await checkHeld(d.key, sav, d.name);
      if (bad) return say(`Deck ${d.name}: sent "${label}", but ${bad}.`, 'bad');
      loaded(d.key, crc); dj.songLoaded?.(i);
      say(`Deck ${d.name} has "${label}".`, 'ok');
      return;
    }
    show('Preparing the firmware…');
    const pkg = await prepare(rom);
    const target = app.ports(d.key);
    if (!target) throw Error('That FM-1 went away. Nothing was installed.');
    /* the DJ's other ports (the mixer's, an outside master clock, other decks): never this deck's FM-1 itself. Windows
       numbers ports again (output-3 is whichever device came third), so a mixer port kept from another day can carry
       this FM-1's id now: it stopped every crate install with "in use elsewhere" (Colin's Log, a77f551). */
    const own = id => id === target.input || id === target.output, djPorts = dj.avoid?.(i) || [];
    if (djPorts.some(own)) logEvent(`Deck ${d.name}: the DJ layout also has this FM-1's port (${djPorts.filter(own).join(', ')}) as its mixer, master clock or another deck's; left out for this install.`);
    const avoid = [...app.otherPorts(d.key), ...djPorts.filter(id => !own(id))];
    if (avoid.some(own)) throw Error('Another FM-1 shows up on the same port as this one. Unplug the others and try again. Nothing was installed.');
    const others = new Set((await app.rescan()).map(x => x.key).filter(k => k !== d.key));
    await app.volumeFull?.(d.key);   /* it comes back at full volume whatever happens */
    dj.stop?.(i); dj.assign?.(i, '');
    app.release(d.key); released = true;
    addEventListener('beforeunload', leave);
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
    setInstallTarget(d.key);
    const names = {found: 'Found its FM-1', stage: 'Preparing the update (nothing changed yet)', loader: 'Restarting into update mode',
      write: 'Writing the firmware: keep the cable in', restart: 'Written. Restarting', done: 'Installed', replug: REPLUG.update, 'replug-back': REPLUG.back,
      swap: 'Changing only its LSDj (songs saved first): keep the cable in'};
    let step = '', restarted = false;
    logEvent(`Deck ${d.name}: installing "${item.name}" (${pkg.product}) on ${target.output}.`);
    const r = await installOn(app.access(), checkPackage(pkg.bytes), {target, avoid, slot: pkg.slot, build: pkg.build,
      log: t => logEvent(`Deck ${d.name}: ${t}`),
      onStep: s => { step = s; if (s === 'restart' || s === 'loader') restarted = true; logEvent(`Deck ${d.name}: ${names[s] || s}.`);
        show(s.startsWith('replug') ? names[s] : `${names[s]}…`); },
      onProgress: (n, t) => show(`${names[step === 'swap' ? 'swap' : 'write']}…`, n, t)});
    setInstallTarget(null);
    /* what that FM-1 reports now: kept with the card's cartridge, so its next load knows (cartridges.js) */
    if (pkg.slot) void notePrint(item.rom, new DataView(pkg.slot.buffer, pkg.slot.byteOffset).getUint32(16, true) >>> 0, listKits(rom).map(k => k.bank)).catch(() => {});
    /* the restarted FM-1: the one found now that wasn't there before (none restarted: it already had this LSDj) */
    await wait(1500);
    const now = await app.rescan(), fresh = now.filter(x => !others.has(x.key));
    /* unsure whether another FM-1 left meanwhile: the one new FM-1 asked which build it runs (INFO, nothing written) */
    const freshBuild = restarted && !r.confirmed && fresh.length === 1 ? await app.info(fresh[0].key).then(x => x?.build ?? null).catch(() => null) : null;
    const back = installedFm1({restarted, confirmed: r.confirmed, fresh, othersBefore: [...others], nowKeys: now.map(x => x.key),
      build: pkg.build, freshBuild, ownKey: d.key});
    if (back && restarted && !r.confirmed) logEvent(`Deck ${d.name}: the FM-1 on ${back.key} reports the build just installed and no other FM-1 moved: it's this deck's.`);
    /* (fresh: FM-1s on ports that weren't there before the install, not all those plugged in: "found: 1" with two
       plugged in read as one missing, Colin's DJ test) */
    const after = !restarted ? ' (it already had this LSDj)'
      : fresh.length === 1 ? `; it restarted on new ports (${fresh[0].key})`
      : `; FM-1s on new ports after its restart: ${fresh.length} (one expected)`;
    logEvent(`Deck ${d.name}: installed ${r.id}${after}${r.confirmed ? '' : ' (another FM-1 went away meanwhile)'}.`);
    if (!back) {
      say(`Installed ${r.id}, but the page can't tell which FM-1 restarted${r.confirmed ? '' : ' (another FM-1 was unplugged meanwhile)'}. ` +
        `Choose it for deck ${d.name}${sav ? ', then load the songs' : ''}.`, 'warn');
      return;
    }
    dj.assign?.(i, back.key); backKey = back.key;
    if (sav) {
      show('Sending the songs…');
      await app.sendSave(back.key, sav, label, (n, t) => show('Sending the songs…', n, t));
      show('Checking the FM-1 holds them…');
      const {bad, crc} = await checkHeld(back.key, sav, d.name);
      if (bad) return say(`Deck ${d.name}: installed ${r.id} and sent "${label}", but ${bad}.`, 'bad');
      loaded(back.key, crc);
    }
    dj.songLoaded?.(i);
    say(`Deck ${d.name} has "${label}" (${r.id}).`, 'ok');
  } catch (e) {
    setInstallTarget(null);
    failed = true;
    logEvent(`Deck ${d.name}: loading "${label}" stopped: ${e.message}`);
    say(`Deck ${d.name}: ${e.message}`, e.resumable ? 'warn' : 'bad');
  } finally {
    removeEventListener('beforeunload', leave);
    try { await wake?.release(); } catch { /* gone */ }
    busyDeck = -1; dj.loading?.(i, null); draw();
    if (released) app.settled?.(failed ? `The DJ crate stopped on deck ${d.name}'s FM-1 (see the Log).` : `The DJ crate is done with deck ${d.name}'s FM-1.`, backKey);
    document.dispatchEvent(new Event('firmware-install-state'));
  }
}

/* drag a card onto a deck (dj-ui.js calls this from the deck's drop): the card asks first, as Load does */
export const CRATE_TYPE = 'application/x-burrito-crate';
export function dropOnDeck(e, i) {
  const id = e.dataTransfer?.getData(CRATE_TYPE);
  if (!id) return false;
  e.preventDefault();
  askLoad(id, i);
  if (view !== 'cards') setView('cards');
  root?.querySelector(`.crate-cart[data-id="${id}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  return true;
}
function askLoad(id, i, slot = null) {
  asking = {id, i, slot}; setOpen(true); drawList();
  /* songs alone: the LSDj its FM-1 runs (its title, then that LSDj's song format), to say when it can't open them; a
     card with its LSDj: whether that FM-1 has it already (then only the songs go) */
  const item = items.find(x => x.id === id), d = fm1Decks().find(x => x.i === i);
  if (!item || !d) return;
  const ask = asking;
  if (item.rom) { void hasLsdj(d.key, item.rom).then(has => { if (asking === ask) { ask.has = has; drawList(); } }); return; }
  void Promise.resolve(app.info?.(d.key)).then(info => {
    if (asking !== ask || !info?.title) return;
    const roms = [...files.values()].filter(f => f.kind === 'rom').map(f => f.bytes);
    ask.fm1 = {title: info.title.replace(/[\u0000 ]+$/, ''), format: formatOfTitle(info.title, roms)}; drawList();
  }, () => {});
}
/* the songs (all, or the one chosen) its FM-1's LSDj can't open: saved by a newer LSDj */
/* what the songs named need, at least (the newest format among them): "LSDj 9.2.1 or newer" (the dev.18 page) */
const needsOf = (t, names) => needsText(Math.max(-1, ...t.songList.filter(x => names.includes(x.name)).map(x => x.format ?? -1)));
const fm1Lsdj = title => String(title || '').replace(/^LSDj-v/, 'LSDj ');
const tooNewFor = (t, fm1, slot) => fm1?.format == null ? [] : t.songList.filter(x => (slot == null || x.slot === slot) && !opens(fm1.format, x.format)).map(x => x.name);

/* the deck holding a card's .sav now: the .sav this page last sent to its FM-1 (dj-ui.js held(i): its checksum, while
   the FM-1 still reports it) is this card's */
const heldBy = (item, t, slot) => fm1Decks().filter(d => {
  const h = dj.held?.(d.i), l = loadedOn[d.key];
  if (h == null) return false;
  if (l && l.crc === h && l.id === item.id) return slot === undefined || l.slot === slot;
  return (slot === undefined || slot === t.open) && t.crc === h;
}).map(d => d.name);

const HOLD_MS = 900;
/* Load A: a click asks on the card; held for HOLD_MS (a ring fills) it loads at once, no question */
function loadBtn(item, d, t, slot = null, text = `Load ${d.name}`) {
  const b = btn(text, null, {className: 'crate-load', disabled: busyDeck >= 0 || t.missing,
    title: `${item.rom ? 'Install this LSDj on' : 'Send these songs to'} deck ${d.name}'s FM-1; the other deck keeps playing. ` +
      `Click to be asked first; hold to load at once.`});
  let timer = 0, held = false;
  const stop = () => { clearTimeout(timer); timer = 0; b.classList.remove('holding'); };
  b.onpointerdown = e => {
    if (e.button !== 0 || b.disabled) return;
    held = false; b.classList.add('holding');
    timer = setTimeout(() => { held = true; stop(); void loadOnto(item.id, d.i, slot); }, HOLD_MS);
  };
  b.onpointerup = b.onpointerleave = b.onpointercancel = stop;
  b.onclick = () => { if (held) { held = false; return; } askLoad(item.id, d.i, slot); };
  b.style.setProperty('--hold', `${HOLD_MS}ms`);
  return b;
}
/* the question, on the card */
function askBox(item, t) {
  if (asking?.remove) return el('div', {className: 'crate-ask', role: 'alertdialog', ariaLabel: `Remove ${item.name}`},
    el('p', {textContent: `Take "${item.name}" out of the crate?`}),
    el('div', {className: 'crate-ask-acts'},
      btn('Remove', async () => {
        asking = null;
        const before = items; items = removeItem(items, item.id); save();
        await tidy(before); drawList();
      }, {className: 'danger'}),
      btn('Cancel', () => { asking = null; drawList(); })));
  const d = (dj.decks?.() || [])[asking.i];
  const song = asking.slot != null ? t.songList.find(x => x.slot === asking.slot) : null;
  const checking = item.rom && asking.has === undefined, install = item.rom && asking.has === false;
  const what = checking ? `Checking whether deck ${d?.name}'s FM-1 already has this LSDj…`
    : (asking.has && item.sav ? `Deck ${d?.name}'s FM-1 already has this LSDj: replace its songs with these?`
    : install ? `Install this LSDj on deck ${d?.name}'s FM-1 (about a minute; it restarts)${item.sav ? ', then its songs' : ''}?`
    : `Replace deck ${d?.name}'s songs with these?`) + (song ? ` It opens on ${song.name}.` : '');
  return el('div', {className: 'crate-ask', role: 'alertdialog', ariaLabel: `Load ${item.name} on deck ${d?.name}`},
    el('p', {textContent: what}),
    el('p', {className: 'hint', textContent: `Deck ${d?.name} stops; the other keeps playing.` + (install ? ' Experimental firmware: keep the cable in.' : '') +
      (heldBy(item, t).includes(d?.name) ? '' : ' Grab its songs first to keep them.')}),
    (() => { const n = item.rom ? t.tooNew : tooNewFor(t, asking.fm1, asking.slot), lsdj = item.rom ? `This card's LSDj (${t.version})` : `Deck ${d?.name}'s FM-1 runs ${fm1Lsdj(asking.fm1?.title)}, which`, need = n.length && needsOf(t, n);
      return n.length ? el('p', {className: 'warn crate-needs', textContent: `${lsdj} can't open ${n.join(', ')}: saved by a newer LSDj${need ? `; ${n.length === 1 ? 'it needs' : 'they need'} ${need}` : ''}. Load an LSDj that can (a cart made with it, or its .gb) first.`}) : null; })(),
    /* can't tell (an LSDj or songs whose format the page doesn't know): said, not taken as fine (the cartridge plan) */
    (() => { if (!item.sav) return null;
      const lsdjFmt = item.rom ? t.format : asking.fm1 ? asking.fm1.format : undefined, songs = t.songList.filter(x => asking.slot == null || x.slot === asking.slot);
      const unknown = songs.filter(x => x.format == null).map(x => x.name);
      const text = lsdjFmt === null && songs.length ?   /* (undefined: the deck's FM-1 hasn't said yet) */
        `The page doesn't know ${item.rom ? "this card's LSDj" : `deck ${d?.name}'s LSDj`} well enough to check these songs open in it.`
        : unknown.length ? `The page can't read the format of ${unknown.join(', ')}, so it can't check ${unknown.length === 1 ? 'it opens' : 'they open'} in this LSDj.` : '';
      return text ? el('p', {className: 'hint crate-needs', textContent: `${text} Load it if you know it does.`}) : null; })(),
    el('div', {className: 'crate-ask-acts'},
      btn(`Load ${d?.name}`, () => void loadOnto(item.id, asking.i, asking.slot), {className: 'primary', disabled: checking}),
      btn('Cancel', () => { asking = null; drawList(); })));
}

/* a song: its name, its blocks (and open: the song LSDj starts on), and a Load per deck straight into it (asked on the
   card, or held) */
function songRow(item, t, s, withCard = false) {
  const on = heldBy(item, t, s.slot);
  return el('li', {className: `crate-song${on.length ? ' on-deck' : ''}`},
    withCard ? el('span', {className: 'crate-song-card', title: item.name}, el('i', {className: 'crate-dot', style: isHex(item.color) ? `background:${item.color}` : ''}), item.name) : null,
    el('span', {className: 'crate-song-name', textContent: s.name, title: needsText(s.format) ? `Needs ${needsText(s.format)} (song format ${s.format})` : ''}),
    t.tooNew.includes(s.name) ? el('small', {className: 'warn', textContent: `needs ${needsText(s.format)?.replace(/ or newer$/, '+') ?? 'a newer LSDj'}`}) : null,
    el('small', {textContent: `${s.blocks} blk${t.open === s.slot ? ' · open' : ''}`}),
    ...on.map(n => el('span', {className: 'crate-on', textContent: `ON ${n}`})),
    el('span', {className: 'crate-song-acts'}, ...fm1Decks().map(d => loadBtn(item, d, t, s.slot, d.name))),
    view === 'songs' && asking && !asking.remove && asking.id === item.id && asking.slot === s.slot ? askBox(item, t) : null);
}
function setView(v) {
  view = v === 'songs' ? 'songs' : 'cards'; store.set('dj-crate-view', view);
  root?.querySelectorAll('[data-crate-view]').forEach(b => { const on = b.dataset.crateView === view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  drawList();
}

/* a card: a Game Boy cartridge, its label in the card's colour (the name, the LSDj and songs, the deck holding it),
   Songs to open the list (each song's blocks, the LSDj's kits), Load A / Load B, a colour, Pair, ✕ */
function card(item, reorder) {
  const t = describe(item, bytesOf), decks = fm1Decks(), on = heldBy(item, t);
  const name = el('input', {type: 'text', value: item.name, className: 'crate-name', maxLength: 60,
    onchange: () => { items = renameItem(items, item.id, name.value.trim()); save(); }});
  name.setAttribute('aria-label', 'Name');
  const needs = item.sav && !t.missing ? needsText(t.needs) : null;
  const meta = [t.version ? `LSDj ${t.version}` : null, item.sav ? (t.missing ? 'file missing' : `${t.songs.length} song${t.songs.length === 1 ? '' : 's'}`) : 'no songs',
    needs ? `needs ${needs.replace(/ or newer$/, '+')}` : null].filter(Boolean).join(' · ');
  const noLsdj = !item.rom && item.sav;
  const romBytes = item.rom && bytesOf(item.rom), tooBig = !!(romBytes && !fitsNow(romBytes, item.rom));
  const canPair = pairFrom && pairFrom !== item.id && (() => { const o = items.find(x => x.id === pairFrom); return o && !!o.rom !== !!item.rom && !!o.sav !== !!item.sav; })();
  const editing = labelOpen.has(item.id);
  const colour = btn('', () => { if (editing) labelOpen.delete(item.id); else labelOpen.add(item.id); drawList(); },
    {className: 'crate-colour' + (editing ? ' on' : ''), title: 'Label: colour and picture', ariaLabel: `${item.name}: label colour and picture`});
  colour.setAttribute('aria-expanded', String(editing));
  const picUrl = item.img ? imageUrl(item.img, bytesOf(item.img)) : null;
  const editor = editing ? labelEditor({color: item.color, hasImage: !!item.img, name: item.name,
    onColor: c => { items = recolorItem(items, item.id, c); save(); drawList(); },
    onImage: f => void setPicture(item, f),
    onNoImage: async () => { const before = items; items = setImage(items, item.id, null); save(); await tidy(before); drawList(); }}) : null;
  const songs = t.missing ? null : el('details', {className: 'crate-songs', open: openSongs.has(item.id),
    ontoggle: e => { if (e.currentTarget.open) openSongs.add(item.id); else openSongs.delete(item.id); }},
    el('summary', {textContent: item.sav ? `Songs (${t.songs.length})` : 'Kits'}),
    item.sav ? (t.songList.length ? el('ol', {className: 'crate-songlist mono'}, ...t.songList.map(s => songRow(item, t, s)))
      : el('p', {className: 'hint', textContent: 'No songs saved.'})) : null,
    item.sav && t.free != null ? el('p', {className: 'hint', textContent: `${t.free} blocks free`}) : null,
    item.rom ? el('p', {className: 'hint', textContent: t.kits.length ? `Kits: ${t.kits.join(', ')}` : 'No kits.'}) : null);
  const c = el('div', {className: `crate-cart${pairFrom === item.id ? ' pairing' : ''}${on.length ? ' on-deck' : ''}`, draggable: true,
    ondragstart: e => { e.dataTransfer.setData(CRATE_TYPE, item.id); e.dataTransfer.effectAllowed = 'copyMove'; },
    /* your own order: a card dropped on another goes in its place */
    ondragover: e => { if (reorder && [...(e.dataTransfer?.types || [])].includes(CRATE_TYPE)) { e.preventDefault(); c.classList.add('drop'); } },
    ondragleave: () => c.classList.remove('drop'),
    ondrop: e => {
      c.classList.remove('drop');
      const from = e.dataTransfer?.getData(CRATE_TYPE);
      if (!reorder || !from || from === item.id) return;
      e.preventDefault();
      items = moveItem(items, from, items.findIndex(x => x.id === item.id)); save(); drawList();
    }},
    el('div', {className: 'crate-shell', ariaHidden: 'true'}, el('i'), el('i'), el('i')),
    el('div', {className: 'crate-label' + (picUrl ? ' with-art' : '')},
      picUrl ? el('img', {className: 'crate-art', src: picUrl, alt: '', draggable: false}) : null,
      el('div', {className: 'crate-label-top'}, colour,
        ...t.kinds.map(k => el('span', {className: 'crate-kind', textContent: k})),
        ...on.map(n => el('span', {className: 'crate-on', textContent: `ON ${n}`, title: `Deck ${n}'s FM-1 has these songs now`}))),
      name,
      el('p', {className: 'crate-meta', textContent: meta, title: t.songs.join(', ')}),
      t.tooNew.length ? el('p', {className: 'crate-needs', textContent: `LSDj ${t.version} can't open ${t.tooNew.join(', ')} (saved by a newer LSDj${needsOf(t, t.tooNew) ? `: needs ${needsOf(t, t.tooNew)}` : ''})`}) : null,
      noLsdj ? el('p', {className: 'crate-needs', textContent: 'No LSDj: not a whole cartridge. Choose its LSDj.'}) : null,
      tooBig ? el('p', {className: 'crate-needs', textContent: item.sav ? 'Too big for the FM-1 with all its kits: press Make it fit.' : 'Too big for the FM-1 with all its kits: install it from Install, leaving kits out.'}) : null,
      editor),
    songs,
    el('div', {className: 'crate-acts'},
      ...decks.map(d => loadBtn(item, d, t)),
      canPair ? btn('Pair here', async () => { const before = items; items = pairItems(items, pairFrom, item.id); pairFrom = null; save(); await tidy(before); drawList(); }, {className: 'on'})
        : noLsdj ? btn('Choose its LSDj', () => void completeItem(item), {className: 'on', title: 'A cartridge needs its LSDj: the songs\' kit samples are in it'})
        : tooBig && item.sav ? btn('Make it fit', () => void makeFit(item), {className: 'on', title: 'Keep only the kits and samples its songs play, so it loads on the FM-1'})
        : !item.sav ? btn(pairFrom === item.id ? 'Cancel' : 'Pair', () => { pairFrom = pairFrom === item.id ? null : item.id; drawList(); },
          {title: 'Pair this LSDj with songs: then press Pair here on a card with songs'}) : null,
      item.rom ? btn('⇩', () => exportCart(item), {title: 'Download this cartridge: its LSDj (.gb) and songs (.sav), the same name', ariaLabel: `Download ${item.name}`}) : null,
      btn('✕', () => { asking = {id: item.id, remove: true}; drawList(); }, {title: 'Take it out of the crate', ariaLabel: `Remove ${item.name}`})),
    asking?.id === item.id && view === 'cards' ? askBox(item, t) : null);
  c.dataset.id = item.id; paintLabel(c, item.color);
  return c;
}
const openSongs = new Set();

/* ---- the crate: its bar (built once: the search keeps its focus), the cards (drawn again on any change) ---- */
let listEl = null, grabsEl = null, countEl = null, setOpen = () => {};
function drawGrabs() {
  if (!grabsEl) return;
  const decks = fm1Decks();
  grabsEl.replaceChildren(...decks.map(d => btn(`Grab ${d.name}`, () => void grab(d), {disabled: busyDeck >= 0,
    title: `Put deck ${d.name}'s songs and LSDj in the crate as one cartridge (a copy; the FM-1 keeps playing)`})));
}
function drawList() {
  if (!listEl) return;
  const text = i => { const t = describe(i, bytesOf); return `${t.songs.join(' ')} ${t.version || ''}`; };
  const shown = viewItems(items, {query, sort}, text), reorder = sort === 'mine' && !query.trim();
  if (asking && !items.some(i => i.id === asking.id)) asking = null;
  countEl.textContent = items.length ? (shown.length === items.length ? `${items.length}` : `${shown.length} of ${items.length}`) : '';
  listEl.classList.toggle('songs', view === 'songs');
  if (view === 'songs' && items.length) {
    /* Songs: every song of the cards shown (search: a song's name or its card's), each with its card and Load A / B;
       a load asked for here asks on its card (in Cards) */
    const q = query.trim().toLowerCase(), rows = [];
    for (const i of viewItems(items, {sort}, () => '')) {
      const t = describe(i, bytesOf);
      if (t.missing) continue;
      for (const s of t.songList) if (!q || `${s.name} ${i.name}`.toLowerCase().includes(q)) {
        const r = songRow(i, t, s, true); r.dataset.color = i.color; rows.push(r);
      }
    }
    listEl.replaceChildren(rows.length ? el('ol', {className: 'crate-songview mono'}, ...rows)
      : el('p', {className: 'hint', textContent: q ? `No song matches "${query}".` : 'No songs in the crate yet.'}));
    return;
  }
  listEl.replaceChildren(...(items.length
    ? shown.length ? shown.map(i => card(i, reorder)) : [el('p', {className: 'hint', textContent: `Nothing matches "${query}".`})]
    : [el('p', {className: 'hint', textContent: 'Empty. Open an LSDj and its .sav, grab a deck, or use "Add to the DJ crate" in Songs & kits or Sets: each card is a whole cartridge, an LSDj and its songs. Then drag a card onto a deck, or press Load.'})]));
}
function draw() { drawGrabs(); drawList(); }

export async function mountCrate(box) {
  root = box;
  /* (storage that isn't kept: the cards and their files last only for this visit; kit-library.js) */
  if (!mountCrate.heard) { mountCrate.heard = true; document.addEventListener('kit-library-trouble', e => say(e.detail.text, 'warn')); }
  const pick = el('input', {type: 'file', accept: '.sav,.gb,.gbc', multiple: true, hidden: true,
    onchange: async () => { await openFiles([...pick.files]); pick.value = ''; }});
  const search = el('input', {type: 'search', placeholder: 'Find a card or song', className: 'crate-search',
    oninput: () => { query = search.value; drawList(); }});
  search.setAttribute('aria-label', 'Find a card or song');
  const sorter = el('select', {className: 'crate-sort', onchange: () => { sort = sorter.value; store.set('dj-crate-sort', sort); drawList(); }},
    new Option('My order', 'mine'), new Option('Name', 'name'), new Option('Newest', 'newest'));
  sorter.value = sort; sorter.setAttribute('aria-label', 'Sort the crate');
  grabsEl = el('span', {className: 'crate-grabs'});
  const viewBtn = (v, text) => { const b = btn(text, () => setView(v), {className: view === v ? 'on' : '', ariaPressed: String(view === v)}); b.dataset.crateView = v; return b; };
  const views = el('div', {className: 'seg crate-views', role: 'group', ariaLabel: 'Crate view'}, viewBtn('cards', 'Cards'), viewBtn('songs', 'Songs'));
  countEl = el('span', {className: 'crate-count hint'});
  /* (no scrollbar: a swipe, or the mouse wheel, moves the cards sideways) */
  listEl = el('div', {className: 'crate-list', onwheel: e => {
    const l = e.currentTarget;
    if (l.scrollWidth > l.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { l.scrollLeft += e.deltaY; e.preventDefault(); }
  }});
  statusEl = el('p', {className: 'hint crate-status', role: 'status'});
  /* a tray: the bar always there, the cards opened from it (in full screen they come up over the decks' lower part, so
     the decks keep their size); open or not kept in this browser */
  const toggle = btn('', () => openCrate(!root.classList.contains('open')), {className: 'crate-toggle'});
  const openCrate = on => {
    root.classList.toggle('open', on); store.set('dj-crate-open', on ? '1' : '0');
    toggle.textContent = on ? 'Crate ▾' : 'Crate ▴'; toggle.setAttribute('aria-expanded', String(on));
    toggle.title = on ? 'Put the cards away' : 'Show the cards';
  };
  setOpen = openCrate;
  root.replaceChildren(
    el('div', {className: 'crate-top'}, toggle, countEl, views, search, sorter,
      btn('Open files…', () => pick.click(), {title: 'An LSDj (.gb) and its songs (.sav): pick both (the same name pairs them), or a .sav alone and choose its LSDj. Kept in this browser only'}), pick,
      btn('New cart…', () => void openCartMaker({addToCrate}), {className: 'crate-new', title: 'Make carts from songs, projects and your LSDj files: each holds only the kits its songs play'}),
      btn('Export cartridges', exportAll, {title: 'Every whole cartridge (LSDj + songs) as a .zip: a folder each with its .gb and .sav'}), grabsEl),
    el('div', {className: 'crate-body'}, listEl, statusEl));
  openCrate(store.get('dj-crate-open', '0') === '1');
  await refreshFiles();
  draw();
  document.addEventListener('kit-library', () => void refreshFiles().then(draw));
}
export const crateRedraw = () => draw();
