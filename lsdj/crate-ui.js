// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate (Perform › DJ, under the decks): saves and LSDj ROMs to load onto one deck's FM-1 while the other
// deck plays on. A .sav goes over that FM-1's link (only it pauses, as Songs › Send does). An LSDj is installed on
// that FM-1 alone (install.js installOn: nothing is sent to the other FM-1s, the other decks' gear or the mixer),
// then a paired .sav follows. lsdj/crate.js holds the list; the files stay in this browser (kit-library.js).
import {KEY, fileKind, loadItems, saveItems, addItem, removeItem, renameItem, pairItems, unusedSaves, describe,
  recolorItem, setImage, unusedImages, moveItem, viewItems, formatOfTitle} from './crate.js';
import {labelEditor, paintLabel, shrinkImage, imageUrl, isHex} from './cart-label.js';
import {opens} from './lsdj-sets.js';
import {libraryFiles, addToLibrary, removeFromLibrary} from './kit-library.js';
import {listKits, crc32} from './lsdj-rom.js';
import {withOpenSong, savBody} from './lsdj-sav.js';
import {openCartMaker} from './cart-maker.js';
import {logEvent} from './conn-log.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {installOn, checkPackage, REPLUG} from './install.js';
import {installing, setInstallTarget} from './install-ui.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};

/* app.js: access() -> MIDIAccess, ports(key) -> {input, output} port ids, otherPorts(key) -> every other FM-1's port
   ids, release(key) (the page lets go of that FM-1), rescan() -> [{key, title}] the FM-1s found, readSave(key, pr),
   readRom(key, pr), sendSave(key, bytes, name, pr), info(key) -> the link's INFO, volumeFull(key).
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

/* a ROM and/or a save (bytes) -> a crate item; used by Songs & kits, Sets and New cart… too. color: a preset or
   #rrggbb; img: a picture's bytes (cart-label.js shrinkImage) */
export async function addToCrate({name, rom = null, sav = null, color = 'grey', img = null}) {
  const r = rom ? await addToLibrary('rom', `${name}.gb`, rom) : null;
  const s = sav ? await addToLibrary('sav', `${name}.sav`, sav) : null;
  const p = img ? await addToLibrary('img', `${name}.jpg`, img) : null;
  items = addItem(items, {name, rom: r?.id || null, sav: s?.id || null, color, img: p?.id || null});
  save(); await refreshFiles(); setOpen(true); draw();
}
/* files no item uses any more, out of the library (saves and pictures: ROMs are shared with Sets) */
async function tidy(before) {
  for (const id of [...unusedSaves(items, before), ...unusedImages(items, before)]) await removeFromLibrary(id);
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
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer()), kind = fileKind(bytes), name = f.name.replace(/\.(sav|gbc?)$/i, '');
    if (!kind) { say(`${f.name} is neither an LSDj save nor an LSDj ROM.`, 'warn'); continue; }
    await addToCrate({name, [kind]: kind === 'sav' ? savBody(bytes).slice() : bytes});   /* (a save's footer left out) */
  }
}

/* after songs are sent: does that FM-1 hold them once LSDj has started on them? (INFO: its save's checksum, its LSDj
   and firmware) -> null when it does, else what to say. The page said "has" as soon as the transfer ended before;
   an FM-1 that kept or changed its songs (another LSDj, older firmware) said nothing. */
