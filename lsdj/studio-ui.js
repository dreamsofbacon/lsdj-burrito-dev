// SPDX-License-Identifier: GPL-3.0-only
// The Cartridge Studio (#studio): drop in your LSDj versions and your songs, once; arrange cartridges by dragging songs
// into them (or let the page sort them); point a song's kits somewhere else when it plays several; make them, then put
// them in the DJ crate or download NAME.gb + NAME.sav. The planning is cart-core.js (studioView / autoSort /
// buildStudio) in its own worker (cart-worker.js), so the DJ decks keep time. Copies only, nothing leaves this browser.
import {libraryFiles, addToLibrary, hashOf} from './kit-library.js';
import {labelEditor, paintLabel, shrinkImage} from './cart-label.js';
import {FULL_LSDJ} from './lsdj-rom.js';
import {addToCrate} from './crate-ui.js';
import {zipStore} from './zip.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick: () => guard(onclick), ...props});
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const WANTED = /\.(sav|lsdsng|lsdprj|gbc?|kit)$/i, DRAG = 'application/x-studio-song';
const BUILT = 'cart-built';   /* the ids of LSDj files made by the cart makers: never a source for matching songs (cart-maker.js) */
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};

let root = null, worker = null, nextId = 1, pending = new Map(), capacity = 502016, viewSeq = 0;
const ui = {carts: [], nextCart: 1, choices: {madeWith: {}, kitPick: {}}, baseId: null, query: '', view: null, made: {}, busy: '', open: new Set(), drag: null};

function call(type, m = {}, transfer = []) {
  worker ??= Object.assign(new Worker(new URL('./cart-worker.js', import.meta.url), {type: 'module'}), {
    onmessage: ({data}) => { const p = pending.get(data.id); pending.delete(data.id); if (p) data.ok ? p.resolve(data.result) : p.reject(Error(data.error)); },
    onerror: e => { for (const p of pending.values()) p.reject(Error(e.message || 'The studio stopped.')); pending.clear(); }});
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, {resolve, reject}); worker.postMessage({id, type, ...m}, transfer); });
}
const say = (text, cls = 'hint') => { const s = root?.querySelector('.studio-status'); if (s) { s.textContent = text; s.className = `${cls} studio-status`; } };
async function guard(f) { try { await f(); } catch (e) { ui.busy = ''; say(e.message, 'bad'); console.error(e); draw(); } }
const built = () => { try { return JSON.parse(store.get(BUILT, '[]')) || []; } catch { return []; } };
function download(bytes, name, type = 'application/octet-stream') {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const safeName = t => String(t || 'cartridge').trim().replace(/[^A-Za-z0-9 _().-]+/g, '_').slice(0, 60) || 'cartridge';

/* ---- the carts (what the user arranged) ---- */
const cartOf = id => ui.carts.find(c => c.id === id);
const cartOfSong = id => ui.carts.find(c => c.songIds.includes(id));
const cartTitle = (c, i = ui.carts.indexOf(c)) => c.name || `Cart ${i + 1}`;
function newCart(songIds = [], lsdjId = null) {
  const c = {id: `k${ui.nextCart++}`, name: '', lsdjId, songIds: [...songIds], label: {color: 'grey', img: null, url: null}};
  ui.carts.push(c); return c;
}
/* a song to a cart (before another song there), or back to the loose songs (cartId null) */
function moveSong(id, cartId, beforeId = null) {
  for (const c of ui.carts) c.songIds = c.songIds.filter(x => x !== id);
  const c = cartId && cartOf(cartId);
  if (c) { const at = beforeId ? c.songIds.indexOf(beforeId) : -1; at < 0 ? c.songIds.push(id) : c.songIds.splice(at, 0, id); }
  ui.made = {};
}
function nudge(c, id, by) {
  const i = c.songIds.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= c.songIds.length) return;
  [c.songIds[i], c.songIds[j]] = [c.songIds[j], c.songIds[i]]; ui.made = {};
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
  const files = (await libraryFiles()).filter(f => f.kind === 'rom' || f.kind === 'kit').map(f => ({id: f.id, kind: f.kind, name: f.name, bytes: f.bytes}));
  await call('library', {files, built: built()});
}
async function addFiles(list) {
  list = [...list].filter(f => WANTED.test(f.name));
  if (!list.length) return say('No songs, projects, saves, LSDj files or kits there.', 'warn');
  const before = new Set((ui.view?.songs ?? []).map(s => s.id));
  ui.busy = `Reading ${plural(list.length, 'file')}…`; draw();
  const files = [];
  for (const f of list) files.push({name: f.name, bytes: new Uint8Array(await f.arrayBuffer())});
  const out = await call('add', {files}, files.map(f => f.bytes.buffer));
  for (const r of out.roms) await addToLibrary('rom', r.name, r.bytes);   /* kept for next time: drop them once */
  for (const k of out.kits) await addToLibrary('kit', k.name, k.bytes);
  if (out.roms.length || out.kits.length) await sendLibrary();
  ui.busy = ''; ui.made = {};
  await refresh();
  /* songs arriving with nothing arranged yet: sorted into carts at once; the user then drags them about */
  const fresh = (ui.view?.songs ?? []).filter(s => !before.has(s.id)).map(s => s.id);
  let sorted = 0;
  if (fresh.length && !ui.carts.length && ui.view.roms.length) sorted = await sortLoose(fresh);
  say(`Added ${plural(out.songs, 'song')}` + (out.roms.length ? `, ${plural(out.roms.length, 'LSDj')}` : '') + (out.kits.length ? `, ${plural(out.kits.length, 'kit')}` : '') +
    (sorted ? `; sorted into ${plural(sorted, 'cartridge')}: drag songs between them to change that` : (fresh.length && !ui.view.roms.length ? '; add an LSDj (.gb) to build cartridges with' : '')) +
    (out.skipped.length ? `. Skipped ${plural(out.skipped.length, 'file')}: ${out.skipped.slice(0, 4).map(s => `${s.name} (${s.why})`).join('; ')}${out.skipped.length > 4 ? '…' : ''}` : '') + '.',
    out.skipped.length ? 'warn' : 'ok');
}

