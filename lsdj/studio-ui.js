// SPDX-License-Identifier: GPL-3.0-only
// The Cartridge Studio (#studio, Studio › Build): the one place to turn saves, songs and LSDj files into cartridges.
// Drop in your LSDj versions and your songs (any number of .sav, .lsdsng, .lsdprj, .kit and .gb files, or folders):
// the songs are sorted into cartridges (songs that share kits together, every sample kept), then arranged by hand:
// drag songs (or several ticked ones) between cards, point a song's kits somewhere else, name and label the cards.
// A song also in another file (the same song, or another version of it) is asked about once it comes in: which
// copies to keep, each with its file's date and its version. The list goes by file, A to Z, or the newest file first.
// When a card holds more than one cartridge can (32 songs, the .sav's 191 blocks, the FM-1's room, the LSDj's kit
// slots) it either makes several cartridges ("It makes more cartridges": FRIDAY 1, FRIDAY 2…) or the songs past what
// fits move into a new card ("Start a new card"). Made cartridges go to the DJ crate, to Install (their songs sent
// after), or download as NAME.gb + NAME.sav. The planning is cart-core.js (studioView / autoSort / buildStudio) in
// the page's cartridge worker (cart-work.js), so the DJ decks keep time. The DJ crate's "Make carts in Build" comes
// here, and Songs & kits hands a save that is full over (the 'studio-import' event). Copies only: nothing leaves
// this browser.
import {libraryFiles, addToLibrary, hashOf} from './kit-library.js';
import {cartWork as call} from './cart-work.js';
import {labelEditor, paintLabel, shrinkImage} from './cart-label.js';
import {FULL_LSDJ, buildSlot} from './lsdj-rom.js';
import {kitSlots} from './lsdj-kit.js';
import {addToCrate} from './crate-ui.js';
import {zipStore} from './zip.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null && k !== false)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick: e => guard(() => onclick(e)), ...props});
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const two = n => String(n).padStart(2, '0');
const WANTED = /\.(sav|lsdsng|lsdprj|gbc?|kit)$/i, DRAG = 'application/x-studio-song';
const BUILT = 'cart-built';   /* the ids of LSDj files made here: never a source for matching songs (songs-ui.js reads it too) */
const MODE = 'studio-full';   /* what a full card does, this viewer's choice: 'split' | 'new' */
const BY = 'studio-by';   /* the song list: by file, by name (A to Z) or the newest file first, this viewer's choice */
const SLOTS = 32, BLOCKS = 191, SHOWN = 8, ROWS_MAX = 400;
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};

let root = null, capacity = 502016, viewSeq = 0, listening = false, ready = null;
const files = {pick: null, folder: null, rom: null};
const ui = {carts: [], nextCart: 1, choices: {madeWith: {}, kitPick: {}}, baseId: null, query: '', filter: 'all', view: null, made: {}, busy: '',
  sel: new Set(), anchor: null, groupOpen: new Map(), kitsOpen: null, labelOpen: null, showAll: new Set(), ask: null, drag: null,
  mode: store.get(MODE, 'split') === 'new' ? 'new' : 'split',
  by: ['file', 'name', 'newest'].includes(store.get(BY, '')) ? store.get(BY, '') : 'file',   /* how the song list is grouped */
  dups: null};   /* songs in more than one file, being asked about: {groups, keep: Set of ids, sortIds: fresh songs to sort after} */

/* text: a string, or a list of strings and elements (a link) */
const say = (text, cls = 'hint') => { const s = root?.querySelector('.studio-status'); if (s) { s.replaceChildren(...[].concat(text)); s.className = `${cls} studio-status`; } };
async function guard(f) { try { await f(); } catch (e) { ui.busy = ''; say(e.message, 'bad'); console.error(e); draw(); } }
const built = () => { try { return JSON.parse(store.get(BUILT, '[]')) || []; } catch { return []; } };
function download(bytes, name, type = 'application/octet-stream') {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const safeName = t => String(t || 'cartridge').trim().replace(/[^A-Za-z0-9 _().-]+/g, '_').slice(0, 60) || 'cartridge';

/* ---- the cards (what the user arranged) ---- */
const cartOf = id => ui.carts.find(c => c.id === id);
const cartOfSong = id => ui.carts.find(c => c.songIds.includes(id));
const cartTitle = (c, i = ui.carts.indexOf(c)) => c.name || `Cart ${i + 1}`;
function newCart(songIds = [], lsdjId = null, {at = ui.carts.length, name = '', color = 'grey'} = {}) {
  const c = {id: `k${ui.nextCart++}`, name, lsdjId, songIds: [...songIds], label: {color, img: null, url: null}};
  ui.carts.splice(at, 0, c); return c;
}
/* songs to a card (before another song there), or back to the loose songs (cartId null) */
function moveSongs(ids, cartId, beforeId = null) {
  ids = ids.filter(id => id !== beforeId);
  for (const c of ui.carts) c.songIds = c.songIds.filter(x => !ids.includes(x));
  const c = cartId && cartOf(cartId);
  if (c) { const at = beforeId ? c.songIds.indexOf(beforeId) : -1; at < 0 ? c.songIds.push(...ids) : c.songIds.splice(at, 0, ...ids); }
  ui.made = {};
}
function nudge(c, id, by) {
  const i = c.songIds.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= c.songIds.length) return;
  [c.songIds[i], c.songIds[j]] = [c.songIds[j], c.songIds[i]]; ui.made = {};
}
/* the name of a card made from another: "FRIDAY" -> "FRIDAY 2", "FRIDAY 2" -> "FRIDAY 3" */
const nextName = n => { const m = /^(.*\S)\s+(\d+)$/.exec(n); return m ? `${m[1]} ${+m[2] + 1}` : `${n} 2`; };
const uniqueName = n => { if (!n) return ''; const taken = new Set(ui.carts.map(c => c.name)); while (taken.has(n)) n = nextName(n); return n; };
const nameFromFile = f => String(f || '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 24);
/* "Start a new card": a card holding more than one cartridge can keeps the songs that fit (in order, at least one);
   the rest move into a new card right after it, in its colour. True when songs moved. */
function spill() {
  if (ui.mode !== 'new') return false;
  let moved = false;
  for (const p of ui.view?.carts ?? []) {
    const c = cartOf(p.id), keep = Math.max(1, p.fit);
    if (!c || keep >= c.songIds.length) continue;
    newCart(c.songIds.splice(keep), c.lsdjId, {at: ui.carts.indexOf(c) + 1, name: c.name ? uniqueName(nextName(c.name)) : '', color: c.label.color});
    moved = true;
  }
  return moved;
}

/* ---- files: picked, or dropped (folders read all the way down) ---- */
async function entriesOf(items) {
  const out = [], walk = async e => {
    if (e.isFile) { if (WANTED.test(e.name)) out.push(await new Promise((res, rej) => e.file(res, rej))); return; }
    const r = e.createReader();
    for (let batch; (batch = await new Promise((res, rej) => r.readEntries(res, rej))).length;) for (const x of batch) await walk(x);
  };
  for (const it of items) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e); else { const f = it.getAsFile?.(); if (f && WANTED.test(f.name)) out.push(f); } }
  return out;
}
async function sendLibrary() {
  const list = (await libraryFiles()).filter(f => f.kind === 'rom' || f.kind === 'kit').map(f => ({id: f.id, kind: f.kind, name: f.name, bytes: f.bytes, date: f.date ?? null}));
  await call('library', {files: list, built: built()});
}
/* files in: read in the worker, LSDj and .kit files kept for next time; new songs sorted into cards when nothing is
   arranged yet (or sort: always, as for songs Songs & kits hands over). New songs that are also in another file are
   asked about first (askDups): which copies to keep, then the sorting. */