async function checkHeld(key, sav, deck) {
  await wait(2500);   /* (LSDj restarted on the songs) */
  let info = null;
  try { info = await app.info?.(key); } catch (e) { return `couldn't ask that FM-1 what it holds now (${e.message})`; }
  if (!info || info.saveCrc === crc32(sav)) return null;
  const what = `${info.title || 'its LSDj'}, firmware ${info.firmware || '?'}`;
  logEvent(`Deck ${deck}: songs sent, but the FM-1 (${what}) holds different ones (checksum ${info.saveCrc.toString(16)}, sent ${crc32(sav).toString(16)}).`);
  return `the FM-1 (${what}) doesn't hold the songs sent: its LSDj may have kept or changed them. See the Log`;
}
const fm1Decks = () => (dj.decks?.() || []).filter(d => d.kind === 'fm1' && d.key != null);
async function grab(d, withRom) {
  if (busyDeck >= 0) return;
  busyDeck = d.i; draw();
  try {
    const sav = await app.readSave(d.key, (n, t) => dj.loading?.(d.i, 'Copying its songs…', n, t));
    const rom = withRom ? await app.readRom(d.key, (n, t) => dj.loading?.(d.i, 'Copying its LSDj…', n, t)) : null;
    const title = (await app.info?.(d.key).catch(() => null))?.title;
    await addToCrate({name: `Deck ${d.name}${title ? ` ${title}` : ''} ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`, rom, sav});
    say(`Deck ${d.name}'s ${withRom ? 'LSDj and songs are' : 'songs are'} in the crate.`, 'ok');
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
    if (/only \d+ are available/.test(e.message)) throw Error('This LSDj with all its kits is too big for the FM-1. Prepare it in Install, leaving some kits out.');
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
  const rom = item.rom && bytesOf(item.rom);
  let sav = item.sav && bytesOf(item.sav), label = item.name;
  if ((item.rom && !rom) || (item.sav && !sav)) { draw(); return say(`${item.name}: its file is no longer in this browser. Add it again.`, 'bad'); }
  if (sav && slot != null) {   /* straight into the chosen song */
    try { const song = describe(item, bytesOf).songList.find(x => x.slot === slot); sav = withOpenSong(sav, slot); label = `${item.name} › ${song?.name ?? slot}`; }
    catch (e) { draw(); return say(`${item.name}: ${e.message}`, 'bad'); }
  }
  const loaded = key => { loadedOn[key] = {id: item.id, slot, crc: crc32(sav)}; store.set('dj-crate-on', JSON.stringify(loadedOn)); };
  busyDeck = i; draw();
  const show = (text, n, t) => { dj.loading?.(i, text, n, t); say(`Deck ${d.name}: ${text}`, 'hint'); };
  const leave = e => { e.preventDefault(); e.returnValue = ''; };
  let wake = null, released = false, failed = false;
  try {
    if (!rom) {
      dj.stop?.(i);
      show('Sending the songs…');
      await app.sendSave(d.key, sav, label, (n, t) => show('Sending the songs…', n, t));
      show('Checking the FM-1 holds them…');
      const bad = await checkHeld(d.key, sav, d.name);
      if (bad) return say(`Deck ${d.name}: sent "${label}", but ${bad}.`, 'bad');
      loaded(d.key);
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
    const r = await installOn(app.access(), checkPackage(pkg.bytes), {target, avoid, slot: pkg.slot,
      log: t => logEvent(`Deck ${d.name}: ${t}`),
      onStep: s => { step = s; if (s === 'restart' || s === 'loader') restarted = true; logEvent(`Deck ${d.name}: ${names[s] || s}.`);
        show(s.startsWith('replug') ? names[s] : `${names[s]}…`); },
      onProgress: (n, t) => show(`${names[step === 'swap' ? 'swap' : 'write']}…`, n, t)});
    setInstallTarget(null);
    /* the restarted FM-1: the one found now that wasn't there before (none restarted: it already had this LSDj) */
    await wait(1500);
    const fresh = (await app.rescan()).filter(x => !others.has(x.key));
    const back = !restarted ? {key: d.key} : r.confirmed && fresh.length === 1 ? fresh[0] : null;
    logEvent(`Deck ${d.name}: installed ${r.id}${restarted ? `; FM-1s found after its restart: ${fresh.length}${r.confirmed ? '' : ' (another went away)'}` : ' (it already had this LSDj)'}.`);
    if (!back) {
      say(`Installed ${r.id}, but the page can't tell which FM-1 restarted${r.confirmed ? '' : ' (another FM-1 was unplugged meanwhile)'}. ` +
        `Choose it for deck ${d.name}${sav ? ', then load the songs' : ''}.`, 'warn');
      return;
    }
    dj.assign?.(i, back.key);
    if (sav) {
      show('Sending the songs…');
      await app.sendSave(back.key, sav, label, (n, t) => show('Sending the songs…', n, t));
      show('Checking the FM-1 holds them…');
      const bad = await checkHeld(back.key, sav, d.name);
      if (bad) return say(`Deck ${d.name}: installed ${r.id} and sent "${label}", but ${bad}.`, 'bad');
      loaded(back.key);
    }
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
    if (released) app.settled?.(failed ? `The DJ crate stopped on deck ${d.name}'s FM-1 (see the Log).` : `The DJ crate is done with deck ${d.name}'s FM-1.`);
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
  /* songs alone: the LSDj its FM-1 runs (its title, then that LSDj's song format), to say when it can't open them */
  const item = items.find(x => x.id === id), d = fm1Decks().find(x => x.i === i);
  if (!item || item.rom || !d) return;
  const ask = asking;
  void Promise.resolve(app.info?.(d.key)).then(info => {
    if (asking !== ask || !info?.title) return;
    const roms = [...files.values()].filter(f => f.kind === 'rom').map(f => f.bytes);
    ask.fm1 = {title: info.title.replace(/[\u0000 ]+$/, ''), format: formatOfTitle(info.title, roms)}; drawList();
  }, () => {});
}
/* the songs (all, or the one chosen) its FM-1's LSDj can't open: saved by a newer LSDj */
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
  const what = (item.rom ? `Install this LSDj on deck ${d?.name}'s FM-1 (about a minute; it restarts)${item.sav ? ', then its songs' : ''}?`
    : `Replace deck ${d?.name}'s songs with these?`) + (song ? ` It opens on ${song.name}.` : '');
  return el('div', {className: 'crate-ask', role: 'alertdialog', ariaLabel: `Load ${item.name} on deck ${d?.name}`},
    el('p', {textContent: what}),
    el('p', {className: 'hint', textContent: `Deck ${d?.name} stops; the other keeps playing.` + (item.rom ? ' Experimental firmware: keep the cable in.' : '') +
      (heldBy(item, t).includes(d?.name) ? '' : ' Grab its songs first to keep them.')}),
    (() => { const n = item.rom ? t.tooNew : tooNewFor(t, asking.fm1, asking.slot), lsdj = item.rom ? `This card's LSDj (${t.version})` : `Deck ${d?.name}'s FM-1 runs ${asking.fm1?.title}, which`;
      return n.length ? el('p', {className: 'warn crate-needs', textContent: `${lsdj} can't open ${n.join(', ')}: saved by a newer LSDj. Load an LSDj that can (a cart made with it, or its .gb) first.`}) : null; })(),
    el('div', {className: 'crate-ask-acts'},
      btn(`Load ${d?.name}`, () => void loadOnto(item.id, asking.i, asking.slot), {className: 'primary'}),
      btn('Cancel', () => { asking = null; drawList(); })));
}

/* a song: its name, its blocks (and open: the song LSDj starts on), and a Load per deck straight into it (asked on the
   card, or held) */
function songRow(item, t, s, withCard = false) {
  const on = heldBy(item, t, s.slot);
  return el('li', {className: `crate-song${on.length ? ' on-deck' : ''}`},
    withCard ? el('span', {className: 'crate-song-card', title: item.name}, el('i', {className: 'crate-dot', style: isHex(item.color) ? `background:${item.color}` : ''}), item.name) : null,
    el('span', {className: 'crate-song-name', textContent: s.name}),
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
  const meta = [t.version ? `LSDj ${t.version}` : null, item.sav ? (t.missing ? 'file missing' : `${t.songs.length} song${t.songs.length === 1 ? '' : 's'}`) : 'no songs'].filter(Boolean).join(' · ');
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
      t.tooNew.length ? el('p', {className: 'crate-needs', textContent: `LSDj ${t.version} can't open ${t.tooNew.join(', ')} (saved by a newer LSDj)`}) : null,
      editor),
    songs,
    el('div', {className: 'crate-acts'},
      ...decks.map(d => loadBtn(item, d, t)),
      canPair ? btn('Pair here', async () => { const before = items; items = pairItems(items, pairFrom, item.id); pairFrom = null; save(); await tidy(before); drawList(); }, {className: 'on'})
        : !(item.rom && item.sav) ? btn(pairFrom === item.id ? 'Cancel' : 'Pair', () => { pairFrom = pairFrom === item.id ? null : item.id; drawList(); },
          {title: item.rom ? 'Pair this LSDj with a .sav: then press Pair here on the .sav' : 'Pair this .sav with an LSDj: then press Pair here on the LSDj'}) : null,
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
  const withRom = el('input', {type: 'checkbox', checked: store.get('dj-crate-rom', '0') === '1',
    onchange: () => store.set('dj-crate-rom', withRom.checked ? '1' : '0')});
  grabsEl.replaceChildren(...decks.map(d => btn(`Grab ${d.name}`, () => void grab(d, withRom.checked), {disabled: busyDeck >= 0,
    title: `Put deck ${d.name}'s songs${withRom.checked ? ' and LSDj' : ''} in the crate (a copy; the FM-1 keeps playing)`})),
    decks.length ? el('label', {className: 'hint'}, withRom, ' with its LSDj') : null);
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
    : [el('p', {className: 'hint', textContent: 'Empty. Open a .sav or LSDj ROM, grab a deck\'s songs, or use "Add to the DJ crate" in Songs & kits or Sets. Then drag a card onto a deck, or press Load.'})]));
}
function draw() { drawGrabs(); drawList(); }

export async function mountCrate(box) {
  root = box;
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
      btn('Open files…', () => pick.click(), {title: 'An LSDj save (.sav) or LSDj ROM (.gb): kept in this browser only'}), pick,
      btn('New cart…', () => void openCartMaker({addToCrate}), {className: 'crate-new', title: 'Make carts from songs, projects and your LSDj files: each holds only the kits its songs play'}), grabsEl),
    el('div', {className: 'crate-body'}, listEl, statusEl));
  openCrate(store.get('dj-crate-open', '0') === '1');
  await refreshFiles();
  draw();
  document.addEventListener('kit-library', () => void refreshFiles().then(draw));
}
export const crateRedraw = () => draw();