/* ---- the view (asked of the worker after every change; a newer one replaces an older one) ---- */
async function refresh() {
  const n = ++viewSeq;
  const known = new Set();
  const v = await call('studio', {req: {carts: ui.carts.map(c => ({id: c.id, lsdjId: c.lsdjId, songIds: c.songIds})), choices: ui.choices, baseId: ui.baseId}, capacity});
  if (n !== viewSeq) return;
  for (const s of v.songs) known.add(s.id);
  for (const c of ui.carts) c.songIds = c.songIds.filter(id => known.has(id));
  ui.view = v; ui.baseId = v.baseId; draw();
}
const change = f => guard(async () => { f(); ui.made = {}; await refresh(); });
/* the loose songs (ids, else every one not in a cart) planned into carts: as few as it takes, each with the LSDj that opens its songs */
async function sortLoose(ids = null) {
  const loose = ids ?? ui.view.songs.filter(s => !cartOfSong(s.id)).map(s => s.id);
  if (!loose.length) return 0;
  const plan = await call('autosort', {req: {songIds: loose, choices: ui.choices, baseId: ui.baseId}, capacity});
  for (const p of plan) newCart(p.songIds, p.lsdjId === ui.baseId ? null : p.lsdjId);
  ui.made = {}; await refresh();
  return plan.length;
}