async function addFiles(list, {sort = false} = {}) {
  list = [...list].filter(f => WANTED.test(f.name));
  if (!list.length) return say('No songs, projects, saves, LSDj files or kits there.', 'warn');
  const before = new Set((ui.view?.songs ?? []).map(s => s.id));
  ui.busy = `Reading ${plural(list.length, 'file')}…`; draw();
  const read = [];
  for (const f of list) read.push({name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), date: f.lastModified || null});
  const out = await call('add', {files: read}, read.map(f => f.bytes.buffer));
  for (const r of out.roms) await addToLibrary('rom', r.name, r.bytes, r.date ? {date: r.date} : {});   /* kept for next time: drop them once */
  for (const k of out.kits) await addToLibrary('kit', k.name, k.bytes, k.date ? {date: k.date} : {});
  if (out.roms.length || out.kits.length) await sendLibrary();
  ui.busy = ''; ui.made = {};
  await refresh();
  const fresh = (ui.view?.songs ?? []).filter(s => !before.has(s.id)).map(s => s.id);
  const sortNow = fresh.length && (sort || !ui.carts.length) && ui.view.roms.length;
  const groups = fresh.length ? await call('dups', {ids: fresh}) : [];
  let sorted = 0;
  if (groups.length) askDups(groups, sortNow ? fresh : ui.dups?.sortIds ?? null);
  else if (sortNow) sorted = await sortLoose(fresh);
  say(`Added ${plural(out.songs, 'song')}` + (out.roms.length ? `, ${plural(out.roms.length, 'LSDj')}` : '') + (out.kits.length ? `, ${plural(out.kits.length, 'kit')}` : '') +
    (groups.length ? `; ${plural(groups.length, 'song')} ${groups.length === 1 ? 'is' : 'are'} in more than one file: tick the copies to keep${sortNow ? ', then they are sorted into cartridges' : ''}` : '') +
    (sorted ? `; sorted into ${plural(sorted, 'cartridge')}: drag songs between them to change that` : '') +
    (fresh.length && !ui.view.roms.length ? '; now add the LSDj versions they were made with (.gb)' : '') +
    (fresh.length && !sorted && !groups.length && ui.view.roms.length ? `; ${plural(fresh.length, 'song')} not in a cartridge yet` : '') +
    (out.skipped.length ? `. Skipped ${plural(out.skipped.length, 'file')}: ${out.skipped.slice(0, 4).map(s => `${s.name} (${s.why})`).join('; ')}${out.skipped.length > 4 ? '…' : ''}` : '') + '.',
    out.skipped.length ? 'warn' : 'ok');
}

/* ---- songs in more than one file: which copies to keep (the others leave Build; the files are not changed) ---- */
const keepNewest = groups => new Set(groups.map(g => g.songs[0].id));
function askDups(groups, sortIds = null) {
  /* (asked again while asking: the groups already shown keep their ticks) */
  const was = ui.dups, ids = new Set(groups.flatMap(g => g.songs.map(s => s.id)));
  const old = was ? was.groups.filter(g => !g.songs.some(s => ids.has(s.id))) : [];
  const keep = keepNewest(groups);
  for (const g of old) for (const s of g.songs) if (was.keep.has(s.id)) keep.add(s.id);
  ui.dups = {groups: [...old, ...groups], keep, sortIds};
  draw();
}
async function openDups(ids = null) {
  const groups = await call('dups', {ids});
  if (!groups.length) return say('No song is in more than one file now.', 'ok');
  askDups(groups, ui.dups?.sortIds ?? null);
  root.querySelector('.studio-dups')?.scrollIntoView({block: 'nearest'});
}
async function settleDups(keepAll) {
  const d = ui.dups;
  if (!d) return;
  ui.dups = null;
  const drop = keepAll ? new Set() : new Set(d.groups.flatMap(g => g.songs.map(s => s.id)).filter(id => !d.keep.has(id)));
  if (drop.size) {
    /* a copy taken out of a card: a kept copy of the same song that is in no card takes its place there */
    for (const g of d.groups) {
      const spare = g.songs.filter(s => d.keep.has(s.id) && !cartOfSong(s.id)).map(s => s.id);
      for (const s of g.songs) { const c = drop.has(s.id) && spare.length ? cartOfSong(s.id) : null; if (c) c.songIds[c.songIds.indexOf(s.id)] = spare.shift(); }
    }
    for (const c of ui.carts) c.songIds = c.songIds.filter(id => !drop.has(id));
    for (const id of drop) ui.sel.delete(id);
    await call('forget', {ids: [...drop]});
  }
  ui.made = {}; await refresh();
  const left = (d.sortIds ?? []).filter(id => !drop.has(id) && !cartOfSong(id));
  const sorted = left.length && ui.view.roms.length ? await sortLoose(left) : 0;
  say((drop.size ? `${drop.size} ${drop.size === 1 ? 'copy' : 'copies'} left Build (your files are not changed)` : 'Every copy kept') +
    (sorted ? `; sorted into ${plural(sorted, 'cartridge')}: drag songs between them to change that` : '') + '.', 'ok');
}

/* ---- the view (asked of the worker after every change; a newer one replaces an older one) ---- */
async function refresh() {
  const n = ++viewSeq;
  for (let round = 0; round < 64; round++) {
    const v = await call('studio', {req: {carts: ui.carts.map(c => ({id: c.id, lsdjId: c.lsdjId, songIds: c.songIds})), choices: ui.choices, baseId: ui.baseId, mode: ui.mode}, capacity});
    if (n !== viewSeq) return;
    const known = new Set(v.songs.map(s => s.id));
    for (const c of ui.carts) c.songIds = c.songIds.filter(id => known.has(id));
    for (const id of [...ui.sel]) if (!known.has(id)) ui.sel.delete(id);
    ui.view = v; ui.baseId = v.baseId;
    if (!spill()) break;
    ui.made = {};
  }
  draw();
}
const change = f => guard(async () => { f(); ui.made = {}; await refresh(); });
/* the loose songs (ids, else every one not in a card) planned into cards: as few as it takes, each with the LSDj that
   opens its songs, named after their file when they all came from one */
async function sortLoose(ids = null) {
  const loose = ids ?? ui.view.songs.filter(s => !cartOfSong(s.id)).map(s => s.id);
  if (!loose.length) return 0;
  const plan = await call('autosort', {req: {songIds: loose, choices: ui.choices, baseId: ui.baseId}, capacity});
  for (const p of plan) newCart(p.songIds, p.lsdjId === ui.baseId ? null : p.lsdjId, {name: uniqueName(nameFromFile(p.from))});
  ui.made = {}; await refresh();
  return plan.length;
}
function setMode(m) {
  if (ui.mode === m) return;
  ui.mode = m; store.set(MODE, m);
  change(() => {});
}