/* ---- drawing ---- */
const STATUS = {ok: ['ok', 'kits found'], check: ['warn', 'check its kits'], missing: ['bad', 'kit missing']};
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
/* a song: its name, whether its kits were found, the kits it plays (each can be pointed at another), and a way to move it */
function songRow(s, cart = null) {
  const open = ui.open.has(s.id) || s.status === 'missing';
  const row = el('li', {className: `studio-song ${s.status}` + (cart ? ' in-cart' : ''), draggable: true});
  row.dataset.id = s.id;
  row.ondragstart = e => { ui.drag = s.id; e.dataTransfer.setData(DRAG, s.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
  row.ondragend = () => { ui.drag = null; row.classList.remove('dragging'); root.querySelectorAll('.over').forEach(x => x.classList.remove('over')); };
  if (cart) {
    row.ondragover = e => { if (ui.drag) { e.preventDefault(); e.stopPropagation(); row.classList.add('over'); } };
    row.ondragleave = () => row.classList.remove('over');
    row.ondrop = e => { if (!ui.drag) return; e.preventDefault(); e.stopPropagation(); const id = ui.drag; ui.drag = null; if (id !== s.id) change(() => moveSong(id, cart.id, s.id)); };
  }
  const [cls, text] = STATUS[s.status];
  const kitText = s.kits.length ? s.kits.map(k => k.silent ? `${hex(k.number)} silent` : k.missing ? `${hex(k.number)} missing` : `${hex(k.number)} ${k.name || 'kit'}`).join(', ') : 'no kits';
  const move = el('select', {className: 'studio-move'});
  move.setAttribute('aria-label', `Move ${s.name}`);
  move.append(new Option('Move to…', ''));
  for (const c of ui.carts) if (c !== cart) move.append(new Option(cartTitle(c), c.id));
  move.append(new Option('New cartridge', '+'));
  if (cart) move.append(new Option('Back to the loose songs', '-'));
  move.onchange = () => { const to = move.value; if (!to) return; change(() => { if (to === '+') { const c = newCart(); moveSong(s.id, c.id); } else moveSong(s.id, to === '-' ? null : to); }); };
  const head = el('div', {className: 'studio-song-head'},
    el('span', {className: 'studio-grip', textContent: '⠿', title: 'Drag into a cartridge', ariaHidden: 'true'}),
    el('b', {className: 'mono studio-song-name', textContent: s.name}),
    el('span', {className: `${cls} cm-chip`, textContent: text}),
    el('span', {className: 'hint studio-from', textContent: s.from}));
  if (cart) {
    const i = cart.songIds.indexOf(s.id);
    head.append(el('span', {className: 'studio-slot', textContent: `slot ${i + 1}`}),
      btn('↑', () => change(() => nudge(cart, s.id, -1)), {ariaLabel: `Move ${s.name} up`, disabled: i === 0}),
      btn('↓', () => change(() => nudge(cart, s.id, 1)), {ariaLabel: `Move ${s.name} down`, disabled: i === cart.songIds.length - 1}));
  }
  head.append(move);
  row.append(head, el('div', {className: 'studio-kits-line'}, el('span', {className: 'hint', textContent: kitText + ' '}),
    s.kits.length ? btn(open ? 'Hide kits' : 'Change kits', () => { open && s.status !== 'missing' ? ui.open.delete(s.id) : ui.open.add(s.id); draw(); }, {className: 'studio-link'}) : null));
  if (open && s.kits.length) {
    const kits = el('div', {className: 'cm-kits studio-kits'});
    for (const k of s.kits) kits.append(el('div', {className: k.missing ? 'bad' : ''}, el('b', {textContent: hex(k.number) + ' '}),
      k.silent ? 'left silent ' : k.missing ? 'not in your LSDj files ' : `${k.name || 'kit'} `, el('span', {className: 'hint', textContent: k.missing || k.silent ? '' : `${k.source ?? ''} `}), kitSource(s, k)));
    if (s.rule === 'guess') kits.append(el('div', {className: 'hint', textContent: 'The project has fewer kits than the song plays: check which is which.'}));
    if (s.kits.length && s.rule == null && ui.view.roms.length > 1) {
      const made = el('select', {className: 'cm-made', onchange: () => change(() => { if (made.value) ui.choices.madeWith[s.id] = made.value; else delete ui.choices.madeWith[s.id]; })},
        new Option(s.madeAuto && s.made ? `${ui.view.roms.find(r => r.id === s.made)?.name} (best fit)` : 'Best fit', ''), ...ui.view.roms.map(r => new Option(`LSDj ${r.version} (${r.name})`, r.id)));
      made.value = ui.choices.madeWith[s.id] ?? ''; made.setAttribute('aria-label', `${s.name}: made with`);
      kits.append(el('div', {}, el('span', {className: 'hint', textContent: 'Kits read from the LSDj it was made with: '}), made));
    }
    row.append(kits);
  }
  return row;
}
function drawShelf(box) {
  const v = ui.view;
  box.append(el('h3', {textContent: 'Your LSDj versions'}));
  if (!v?.roms.length) { box.append(el('p', {className: 'warn', textContent: 'No LSDj yet. Drop your own LSDj ROMs (.gb): all the versions you have, if you like. Cartridges are built with their program, and each version brings its kits for the songs made with it.'})); return; }
  const tiles = el('ul', {className: 'studio-shelf'});
  for (const r of [...v.roms].sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}))) {
    const t = el('li', {className: 'studio-tile' + (r.id === v.baseId ? ' base' : '') + (r.full ? ' full' : ''), title: `${r.name}: ${r.full ? 'the FM-1 knows this version fully' : 'plays, without SYNC, play state or rows in the DJ layout'}`},
      el('b', {textContent: r.version}), el('span', {className: 'hint', textContent: plural(r.kits, 'kit')}), r.full ? el('span', {className: 'ok', textContent: '✓ full'}) : el('span', {className: 'hint', textContent: 'plays'}));
    tiles.append(t);
  }
  box.append(tiles,
    el('p', {className: 'hint', textContent: `✓ full: ${FULL_LSDJ} (the FM-1 reads SYNC, play state and rows). Kept in this browser; remove them in Cartridges.`}),
    el('label', {className: 'cm-field'}, 'Build with ', (() => {
      const base = el('select', {onchange: () => change(() => { ui.baseId = base.value; })}, ...v.roms.map(r => new Option(`LSDj ${r.version} (${r.name})`, r.id)));
      base.value = v.baseId ?? ''; base.setAttribute('aria-label', 'Build the cartridges with'); return base;
    })(), el('span', {className: 'hint', textContent: ' unless a cartridge says otherwise'})));
}
function drawPool(box) {
  const v = ui.view, loose = (v?.songs ?? []).filter(s => !cartOfSong(s.id));
  box.append(el('h3', {textContent: 'Songs not in a cartridge'}));
  if (!v?.songs.length) { box.append(el('p', {className: 'hint', textContent: 'Drop songs here: .sav saves, .lsdsng songs, .lsdprj projects (they bring their own kits), and .kit files. Folders too.'})); return; }
  const q = ui.query.trim().toLowerCase(), shown = loose.filter(s => !q || `${s.name} ${s.from}`.toLowerCase().includes(q));
  const search = el('input', {type: 'search', placeholder: 'Find a song or file', value: ui.query, className: 'cm-search',
    oninput: () => { ui.query = search.value; const pos = search.selectionStart; draw(); const s2 = root.querySelector('.cm-search'); s2.focus(); s2.setSelectionRange(pos, pos); }});
  search.setAttribute('aria-label', 'Find a song or file');
  box.append(el('div', {className: 'row'}, search, loose.length && v.roms.length ? btn(`Sort these ${loose.length} for me`, async () => { const n = await sortLoose(); say(`Sorted into ${plural(n, 'cartridge')}.`, 'ok'); }) : null,
    el('span', {className: 'hint', textContent: `${loose.length} of ${plural(v.songs.length, 'song')} still loose`})));
  const list = el('ul', {className: 'studio-songs'});
  shown.slice(0, 300).forEach(s => list.append(songRow(s)));
  if (!shown.length) list.append(el('li', {className: 'hint', textContent: loose.length ? 'No match.' : 'Every song is in a cartridge.'}));
  box.append(list);
  if (shown.length > 300) box.append(el('p', {className: 'hint', textContent: `Showing 300 of ${shown.length}: search to find the others.`}));
}
function cartCard(c, p) {
  const v = ui.view, lab = c.label, made = ui.made[c.id], title = cartTitle(c), byId = new Map(v.songs.map(s => [s.id, s]));
  const card = el('section', {className: 'studio-cart' + (p && !p.fits ? ' over' : ''), ariaLabel: title});
  card.dataset.id = c.id;
  card.ondragover = e => { if (ui.drag) { e.preventDefault(); card.classList.add('over'); } };
  card.ondragleave = e => { if (e.target === card) card.classList.remove('over'); };
  card.ondrop = e => { if (!ui.drag) return; e.preventDefault(); card.classList.remove('over'); const id = ui.drag; ui.drag = null; change(() => moveSong(id, c.id)); };
  const own = el('input', {type: 'text', className: 'cm-cartname', value: c.name, placeholder: `Cart ${ui.carts.indexOf(c) + 1}`, maxLength: 60, oninput: () => { c.name = own.value.trim(); ui.made = {}; }});
  own.setAttribute('aria-label', `Cartridge ${ui.carts.indexOf(c) + 1} name`);
  const swatch = el('span', {className: 'cm-label' + (lab.url ? ' with-art' : '')}, lab.url ? el('img', {src: lab.url, alt: ''}) : null);
  paintLabel(swatch, lab.color);
  const editor = labelEditor({color: lab.color, hasImage: !!lab.img, name: title,
    onColor: col => { lab.color = col; draw(); },
    onImage: f => guard(async () => { lab.img = await shrinkImage(f); if (lab.url) URL.revokeObjectURL(lab.url); lab.url = URL.createObjectURL(new Blob([lab.img], {type: 'image/jpeg'})); draw(); }),
    onNoImage: () => { lab.img = null; if (lab.url) URL.revokeObjectURL(lab.url); lab.url = null; draw(); }});
  const withSel = el('select', {onchange: () => change(() => { c.lsdjId = withSel.value || null; })});
  withSel.append(new Option(`Automatic${p?.lsdj ? ` (LSDj ${p.lsdj.version})` : ''}`, ''), ...v.roms.map(r => new Option(`LSDj ${r.version} (${r.name})`, r.id)));
  withSel.value = c.lsdjId ?? ''; withSel.setAttribute('aria-label', `${title}: built with`);
  card.append(el('div', {className: 'cm-cart-head'}, swatch, own,
    btn('✕', () => change(() => { for (const id of c.songIds) moveSong(id, null); ui.carts = ui.carts.filter(x => x !== c); }), {ariaLabel: `Remove ${title} (its songs go back to the loose songs)`, title: 'Remove this cartridge: its songs go back to the loose songs'})),
    editor, el('label', {className: 'cm-field'}, 'LSDj ', withSel));
  if (p?.lsdj && !p.lsdj.full) card.append(el('p', {className: 'hint cm-notfull', textContent: 'The FM-1 does not know this version fully: it plays, but the DJ layout has no SYNC, play state or rows for it.'}));
  if (p) {
    card.append(el('span', {className: 'hint', textContent: `${plural(p.songs.length, 'song')} (of 32), ${plural(p.kits, 'kit')}, ${p.kib} of ${Math.floor(capacity / 1024)} KB, ${p.blocks} of 191 blocks`}),
      el('div', {className: 'cm-meter'}, el('i', {style: `width:${Math.min(100, p.kib * 102400 / capacity)}%`})));
    for (const l of p.lost) card.append(el('p', {className: 'warn', textContent: `Won't fit, so silent: ${l}`}));
    if (p.leftOut.length) card.append(el('p', {className: 'warn', textContent: `Not in this cartridge (its .sav is full): ${p.leftOut.join(', ')}`}));
    for (const s of p.songs) if (s.tooNew) card.append(el('p', {className: 'warn', textContent: `${s.name} was saved by a newer LSDj than this one opens: choose a newer LSDj for this cartridge.`}));
  }
  const list = el('ul', {className: 'studio-songs'});
  for (const id of c.songIds) { const s = byId.get(id); if (s) list.append(songRow(s, c)); }
  if (!c.songIds.length) list.append(el('li', {className: 'hint studio-empty', textContent: 'Drag songs here.'}));
  card.append(list);
  if (made) {
    for (const w of made.warnings) card.append(el('p', {className: 'warn', textContent: w}));
    card.append(el('div', {className: 'row'},
      made.added ? el('span', {className: 'ok', textContent: 'In the crate.'}) : btn('Add to the DJ crate', () => addOne(c, made), {className: 'primary', disabled: !made.fits}),
      btn('Download .gb + .sav', () => { const n = safeName(title); download(zipStore([{name: `${n}.gb`, bytes: made.rom}, {name: `${n}.sav`, bytes: made.sav}]), `${n}.zip`, 'application/zip'); })));
  } else if (p && c.songIds.length) card.append(btn('Make this cartridge', () => make([c.id]), {disabled: !p.lsdj}));
  return card;
}
function drawCarts(box) {
  const v = ui.view;
  box.append(el('h3', {textContent: 'Cartridges'}));
  box.append(el('div', {className: 'row'}, btn('New cartridge', () => { newCart(); ui.made = {}; draw(); }),
    ui.carts.some(c => c.songIds.length) ? btn(ui.carts.every(c => ui.made[c.id]) ? 'Made' : `Make all ${ui.carts.filter(c => c.songIds.length).length}`, () => make(ui.carts.filter(c => c.songIds.length).map(c => c.id)), {className: 'primary', disabled: !v?.roms.length || ui.carts.every(c => !c.songIds.length || ui.made[c.id])}) : null,
    Object.keys(ui.made).length > 1 ? btn('Download all (.zip)', () => {
      const files = ui.carts.filter(c => ui.made[c.id]).flatMap(c => { const n = safeName(cartTitle(c)); return [{name: `${n}.gb`, bytes: ui.made[c.id].rom}, {name: `${n}.sav`, bytes: ui.made[c.id].sav}]; });
      download(zipStore(files), 'cartridges.zip', 'application/zip'); }) : null,
    Object.values(ui.made).some(m => !m.added && m.fits) ? btn('Add them all to the crate', async () => { for (const c of ui.carts) if (ui.made[c.id] && !ui.made[c.id].added && ui.made[c.id].fits) await addOne(c, ui.made[c.id]); }) : null));
  if (!ui.carts.length) { box.append(el('p', {className: 'hint', textContent: v?.songs.length ? 'Drag songs here, or press Sort for me. Each cartridge is one LSDj holding only the kits its songs play, and a .sav with those songs.' : 'Cartridges appear here once you have songs.'})); return; }
  const byId = new Map((v?.carts ?? []).map(p => [p.id, p]));
  for (const c of ui.carts) box.append(cartCard(c, byId.get(c.id)));
}
function draw() {
  if (!root) return;
  const shelf = root.querySelector('.studio-shelfbox'), pool = root.querySelector('.studio-pool'), carts = root.querySelector('.studio-carts');
  shelf.replaceChildren(); pool.replaceChildren(); carts.replaceChildren();
  drawShelf(shelf); drawPool(pool); drawCarts(carts);
  root.classList.toggle('busy', !!ui.busy);
  root.classList.toggle('empty', !ui.view?.songs.length && !ui.view?.roms.length);
  if (ui.busy) say(ui.busy);
}