/* ---- picking songs: ticks (shift: a range), drags ---- */
const inOrder = ids => (ui.view?.songs ?? []).map(s => s.id).filter(id => ids.has(id));
function tick(id, on, range, visible) {
  const at = visible.indexOf(ui.anchor), to = visible.indexOf(id);
  const ids = range && at >= 0 && to >= 0 ? visible.slice(Math.min(at, to), Math.max(at, to) + 1) : [id];
  for (const x of ids) on ? ui.sel.add(x) : ui.sel.delete(x);
  ui.anchor = id; draw();
}
function dragFrom(node, id) {
  node.draggable = true;
  node.ondragstart = e => {
    e.stopPropagation();
    ui.drag = ui.sel.has(id) ? inOrder(ui.sel) : [id];
    e.dataTransfer.setData(DRAG, ui.drag.join(',')); e.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging');
  };
  node.ondragend = () => { ui.drag = null; node.classList.remove('dragging'); root.querySelectorAll('.over').forEach(x => x.classList.remove('over')); };
}
/* a place songs can be dropped on: a card (to: its id), a song in it (before: that song), or the songs list (to: null) */
function dropOn(node, to, before = null) {
  node.ondragover = e => { if (ui.drag) { e.preventDefault(); e.stopPropagation(); node.classList.add('over'); } };
  node.ondragleave = e => { if (!node.contains(e.relatedTarget)) node.classList.remove('over'); };
  node.ondrop = e => {
    if (!ui.drag) return;
    e.preventDefault(); e.stopPropagation(); node.classList.remove('over');
    const ids = ui.drag; ui.drag = null;
    change(() => moveSongs(ids, to, before));
  };
}
function openKits(id) {
  const s = ui.view.songs.find(x => x.id === id);
  ui.kitsOpen = ui.kitsOpen === id ? null : id;
  if (s) ui.groupOpen.set(groupOf(s), true);
  if (ui.kitsOpen && ui.filter !== 'all' && !FILTERS.find(f => f[0] === ui.filter)[2](s)) ui.filter = 'all';
  draw();
  root.querySelector(`.studio-song[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({block: 'nearest'});
}

/* ---- drawing: the top (what to bring, then the three steps) ---- */
function intro(box) {
  const roms = ui.view?.roms ?? [];
  box.append(el('div', {className: 'studio-drop'},
    el('b', {textContent: 'Drop everything here: your LSDj versions and your songs, files or whole folders'}),
    el('span', {className: 'hint', textContent: '.gb · .sav · .lsdsng · .lsdprj · .kit'}),
    el('div', {className: 'row'}, btn('Add files…', () => files.pick.click(), {className: 'primary'}), btn('Add a folder…', () => files.folder.click()))),
  el('ol', {className: 'studio-how'},
    el('li', {}, el('b', {textContent: 'Your LSDj versions (.gb)'}), el('span', {className: 'hint', textContent: roms.length
      ? `Kept from before: ${roms.map(r => r.version).join(', ')}. Add any others you made songs with.`
      : 'Drop your own LSDj ROMs: every version you made songs with. A save holds no samples: they come from the LSDj each song was made with. Kept in this browser, so once is enough.'})),
    el('li', {}, el('b', {textContent: 'Your songs'}), el('span', {className: 'hint', textContent: 'Saves (.sav, up to 32 songs each), single songs (.lsdsng) and projects (.lsdprj, with their own kits). As many as you like.'})),
    el('li', {}, el('b', {textContent: 'Cartridges, sorted for you'}), el('span', {className: 'hint', textContent: 'Songs that share kits go together, every sample kept, in as many cartridges as it takes. Rearrange them, name them, then put them in the DJ crate, install one, or download .gb + .sav.'}))),
  el('p', {className: 'hint', textContent: 'Copies only: your files are not changed, and nothing leaves this browser.'}));
}
const madeParts = () => ui.carts.flatMap(c => ui.made[c.id]?.parts ?? []);
function steps(box) {
  const v = ui.view, roms = [...v.roms].sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true})), songs = v.songs;
  const step = (done, n, title, ...kids) => el('li', {className: 'studio-step' + (done ? ' done' : ' now')},
    el('div', {className: 'studio-step-head'}, el('span', {className: 'studio-step-n', textContent: done ? '✓' : String(n), ariaHidden: 'true'}), el('b', {textContent: title})), ...kids);
  /* 1: the LSDj versions; the highlighted one builds the cards that don't choose their own */
  const vers = el('div', {className: 'studio-vers', role: 'group', ariaLabel: 'Build with'}, ...roms.map(r => {
    const b = btn(`${r.version} · ${plural(r.kits, 'kit')}${r.full ? ' ✓' : ''}`, () => change(() => { ui.baseId = r.id; }),
      {className: 'studio-ver' + (r.id === v.baseId ? ' on' : ''), title: `${r.name}${r.date ? ` (${dayTime(r.date).toLowerCase()})` : ''}: ${r.id === v.baseId ? 'builds the cartridges that don\'t choose their own LSDj' : 'press to build with this one'}. ${r.full ? 'The FM-1 knows this version fully.' : 'It plays, without SYNC, play state or rows in the DJ layout.'}`});
    b.setAttribute('aria-pressed', String(r.id === v.baseId)); return b;
  }));
  /* 3: what Make all makes */
  const cards = ui.carts.filter(c => c.songIds.length), byId = new Map(v.carts.map(p => [p.id, p]));
  const count = cards.reduce((n, c) => n + Math.max(1, byId.get(c.id)?.parts.length ?? 1), 0);
  const losing = cards.filter(c => byId.get(c.id) && !byId.get(c.id).fits).length, loose = songs.filter(s => !cartOfSong(s.id)).length;
  const made = madeParts(), allMade = cards.length && cards.every(c => ui.made[c.id]);
  const fileCount = new Set(songs.map(s => s.from)).size, savs = new Set(songs.filter(s => /\.sav$/i.test(s.from)).map(s => s.from)).size;
  box.append(el('ol', {className: 'studio-steps'},
    step(roms.length, 1, 'Your LSDj versions', roms.length ? vers : el('p', {className: 'warn', textContent: 'None yet: add the LSDj versions your songs were made with.'}),
      el('div', {className: 'row'}, btn('Add LSDj (.gb)…', () => files.rom.click()),
        el('span', {className: 'hint', textContent: roms.length ? `Highlighted: builds the cartridges. ✓: the FM-1 knows it fully (${FULL_LSDJ}). Kept in this browser; remove them in Cartridges.` : 'Each version brings the kits its songs were made with.'}))),
    step(songs.length, 2, 'Your songs', el('div', {textContent: `${plural(songs.length, 'song')} from ${plural(fileCount, 'file')}` + (savs && savs !== fileCount ? ` (${plural(savs, 'save')})` : '')}),
      el('div', {className: 'row'}, btn('Add files…', () => files.pick.click()), btn('Add a folder…', () => files.folder.click()),
        btn('Start again', async () => { await call('clear'); Object.assign(ui, {carts: [], choices: {madeWith: {}, kitPick: {}}, made: {}, query: '', filter: 'all', sel: new Set(), groupOpen: new Map(), kitsOpen: null, labelOpen: null, ask: null, dups: null}); await refresh(); say(''); }, {className: 'studio-link'}))),
    step(allMade, 3, 'Make the cartridges',
      el('div', {textContent: !cards.length ? 'Put songs in a cartridge first.' : `${plural(count, 'cartridge')}${losing ? `; ${plural(losing, 'card')} can't keep every sample` : ', every sample kept'}${loose ? ` · ${loose} songs not in one` : ''}`}),
      el('div', {className: 'row'},
        cards.length && !allMade ? btn(`Make all ${count}`, () => make(cards.map(c => c.id)), {className: 'primary', disabled: !roms.length}) : null,
        made.some(m => !m.added && m.fits) ? btn('Add them all to the crate', async () => { for (const m of made) if (!m.added && m.fits) await addOne(m); }, {className: allMade ? 'primary' : ''}) : null,
        made.length > 1 ? btn('Download all (.zip)', downloadAll) : null))));
}

/* ---- drawing: the songs, grouped by the file they came from (or A to Z) ---- */
const FILTERS = [['all', 'All', () => true], ['loose', 'Not in a cartridge', s => !cartOfSong(s.id)], ['missing', 'Kit missing', s => s.status === 'missing'], ['check', 'Check kits', s => s.status === 'check'],
  ['dups', 'In more than one file', s => s.dups > 1]];
const letterOf = s => { const l = (s.name || '').trim().charAt(0).toUpperCase(); return /[A-Z]/.test(l) ? l : '#'; };
const groupOf = s => ui.by === 'name' ? letterOf(s) : /\.lsdsng$/i.test(s.from) ? '.lsdsng songs' : /\.lsdprj$/i.test(s.from) ? '.lsdprj projects' : s.from;
/* a file's date (its last change, as the computer says: LSDj keeps none), and a song's version (LSDj adds one each
   time the song is saved; in hex, as LSDj shows it) */
const day = t => t ? new Date(t).toLocaleDateString([], {dateStyle: 'medium'}) : '';
const dayTime = t => t ? `File dated ${new Date(t).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}` : 'No file date';
const versionTag = v => el('span', {className: 'studio-vtag', textContent: `v${hex(v ?? 0)}`, title: `Version ${hex(v ?? 0)}: LSDj adds one each time the song is saved`});
const KIT_COLORS = ['#e9a46b', '#e8d36b', '#9fd08a', '#7fc6c0', '#9fb6f0', '#c9a6ef', '#efa6c9', '#c8c2b4'];
const kitColor = name => { let h = 7; for (const ch of name || '?') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return KIT_COLORS[h % KIT_COLORS.length]; };
function kitTag(k) {
  const t = el('span', {className: 'studio-kit' + (k.missing ? ' missing' : '') + (k.silent ? ' silent' : ''), textContent: hex(k.number),
    title: k.silent ? `Kit ${hex(k.number)}: left silent` : k.missing ? `Kit ${hex(k.number)}: not in your LSDj files` : `Kit ${hex(k.number)}: ${k.name || 'kit'}, ${plural(k.samples, 'sample')} played`});
  if (!k.missing && !k.silent) t.style.background = kitColor(k.name);
  return t;
}
function dot(c) { const d = el('span', {className: 'cm-label studio-dot', ariaHidden: 'true'}); paintLabel(d, c.label.color); return d; }
function kitSource(s, k) {
  const key = `${s.id}:${k.number}`, sel = el('select', {className: 'cm-kitpick', onchange: () => change(() => {
    if (sel.value) ui.choices.kitPick[key] = sel.value; else delete ui.choices.kitPick[key]; })});
  sel.setAttribute('aria-label', `${s.name}: kit ${hex(k.number)}`);
  sel.append(new Option(k.missing ? 'Pick a kit…' : 'As found', ''), new Option('Leave silent', 'none'));
  for (const r of ui.view.roms) for (const x of r.slots) sel.append(new Option(`${x.name || 'kit'} (LSDj ${r.version}, kit ${hex(x.number)})`, `rom:${r.id}:${x.number}`));
  for (const f of ui.view.kitFiles) sel.append(new Option(f.name, `kit:${f.id}`));
  sel.value = ui.choices.kitPick[key] ?? '';
  return sel;
}
/* a song's kits, each of which can be pointed at another kit or left silent; which LSDj it was made with */
function kitPanel(s) {
  const box = el('div', {className: 'cm-kits studio-kits'});
  for (const k of s.kits) box.append(el('div', {className: k.missing ? 'bad' : ''}, kitTag(k), ' ',
    k.silent ? 'left silent ' : k.missing ? 'not in your LSDj files ' : `${k.name || 'kit'} `,
    el('span', {className: 'hint', textContent: k.missing || k.silent ? '' : `${plural(k.samples, 'sample')} played, from ${k.source ?? 'the LSDj'} `}), kitSource(s, k)));
  if (s.rule === 'guess') box.append(el('div', {className: 'hint', textContent: 'The project has fewer kits than the song plays: check which is which.'}));
  if (s.kits.length && s.rule == null && ui.view.roms.length > 1) {
    const made = el('select', {className: 'cm-made', onchange: () => change(() => { if (made.value) ui.choices.madeWith[s.id] = made.value; else delete ui.choices.madeWith[s.id]; })},
      new Option(s.madeAuto && s.made ? `${ui.view.roms.find(r => r.id === s.made)?.name} (best fit)` : 'Best fit', ''), ...ui.view.roms.map(r => new Option(`LSDj ${r.version} (${r.name})`, r.id)));
    made.value = ui.choices.madeWith[s.id] ?? ''; made.setAttribute('aria-label', `${s.name}: made with`);
    box.append(el('div', {}, el('span', {className: 'hint', textContent: 'Kits read from the LSDj it was made with: '}), made));
  }
  return box;
}
function moreMenu(s, c) {
  const m = el('select', {className: 'studio-move'});
  m.setAttribute('aria-label', `More for ${s.name}`);
  const to = el('optgroup', {label: 'Move to'});
  for (const x of ui.carts) if (x !== c) to.append(new Option(cartTitle(x), x.id));
  to.append(new Option('New cartridge', '+'));
  if (c) to.append(new Option('Back to the loose songs', '-'));
  m.append(new Option('⋯', ''), to);
  if (s.kits.length) m.append(new Option(ui.kitsOpen === s.id ? 'Hide its kits' : 'Change its kits…', 'kits'));
  m.onchange = () => {
    const v = m.value; m.value = '';
    if (v === 'kits') return openKits(s.id);
    if (v) change(() => v === '+' ? moveSongs([s.id], newCart().id) : moveSongs([s.id], v === '-' ? null : v));
  };
  return m;
}
function songRow(s, visible) {
  const c = cartOfSong(s.id), on = ui.sel.has(s.id);
  const row = el('li', {className: `studio-song is-${s.status}` + (on ? ' sel' : '')});
  row.dataset.id = s.id;
  dragFrom(row, s.id);
  const box = el('input', {type: 'checkbox', checked: on, onclick: e => tick(s.id, box.checked, e.shiftKey, visible)});
  box.setAttribute('aria-label', `Select ${s.name}`);
  const note = s.status === 'missing' ? btn('kit missing', () => openKits(s.id), {className: 'studio-note bad'})
    : s.status === 'check' ? btn('check kits', () => openKits(s.id), {className: 'studio-note warn'}) : null;
  /* its file and date when the list isn't one file a group (A to Z; the .lsdsng songs and projects together) */
  const ownFile = ui.by === 'name' || groupOf(s) !== s.from;
  row.append(el('div', {className: 'studio-song-head'},
    el('span', {className: 'studio-grip', textContent: '⠿', title: 'Drag into a cartridge', ariaHidden: 'true'}), box,
    el('b', {className: 'mono studio-song-name', textContent: s.name}), versionTag(s.version),
    ownFile ? el('span', {className: 'hint studio-from', textContent: [s.from, day(s.date)].filter(Boolean).join(' · '), title: dayTime(s.date)}) : null,
    el('span', {className: 'studio-kittags'}, ...s.kits.map(kitTag)), note,
    s.dups > 1 ? btn(`${s.dups} copies`, () => openDups([s.id]), {className: 'studio-note studio-dupnote', title: `${s.name} is in more than one file: choose which to keep`}) : null,
    el('span', {className: 'studio-where' + (c ? '' : ' loose')}, c ? dot(c) : null, c ? cartTitle(c) : 'not in a cartridge'),
    moreMenu(s, c)));
  if (ui.kitsOpen === s.id) row.append(kitPanel(s));
  return row;
}
function drawSongs(box) {
  const v = ui.view, all = v.songs;
  const q = ui.query.trim().toLowerCase(), f = FILTERS.find(x => x[0] === ui.filter) ?? FILTERS[0];
  /* in the order chosen: as added (by file), A to Z (copies of a song together, the newest first), the newest file first */
  const filtered = all.filter(s => f[2](s) && (!q || `${s.name} ${s.from}`.toLowerCase().includes(q)));
  const shown = ui.by === 'name' ? [...filtered].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}) || b.version - a.version || (b.date ?? 0) - (a.date ?? 0))
    : ui.by === 'newest' ? [...filtered].sort((a, b) => (b.date ?? 0) - (a.date ?? 0)) : filtered;
  const search = el('input', {type: 'search', placeholder: 'Name or file', value: ui.query, className: 'cm-search',
    oninput: () => { ui.query = search.value; const pos = search.selectionStart; draw(); const s2 = root.querySelector('.cm-search'); s2.focus(); s2.setSelectionRange(pos, pos); }});
  search.setAttribute('aria-label', 'Find a song or file');
  const by = el('select', {className: 'studio-by', onchange: () => { ui.by = by.value; store.set(BY, by.value); draw(); }},
    new Option('By file', 'file'), new Option('A to Z', 'name'), new Option('Newest file first', 'newest'));
  by.value = ui.by; by.setAttribute('aria-label', 'Show the songs');
  const dupCount = all.filter(s => s.dups > 1).length;
  box.append(el('div', {className: 'studio-panel-head'}, el('h3', {textContent: 'Songs'}), el('span', {className: 'hint', textContent: plural(all.length, 'song')})),
    el('div', {className: 'studio-searchrow'}, search, by),
    el('div', {className: 'studio-filters', role: 'group', ariaLabel: 'Show'}, ...FILTERS.map(([key, label, test]) => {
      const n = all.filter(test).length;
      if (key !== 'all' && key !== 'loose' && !n) return null;
      const b = btn(`${label} ${n}`, () => { ui.filter = key; draw(); }, {className: `studio-filter ${key}` + (ui.filter === key ? ' on' : '')});
      b.setAttribute('aria-pressed', String(ui.filter === key)); return b;
    }), dupCount && !ui.dups ? btn('Choose which to keep…', () => openDups(), {className: 'studio-link'}) : null));
  /* several ticked: where they go */
  if (ui.sel.size) {
    const put = el('select', {className: 'studio-put', onchange: () => { const to = put.value; if (to) change(() => moveSongs(inOrder(ui.sel), to === '-' ? null : to)); }},
      new Option('Put them in…', ''), ...ui.carts.map(c => new Option(cartTitle(c), c.id)), new Option('Back to the loose songs', '-'));
    put.setAttribute('aria-label', 'Put the ticked songs in');
    box.append(el('div', {className: 'studio-selbar'}, el('b', {textContent: `${ui.sel.size} ticked`}), put,
      btn('New cartridge', () => change(() => moveSongs(inOrder(ui.sel), newCart().id))),
      btn('Untick all', () => { ui.sel.clear(); draw(); }, {className: 'studio-link'})));
  }
  /* the groups: a save each, all .lsdsng songs together, all projects together (A to Z: a letter each); folded when
     there are many songs */
  const groups = new Map(), totals = new Map();
  for (const s of all) totals.set(groupOf(s), (totals.get(groupOf(s)) ?? 0) + 1);
  for (const s of shown) { const g = groupOf(s); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  const folded = all.length > 40 && totals.size > 1 && !q && ui.filter === 'all';
  const visible = [], list = el('div', {className: 'studio-groups'});
  let rows = 0;
  for (const [g, songs] of groups) {
    const open = ui.groupOpen.get(g) ?? !folded;
    const ids = songs.map(s => s.id), ticked = ids.filter(id => ui.sel.has(id)).length;
    const all_ = el('input', {type: 'checkbox', checked: ticked === ids.length, onclick: () => { for (const id of ids) all_.checked ? ui.sel.add(id) : ui.sel.delete(id); draw(); }});
    all_.indeterminate = ticked > 0 && ticked < ids.length; all_.setAttribute('aria-label', `Tick every song in ${g}`);
    const where = [...new Set(songs.map(s => cartOfSong(s.id)).filter(Boolean))], loose = songs.filter(s => !cartOfSong(s.id)).length;
    const whereText = (where.length ? `in ${where.slice(0, 3).map(c => cartTitle(c)).join(', ')}${where.length > 3 ? ` +${where.length - 3}` : ''}` : '') +
      (loose ? `${where.length ? ' · ' : ''}${loose} not in a cartridge` : '');
    const fold = btn(open ? '▾' : '▸', () => { ui.groupOpen.set(g, !open); draw(); }, {className: 'studio-fold'});
    fold.setAttribute('aria-expanded', String(open)); fold.setAttribute('aria-label', `${open ? 'Fold' : 'Unfold'} ${g}`);
    const group = el('section', {className: 'studio-group'}, el('div', {className: 'studio-group-head'}, fold, all_,
      /* its name, and under it how many songs and (one file) the file's date */
      el('span', {className: 'studio-group-title'},
        el('b', {className: 'studio-group-name', textContent: g, onclick: () => { ui.groupOpen.set(g, !open); draw(); }}),
        el('span', {className: 'hint studio-group-meta'}, songs.length === totals.get(g) ? plural(songs.length, 'song') : `${songs.length} of ${plural(totals.get(g), 'song')}`,
          g === songs[0].from && songs[0].date ? ' · ' : null,
          g === songs[0].from && songs[0].date ? el('span', {className: 'studio-group-date', textContent: day(songs[0].date), title: dayTime(songs[0].date)}) : null)),
      el('span', {className: 'hint studio-group-where', textContent: whereText})));
    if (open) {
      const ul = el('ul', {className: 'studio-songs'});
      for (const s of songs) { if (rows++ >= ROWS_MAX) break; visible.push(s.id); ul.append(songRow(s, visible)); }
      group.append(ul);
    }
    list.append(group);
  }
  if (!shown.length) list.append(el('p', {className: 'hint', textContent: q || ui.filter !== 'all' ? 'No match.' : 'No songs yet.'}));
  box.append(list);
  if (rows > ROWS_MAX) box.append(el('p', {className: 'hint', textContent: `Showing ${ROWS_MAX} songs: search or fold some files to find the others.`}));
}

/* ---- drawing: the cartridges ---- */
function meter(label, value, max, text) {
  return el('div', {className: 'studio-meter' + (value > max ? ' over' : '')}, el('span', {}, `${label} `, el('b', {textContent: text})),
    el('span', {className: 'studio-bar'}, el('i', {style: `width:${Math.min(100, value * 100 / max)}%`})));
}
function slotItem(c, s, i, arrows) {
  const li = el('li', {className: 'studio-slotsong'});
  li.dataset.id = s.id;
  dragFrom(li, s.id); dropOn(li, c.id, s.id);
  li.append(el('span', {className: 'studio-n', textContent: two(i + 1)}), el('b', {className: 'mono', textContent: s.name}));
  if (arrows) {
    const at = c.songIds.indexOf(s.id);
    li.append(btn('↑', () => change(() => nudge(c, s.id, -1)), {className: 'studio-arrow', ariaLabel: `Move ${s.name} up`, disabled: at === 0}),
      btn('↓', () => change(() => nudge(c, s.id, 1)), {className: 'studio-arrow', ariaLabel: `Move ${s.name} down`, disabled: at === c.songIds.length - 1}));
  }
  if (s.status === 'missing') li.classList.add('missing');
  return li;
}
const needsOf = m => ({title: m.title, dataCrc: async () => {
  if (m.dataCrc == null) {
    const {slot} = await buildSlot(m.rom, kitSlots(m.rom).filter(s => !s.empty).map(s => s.bank), capacity);
    m.dataCrc = new DataView(slot.buffer).getUint32(16, true);
  }
  return m.dataCrc;
}});
function madeRow(c, m, i, many) {
  const key = `${c.id}:${i}`, row = el('div', {className: 'studio-made'});
  for (const w of m.warnings) row.append(el('p', {className: 'warn', textContent: w}));
  row.append(el('div', {className: 'row'}, many ? el('b', {className: 'studio-made-name', textContent: `${m.title} · ${plural(m.songs.length, 'song')}`}) : null,
    m.added ? el('span', {className: 'ok', textContent: 'In the crate.'}) : btn('Add to the DJ crate', () => addOne(m), {className: many ? '' : 'primary', disabled: !m.fits}),
    btn('Install on the FM-1…', () => { ui.ask = ui.ask === key ? null : key; draw(); }, {disabled: !m.fits}),
    btn('Download .gb + .sav', () => { const n = safeName(m.title); download(zipStore([{name: `${n}.gb`, bytes: m.rom}, {name: `${n}.sav`, bytes: m.sav}]), `${n}.zip`, 'application/zip'); })));
  if (ui.ask === key) row.append(el('div', {className: 'studio-ask', role: 'group', ariaLabel: `Install ${m.title}`},
    el('p', {textContent: `Install ${m.title} on the FM-1? Its LSDj goes to Install: install it there with every kit ticked. When the install is done, its songs are sent by themselves and replace the songs on the FM-1, so back those up first (Songs & kits › Read songs from the FM-1, then Download .sav) if you want to keep them.`}),
    el('div', {className: 'row'}, btn('Go to Install', () => install(m), {className: 'primary'}), btn('Cancel', () => { ui.ask = null; draw(); }))));
  return row;
}
function cartCard(c, p) {
  const v = ui.view, lab = c.label, made = ui.made[c.id], title = cartTitle(c), byId = new Map(v.songs.map(s => [s.id, s]));
  const parts = p?.parts ?? [], many = parts.length > 1, cap = Math.floor(capacity / 1024);
  const card = el('section', {className: 'studio-cart' + (p && !p.fits ? ' unfit' : '') + (many ? ' many' : '')});
  card.setAttribute('aria-label', title); card.dataset.id = c.id;
  dropOn(card, c.id);
  const swatch = el('button', {type: 'button', className: 'cm-label studio-swatch' + (lab.url ? ' with-art' : ''), onclick: () => { ui.labelOpen = ui.labelOpen === c.id ? null : c.id; draw(); }},
    lab.url ? el('img', {src: lab.url, alt: ''}) : null);
  swatch.setAttribute('aria-label', `${title}: label colour and picture`); swatch.setAttribute('aria-expanded', String(ui.labelOpen === c.id));
  paintLabel(swatch, lab.color);
  const own = el('input', {type: 'text', className: 'cm-cartname', value: c.name, placeholder: `Cart ${ui.carts.indexOf(c) + 1}`, maxLength: 60, oninput: () => { c.name = own.value.trim(); ui.made = {}; }});
  own.setAttribute('aria-label', `Cartridge ${ui.carts.indexOf(c) + 1} name`);
  own.onchange = () => draw();
  const withSel = el('select', {className: 'studio-lsdj', onchange: () => change(() => { c.lsdjId = withSel.value || null; })});
  withSel.append(new Option(p?.lsdj ? `LSDj ${p.lsdj.version}${p.lsdj.full ? ' ✓' : ''}` : 'LSDj', ''), ...v.roms.map(r => new Option(`LSDj ${r.version}${r.full ? ' ✓' : ''} (${r.name})`, r.id)));
  withSel.value = c.lsdjId ?? ''; withSel.setAttribute('aria-label', `${title}: built with`);
  withSel.title = c.lsdjId ? 'Chosen for this cartridge' : 'Automatic: the LSDj the page builds with, or one that opens these songs';
  card.append(el('div', {className: 'studio-cart-head'}, swatch, own, many ? el('span', {className: 'studio-many', textContent: `makes ${parts.length} cartridges`}) : null, withSel,
    btn('✕', () => change(() => { moveSongs([...c.songIds], null); ui.carts = ui.carts.filter(x => x !== c); }), {className: 'studio-x', ariaLabel: `Remove ${title} (its songs go back to the loose songs)`, title: 'Remove this cartridge: its songs go back to the loose songs'})));
  if (ui.labelOpen === c.id) card.append(labelEditor({color: lab.color, hasImage: !!lab.img, name: title,
    onColor: col => { lab.color = col; draw(); },
    onImage: f => guard(async () => { lab.img = await shrinkImage(f); if (lab.url) URL.revokeObjectURL(lab.url); lab.url = URL.createObjectURL(new Blob([lab.img], {type: 'image/jpeg'})); draw(); }),
    onNoImage: () => { lab.img = null; if (lab.url) URL.revokeObjectURL(lab.url); lab.url = null; draw(); }}));
  if (p?.lsdj && !p.lsdj.full && c.songIds.length) card.append(el('p', {className: 'hint studio-small', textContent: `With LSDj ${p.lsdj.version} the DJ layout has no SYNC, play state or rows.`}));
  /* what it makes */
  if (parts.length === 1) {
    const x = parts[0];
    card.append(el('div', {className: 'studio-meters'}, meter('Songs', x.songs, SLOTS, `${x.songs}/${SLOTS}`), meter('Space', x.kib, cap, `${x.kib}/${cap} KB`), meter('Blocks', x.blocks, BLOCKS, `${x.blocks}/${BLOCKS}`)),
      el('p', {className: 'hint studio-small', textContent: x.kits ? `${plural(x.kits, 'kit')}: ${x.kitNames.join(', ')}` : 'No kits'}));
  } else if (many) {
    card.append(el('p', {className: 'hint studio-small', textContent: `${plural(c.songIds.length, 'song')}, every sample kept: songs that share kits are in the same cartridge.`}),
      el('ol', {className: 'studio-parts'}, ...parts.map((x, i) => el('li', {}, el('b', {textContent: `${title} ${i + 1}`}), el('span', {textContent: plural(x.songs, 'song')}),
        el('span', {className: 'hint', textContent: plural(x.kits, 'kit')}), el('span', {className: 'studio-bar'}, el('i', {style: `width:${Math.min(100, x.kib * 100 / cap)}%`})),
        el('span', {className: 'hint', textContent: `${x.kib}/${cap} KB`})))));
  }
  /* its songs, in slot order (in each cartridge, when it makes several) */
  const open = ui.showAll.has(c.id);
  if (!c.songIds.length) card.append(el('p', {className: 'hint studio-empty', textContent: 'Drag songs here.'}));
  else if (many) {
    if (open) parts.forEach((x, i) => card.append(el('h4', {className: 'studio-part-name', textContent: `${title} ${i + 1}`}),
      el('ol', {className: 'studio-slots'}, ...x.songIds.map((id, k) => byId.get(id) && slotItem(c, byId.get(id), k, false)))));
  } else {
    const ids = open ? c.songIds : c.songIds.slice(0, SHOWN);
    card.append(el('ol', {className: 'studio-slots'}, ...ids.map((id, k) => byId.get(id) && slotItem(c, byId.get(id), k, open || c.songIds.length <= SHOWN))));
  }
  if (c.songIds.length > SHOWN || (many && c.songIds.length))
    card.append(btn(open ? 'Show fewer' : many ? `Show the songs (${c.songIds.length})` : `Show all ${c.songIds.length} songs`, () => { open ? ui.showAll.delete(c.id) : ui.showAll.add(c.id); draw(); }, {className: 'studio-link'}));
  /* what's wrong with it */
  for (const id of c.songIds) {
    const s = byId.get(id);
    if (s?.status === 'missing') card.append(el('p', {className: 'bad studio-small'}, `${s.name}: kit ${s.kits.filter(k => k.missing).map(k => hex(k.number)).join(', ')} isn't in your LSDj files, so its notes are silent. `,
      btn('Pick a kit', () => openKits(s.id), {className: 'studio-link'})));
  }
  for (const x of parts) {
    for (const l of x.lost) card.append(el('p', {className: 'warn studio-small', textContent: `Won't fit, so silent: ${l}`}));
    if (x.leftOut.length) card.append(el('p', {className: 'warn studio-small', textContent: `Not in this cartridge (its .sav is full): ${x.leftOut.join(', ')}`}));
  }
  for (const s of p?.songs ?? []) if (s.tooNew) card.append(el('p', {className: 'warn studio-small', textContent: `${s.name} was saved by a newer LSDj than this one opens: choose a newer LSDj for this cartridge.`}));
  /* make it; then the crate, Install, or a download */
  const foot = el('div', {className: 'studio-cart-foot'});
  if (made) {
    made.parts.forEach((m, i) => foot.append(madeRow(c, m, i, made.parts.length > 1)));
    if (made.parts.length > 1 && made.parts.some(m => !m.added && m.fits))
      foot.append(btn(`Add all ${made.parts.length} to the DJ crate`, async () => { for (const m of made.parts) if (!m.added && m.fits) await addOne(m); }, {className: 'primary'}));
  } else if (p && c.songIds.length) foot.append(btn(many ? `Make ${parts.length} cartridges` : 'Make this cartridge', () => make([c.id]), {disabled: !p.lsdj}));
  if (foot.childElementCount) card.append(foot);
  return card;
}
function drawCarts(box) {
  const v = ui.view, loose = v.songs.filter(s => !cartOfSong(s.id)).length;
  const mode = (m, text) => { const b = btn(text, () => setMode(m), {className: 'studio-mode' + (ui.mode === m ? ' on' : '')}); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(ui.mode === m)); return b; };
  const group = el('div', {className: 'studio-modes', role: 'radiogroup', ariaLabel: 'When a cartridge is full'}, mode('split', 'It makes more cartridges'), mode('new', 'Start a new card'));
  box.append(el('div', {className: 'studio-carts-head'}, el('h3', {textContent: 'Cartridges'}),
    el('span', {className: 'hint', textContent: 'When one is full:'}), group,
    el('span', {className: 'studio-carts-acts'}, btn('New cartridge', () => { newCart(); ui.made = {}; draw(); }),
      loose && v.roms.length ? btn(`Sort the ${loose} loose songs for me`, async () => { const n = await sortLoose(); say(`Sorted into ${plural(n, 'cartridge')}.`, 'ok'); }) : null)));
  if (!ui.carts.length) {
    box.append(el('p', {className: 'hint studio-empty', textContent: v.roms.length ? 'Drag songs here, or press Sort for me. Each cartridge is one LSDj holding only the kits its songs play, and a .sav with those songs.' : 'Add the LSDj versions your songs were made with: then the songs are sorted into cartridges.'}));
    return;
  }
  const byId = new Map(v.carts.map(p => [p.id, p]));
  box.append(el('div', {className: 'studio-cards'}, ...ui.carts.map(c => cartCard(c, byId.get(c.id)))));
}
/* ---- drawing: songs in more than one file, each copy with its file, date and version; the ticked ones stay ---- */
function drawDups(box) {
  const d = ui.dups, n = d.groups.length, leaving = d.groups.flatMap(g => g.songs).filter(s => !d.keep.has(s.id)).length;
  const list = el('div', {className: 'studio-dups-list'});
  for (const g of d.groups) {
    const fileOf = new Map(g.songs.map(s => [s.id, s.from]));
    const sameDay = new Set(g.songs.map(s => day(s.date))).size < g.songs.length;   /* (then the time tells them apart) */
    const what = g.same ? (g.names.length > 1 ? `the same song, named ${g.names.join(' and ')}` : g.songs.length === 2 ? 'the same in both' : `the same in all ${g.songs.length}`)
      : `${g.versions} different versions`;
    const ul = el('ul', {className: 'studio-dup-copies'});
    g.songs.forEach((s, i) => {
      const tick = el('input', {type: 'checkbox', checked: d.keep.has(s.id), onchange: () => { tick.checked ? d.keep.add(s.id) : d.keep.delete(s.id); draw(); }});
      tick.setAttribute('aria-label', `Keep ${s.name} from ${s.from}`);
      const c = cartOfSong(s.id);
      ul.append(el('li', {className: d.keep.has(s.id) ? '' : 'off'}, el('label', {},
        tick,
        g.names.length > 1 ? el('b', {className: 'mono', textContent: s.name}) : null,
        el('span', {className: 'studio-dup-file', textContent: s.from + (s.slot != null ? ` (song ${hex(s.slot)})` : '')}),
        el('span', {className: 'studio-dup-date', textContent: sameDay ? dayTime(s.date).replace(/^File dated /, '') : day(s.date) || 'no date', title: dayTime(s.date)}),
        versionTag(s.version),
        i === 0 && !g.same ? el('span', {className: 'ok studio-dup-newest', textContent: 'newest'}) : null,
        s.same ? el('span', {className: 'hint', textContent: `same as ${fileOf.get(s.same)}`}) : null,
        c ? el('span', {className: 'hint', textContent: `in ${cartTitle(c)}`}) : null)));
    });
    list.append(el('div', {className: 'studio-dup'},
      el('div', {className: 'studio-dup-head'}, el('b', {className: 'mono', textContent: g.names[0]}), el('span', {className: 'hint', textContent: what})),
      g.unsure ? el('p', {className: 'warn studio-dup-unsure', textContent: `${fileOf.get(g.latest)} is the newest file but holds a lower version: check which to keep.`}) : null,
      ul));
  }
  box.append(el('section', {className: 'studio-dups', ariaLabel: 'Songs in more than one file'},
    el('div', {className: 'studio-dups-top'}, el('h3', {textContent: `${plural(n, 'song')} ${n === 1 ? 'is' : 'are'} in more than one file`}),
      el('span', {className: 'hint', textContent: 'Tick the copies to keep: the newest of each is ticked. The others leave Build; your files are not changed.'})),
    list,
    el('div', {className: 'row studio-dups-acts'},
      btn(leaving ? `Keep these (${leaving} leave)` : 'Keep these', () => settleDups(false), {className: 'primary'}),
      btn('Keep them all', () => settleDups(true)),
      btn('The newest of each', () => { d.keep = keepNewest(d.groups); draw(); }, {className: 'studio-link'}))));
}
function draw() {
  if (!root) return;
  const top = root.querySelector('.studio-top'), pool = root.querySelector('.studio-pool'), carts = root.querySelector('.studio-carts'), grid = root.querySelector('.studio-grid');
  const dupBox = root.querySelector('.studio-dupbox');
  const empty = !ui.view?.songs.length;
  top.replaceChildren(); pool.replaceChildren(); carts.replaceChildren(); dupBox.replaceChildren();
  if (empty) intro(top); else steps(top);
  grid.hidden = empty;
  if (!empty && ui.dups) drawDups(dupBox);
  if (!empty) { drawSongs(pool); drawCarts(carts); }
  root.classList.toggle('busy', !!ui.busy);
  root.classList.toggle('empty', empty);
  if (ui.busy) say(ui.busy);
}

/* ---- making ---- */
async function make(ids) {
  ui.busy = 'Making the cartridges…'; draw();
  const titles = Object.fromEntries(ui.carts.map(c => [c.id, cartTitle(c)]));
  const out = await call('buildstudio', {ids, titles});
  ui.busy = '';
  for (const id of ids) delete ui.made[id];
  for (const m of out) (ui.made[m.id] ??= {parts: []}).parts.push(m);
  say(`${plural(out.length, 'cartridge')} made: add ${out.length > 1 ? 'them' : 'it'} to the DJ crate, install ${out.length > 1 ? 'one' : 'it'} on the FM-1, or download.`, 'ok'); draw();
}
async function markBuilt(m) {
  const id = await hashOf(m.rom);
  store.set(BUILT, JSON.stringify([...new Set([...built(), id])].slice(-500)));
}
async function addOne(m) {
  const c = cartOf(m.id), lab = c?.label ?? {};
  await markBuilt(m);
  await addToCrate({name: m.title, rom: m.rom, sav: m.sav, color: lab.color || 'grey', img: lab.img || null, from: 'made'});
  m.added = true; await sendLibrary();
  say([`${m.title} is in the DJ crate: load it onto a deck in `, el('a', {href: '#live-sec', textContent: 'Perform › DJ'}), '.'], 'ok'); draw();
}
/* to Install with every kit ticked; its songs follow by themselves once the FM-1 reports that LSDj (songs-ui.js) */
async function install(m) {
  await markBuilt(m); await sendLibrary();
  const {sendAfterInstall} = await import('./songs-ui.js');
  sendAfterInstall(m.sav, `${m.title} (made here)`, needsOf(m));
  ui.ask = null;
  document.dispatchEvent(new CustomEvent('install-this-rom', {detail: {rom: m.rom, name: `${safeName(m.title)}.gb`}}));
  say(`${m.title}'s LSDj is in Install with all its kits ticked: install it there, and its songs follow by themselves when it's done.`, 'ok'); draw();
}
function downloadAll() {
  const seen = new Set(), list = [];
  for (const m of madeParts()) {
    let n = safeName(m.title);
    for (let k = 2; seen.has(n); k++) n = `${safeName(m.title)} (${k})`;
    seen.add(n); list.push({name: `${n}.gb`, bytes: m.rom}, {name: `${n}.sav`, bytes: m.sav});
  }
  download(zipStore(list), 'cartridges.zip', 'application/zip');
}