/* ---- making ---- */
async function make(ids) {
  ui.busy = 'Making the cartridges…'; draw();
  const titles = Object.fromEntries(ui.carts.map(c => [c.id, cartTitle(c)]));
  const out = await call('buildstudio', {ids, titles});
  ui.busy = '';
  for (const m of out) ui.made[m.id] = m;
  say(`${plural(out.length, 'cartridge')} made: add ${out.length > 1 ? 'them' : 'it'} to the DJ crate, or download.`, 'ok'); draw();
}
async function addOne(c, m) {
  const id = await hashOf(m.rom), lab = c.label;
  store.set(BUILT, JSON.stringify([...new Set([...built(), id])].slice(-500)));
  await addToCrate({name: cartTitle(c), rom: m.rom, sav: m.sav, color: lab.color || 'grey', img: lab.img || null, from: 'made'});
  m.added = true; await sendLibrary();
  say(`${cartTitle(c)} is in the DJ crate: load it onto a deck (Perform › DJ).`, 'ok'); draw();
}

/* ---- the page ---- */
export async function mountStudio(box) {
  root = box;
  try { const m = await (await fetch('lsdj/template.json')).json(); if (Number.isInteger(m?.cartridge_capacity)) capacity = m.cartridge_capacity; } catch { /* the usual size */ }
  const pick = el('input', {type: 'file', multiple: true, hidden: true, accept: '.sav,.lsdsng,.lsdprj,.gb,.gbc,.kit', onchange: () => { const f = [...pick.files]; pick.value = ''; guard(() => addFiles(f)); }});
  const folder = el('input', {type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: () => { const f = [...folder.files]; folder.value = ''; guard(() => addFiles(f)); }});
  box.append(
    el('p', {className: 'hint', textContent: 'Drop your LSDj ROMs and your songs here, all at once if you like. Arrange cartridges by dragging songs into them, or let the page sort them. Each cartridge is an LSDj holding only the kits its songs play, plus a .sav. Your files are not changed, and nothing leaves this browser.'}),
    el('div', {className: 'studio-drop'}, el('b', {textContent: 'Drop files or folders here'}), ' ', btn('Add files…', () => pick.click()), pick, btn('Add a folder…', () => folder.click()), folder,
      btn('Start again', async () => { await call('clear'); Object.assign(ui, {carts: [], choices: {madeWith: {}, kitPick: {}}, made: {}, query: '', open: new Set()}); await refresh(); say(''); })),
    el('p', {className: 'hint studio-status', role: 'status'}),
    el('div', {className: 'studio-shelfbox'}),
    el('div', {className: 'studio-grid'}, el('div', {className: 'studio-pool'}), el('div', {className: 'studio-carts'})));
  /* files dropped anywhere on the page's Studio; a song being dragged between cartridges is not a file */
  box.ondragover = e => { if (!ui.drag && [...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } };
  box.ondragleave = e => { if (e.target === box) box.classList.remove('drop'); };
  box.ondrop = e => { if (ui.drag || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return; e.preventDefault(); box.classList.remove('drop'); const items = [...e.dataTransfer.items]; guard(async () => addFiles(await entriesOf(items))); };
  /* the pool takes a song dragged back out of a cartridge */
  const pool = box.querySelector('.studio-pool');
  pool.ondragover = e => { if (ui.drag) { e.preventDefault(); pool.classList.add('over'); } };
  pool.ondragleave = e => { if (e.target === pool) pool.classList.remove('over'); };
  pool.ondrop = e => { if (!ui.drag) return; e.preventDefault(); pool.classList.remove('over'); const id = ui.drag; ui.drag = null; change(() => moveSong(id, null)); };
  await guard(async () => { await sendLibrary(); await refresh(); });
  document.addEventListener('kit-library', () => void guard(async () => { await sendLibrary(); await refresh(); }));
}
export const studioState = () => ({...ui, carts: ui.carts.map(c => ({...c}))});