/* ---- the page ---- */
export async function mountStudio(box) {
  let started;
  const was = ready;
  ready = new Promise(r => { started = r; });
  if (!listening) {   /* (mounted again, as the tests do: one set of listeners for the one Studio) */
    listening = true;
    document.addEventListener('kit-library', () => void guard(async () => { await ready; await sendLibrary(); await refresh(); }));
    /* Songs & kits: a save that is full, and the songs that didn't fit it: all of them into cartridges here (also
       when handed over while the Studio is still starting) */
    document.addEventListener('studio-import', e => void guard(async () => { location.hash = '#studio'; await ready; await addFiles(e.detail.files, {sort: true}); }));
  }
  await was;
  try { await mount(box); } finally { started(); }
}
async function mount(box) {
  root = box;
  try { const m = await (await fetch('lsdj/template.json')).json(); if (Number.isInteger(m?.cartridge_capacity)) capacity = m.cartridge_capacity; } catch { /* the usual size */ }
  const input = (props, accept) => { const i = el('input', {type: 'file', multiple: true, hidden: true, ...props}); if (accept) i.accept = accept; i.onchange = () => { const f = [...i.files]; i.value = ''; guard(() => addFiles(f)); }; return i; };
  files.pick = input({}, '.sav,.lsdsng,.lsdprj,.gb,.gbc,.kit');
  files.rom = input({}, '.gb,.gbc');
  files.folder = input({webkitdirectory: true});
  box.append(files.pick, files.rom, files.folder,
    el('div', {className: 'studio-top'}),
    el('p', {className: 'hint studio-status', role: 'status'}),
    el('div', {className: 'studio-dupbox'}),
    el('div', {className: 'studio-grid', hidden: true}, el('div', {className: 'studio-pool'}), el('div', {className: 'studio-carts'})));
  /* files dropped anywhere on the Studio; a song being dragged between cards is not a file */
  box.ondragover = e => { if (!ui.drag && [...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } };
  box.ondragleave = e => { if (e.target === box) box.classList.remove('drop'); };
  box.ondrop = e => { if (ui.drag || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return; e.preventDefault(); box.classList.remove('drop'); const items = [...e.dataTransfer.items]; guard(async () => addFiles(await entriesOf(items))); };
  /* the songs list takes songs dragged back out of a card */
  dropOn(box.querySelector('.studio-pool'), null);
  await guard(async () => { await sendLibrary(); await refresh(); });
}
export const studioState = () => ({...ui, carts: ui.carts.map(c => ({...c}))});
