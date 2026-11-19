// SPDX-License-Identifier: GPL-3.0-only
// The crate's cart maker (Perform › DJ › Crate › New cart…): drop in songs (.sav, .lsdsng, .lsdprj: a project brings
// its own kits) and LSDj ROMs / .kit files, or whole folders. Each song shows the kits it plays and where they come
// from; the page plans carts (every sample in as many carts as it takes, or one cart with the most-played kits) and
// builds each as an LSDj holding only the kits and samples its songs play, plus a .sav: a crate card, ready to load
// onto a deck. The work runs in a worker (cart-worker.js), so the decks keep time. Copies only, kept in this browser.
import {libraryFiles, addToLibrary, hashOf} from './kit-library.js';
import {labelEditor, paintLabel, shrinkImage} from './cart-label.js';
import {FULL_LSDJ} from './lsdj-rom.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }};
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SHOWN = 300;   /* rows drawn at once (a search finds the rest) */
const BUILT = 'cart-built';   /* the ids of LSDj files made here: never a source for matching songs */

let worker = null, nextId = 1, pending = new Map(), panel = null, addCart = null, capacity = 502016;
const ui = {ticked: null, choices: {madeWith: {}, kitPick: {}}, baseId: null, plan: 'split', query: '', prefix: 'Cart', view: null, carts: null, busy: '',
  names: [], labels: []};   /* each cart's own name (typed; '' = the Name box's, numbered) and label {color, img (bytes), url} */
const built = () => { try { return JSON.parse(store.get(BUILT, '[]')) || []; } catch { return []; } };

function call(type, m = {}, transfer = []) {
  worker ??= Object.assign(new Worker(new URL('./cart-worker.js', import.meta.url), {type: 'module'}), {
    onmessage: ({data}) => { const p = pending.get(data.id); pending.delete(data.id); if (p) data.ok ? p.resolve(data.result) : p.reject(Error(data.error)); },
    onerror: e => { for (const p of pending.values()) p.reject(Error(e.message || 'The cart maker stopped.')); pending.clear(); }});
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, {resolve, reject}); worker.postMessage({id, type, ...m}, transfer); });
}
/* songs and their LSDj -> cartridges that fit the FM-1 (cart-core.js fitCarts), worked out off the page's thread */
export const fitInWorker = ({rom, savs, each = false, cap = capacity}) =>
  call('fit', {rom: rom.slice(), savs: savs.map(s => ({name: s.name, bytes: s.bytes.slice()})), capacity: cap, each});
async function sendLibrary() {
  const files = (await libraryFiles()).filter(f => f.kind === 'rom' || f.kind === 'kit').map(f => ({id: f.id, kind: f.kind, name: f.name, bytes: f.bytes}));
  await call('library', {files, built: built()});
}
const say = (text, cls = 'hint') => { const s = panel?.querySelector('.cm-status'); if (s) { s.textContent = text; s.className = `${cls} cm-status`; } };
async function guard(f) { try { await f(); } catch (e) { ui.busy = ''; say(e.message, 'bad'); console.error(e); draw(); } }

/* ---- files: picked, or dropped (folders read all the way down) ---- */
const WANTED = /\.(sav|lsdsng|lsdprj|gbc?|kit)$/i;
async function entriesOf(items) {
  const out = [], walk = async e => {
    if (e.isFile) { if (WANTED.test(e.name)) out.push(await new Promise((res, rej) => e.file(res, rej))); return; }
    const r = e.createReader();
    for (let batch; (batch = await new Promise((res, rej) => r.readEntries(res, rej))).length;) for (const x of batch) await walk(x);
  };
  for (const it of items) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e); else { const f = it.getAsFile?.(); if (f && WANTED.test(f.name)) out.push(f); } }
  return out;
}
async function addFiles(list) {
  list = [...list].filter(f => WANTED.test(f.name));
  if (!list.length) return say('No songs, projects, saves, LSDj files or kits there.', 'warn');
  ui.busy = `Reading ${plural(list.length, 'file')}…`; draw();
  const files = [];
  for (const f of list) files.push({name: f.name, bytes: new Uint8Array(await f.arrayBuffer())});
  const out = await call('add', {files}, files.map(f => f.bytes.buffer));
  for (const r of out.roms) await addToLibrary('rom', r.name, r.bytes);   /* (kept for next time, as Sets keeps them) */
  for (const k of out.kits) await addToLibrary('kit', k.name, k.bytes);
  if (out.roms.length || out.kits.length) await sendLibrary();
  ui.busy = ''; ui.carts = null;
  say(`Added ${plural(out.songs, 'song')}` + (out.roms.length ? `, ${plural(out.roms.length, 'LSDj')}` : '') + (out.kits.length ? `, ${plural(out.kits.length, 'kit')}` : '') +
    (out.skipped.length ? `. Skipped ${plural(out.skipped.length, 'file')}: ${out.skipped.slice(0, 4).map(s => `${s.name} (${s.why})`).join('; ')}${out.skipped.length > 4 ? '…' : ''}` : '') + '.',
    out.skipped.length ? 'warn' : 'ok');
  await refresh();
}

/* ---- the view (asked of the worker after every change; a newer one replaces an older one) ---- */
let viewSeq = 0;
async function refresh() {
  const n = ++viewSeq;
  const v = await call('view', {req: {ticked: ui.ticked ? [...ui.ticked] : null, choices: ui.choices, baseId: ui.baseId, plan: ui.plan}, capacity});
  if (n !== viewSeq) return;
  ui.view = v; ui.baseId = v.baseId; draw();
}
const change = f => guard(async () => { f(); ui.carts = null; await refresh(); });
const isTicked = id => !ui.ticked || ui.ticked.has(id);
function tick(ids, on) {
  ui.ticked ??= new Set(ui.view.songs.map(s => s.id));
  for (const id of ids) on ? ui.ticked.add(id) : ui.ticked.delete(id);
}

/* ---- drawing ---- */
const STATUS = {ok: ['ok', 'kits found'], check: ['warn', 'check its kits'], missing: ['bad', 'kit missing']};
function kitSource(s, k) {
  const key = `${s.id}:${k.number}`, sel = el('select', {className: 'cm-kitpick', onchange: () => change(() => {
    if (sel.value) ui.choices.kitPick[key] = sel.value; else delete ui.choices.kitPick[key]; })});
  sel.setAttribute('aria-label', `${s.name}: kit ${hex(k.number)}`);
  sel.append(new Option(k.missing ? 'Pick a kit…' : 'As found', ''), new Option('Leave silent', 'none'));
  for (const r of ui.view.roms) for (const x of r.slots) sel.append(new Option(`${x.name || 'kit'} (${r.name} kit ${hex(x.number)})`, `rom:${r.id}:${x.number}`));
  for (const f of ui.view.kitFiles) sel.append(new Option(f.name, `kit:${f.id}`));
  sel.value = ui.choices.kitPick[key] ?? '';
  return sel;
}
function songRow(s) {
  const t = el('input', {type: 'checkbox', checked: isTicked(s.id), onchange: () => change(() => tick([s.id], t.checked))});
  t.setAttribute('aria-label', `Put ${s.name} in a cart`);
  const [cls, text] = STATUS[s.status];
  const kits = el('div', {className: 'cm-kits'});
  if (!s.kits.length) kits.append(el('span', {className: 'hint', textContent: 'no kits'}));
  for (const k of s.kits) {
    const line = el('div', {className: k.missing ? 'bad' : ''}, el('b', {textContent: hex(k.number) + ' '}),
      k.silent ? 'left silent ' : k.missing ? 'not in your LSDj files ' : `${k.name || 'kit'} `, el('span', {className: 'hint', textContent: k.missing || k.silent ? '' : `${k.source ?? ''}`}));
    if (k.missing || k.silent || s.status === 'check' || ui.choices.kitPick[`${s.id}:${k.number}`]) line.append(' ', kitSource(s, k));
    kits.append(line);
  }
  const made = s.kits.length && s.rule == null ? el('select', {className: 'cm-made', onchange: () => change(() => {
    if (made.value) ui.choices.madeWith[s.id] = made.value; else delete ui.choices.madeWith[s.id]; })},
    new Option(s.madeAuto && s.made ? `${ui.view.roms.find(r => r.id === s.made)?.name} (best fit)` : 'Best fit', ''),
    ...ui.view.roms.map(r => new Option(r.name, r.id))) : el('span', {className: 'hint', textContent: s.rule ? 'its own kits' : ''});
  if (made.tagName === 'SELECT') { made.value = ui.choices.madeWith[s.id] ?? ''; made.setAttribute('aria-label', `${s.name}: made with`); }
  return el('tr', {className: isTicked(s.id) ? '' : 'off'}, el('td', {}, t), el('td', {}, el('b', {className: 'mono', textContent: s.name}), el('div', {className: 'hint cm-from', textContent: s.from})),
    el('td', {}, el('span', {className: `${cls} cm-chip`, textContent: text}), s.rule === 'guess' ? el('div', {className: 'hint', textContent: 'The project has fewer kits than the song plays: check which is which.'}) : null,
      versionNote(s)),
    el('td', {}, made), el('td', {}, kits));
}
/* a song saved by a newer LSDj than the one chosen (its format): built with another LSDj that opens it, or none can */
function versionNote(s) {
  if (!s.needs) return null;
  const base = ui.view.roms.find(r => r.id === ui.view.baseId), on = ui.view.roms.find(r => r.id === s.on);
  return s.needs === 'moved'
    ? el('div', {className: 'warn cm-needs', textContent: `Saved by a newer LSDj than ${base?.version ?? 'the one chosen'}: it goes in a cart with LSDj ${on?.version} (${on?.name}).`})
    : el('div', {className: 'bad cm-needs', textContent: `Saved by a newer LSDj (song format ${s.format}) than any LSDj here opens: add a newer LSDj, or LSDj ${base?.version ?? ''} won't open it right.`});
}
function drawSongs(box) {
  const v = ui.view;
  if (!v?.songs.length) { box.append(el('p', {className: 'hint cm-empty', textContent: 'Drop songs here: .sav saves, .lsdsng songs, .lsdprj projects (they bring their own kits), and the LSDj (.gb) files and .kit files the songs were made with. Folders too.'})); return; }
  const q = ui.query.trim().toLowerCase(), shown = v.songs.filter(s => !q || `${s.name} ${s.from}`.toLowerCase().includes(q));
  const ids = shown.map(s => s.id), on = v.songs.filter(s => isTicked(s.id)).length;
  const count = {ok: 0, check: 0, missing: 0}; v.songs.forEach(s => isTicked(s.id) && count[s.status]++);
  const search = el('input', {type: 'search', placeholder: 'Find a song or file', value: ui.query, className: 'cm-search',
    oninput: () => { ui.query = search.value; const pos = search.selectionStart; draw(); const s2 = panel.querySelector('.cm-search'); s2.focus(); s2.setSelectionRange(pos, pos); }});
  search.setAttribute('aria-label', 'Find a song or file');
  box.append(el('div', {className: 'row cm-songbar'}, search,
    btn(q ? 'Tick these' : 'Tick all', () => change(() => tick(ids, true))), btn(q ? 'Untick these' : 'Untick all', () => change(() => tick(ids, false))),
    el('span', {className: 'hint', textContent: `${on} of ${plural(v.songs.length, 'song')} ticked: `},
      el('span', {className: 'ok', textContent: `${count.ok} ready`}), count.check ? el('span', {className: 'warn', textContent: `, ${count.check} to check`}) : null,
      count.missing ? el('span', {className: 'bad', textContent: `, ${count.missing} missing a kit`}) : null)));
  const t = el('table', {className: 'st-table cm-table'}, el('tr', {}, el('th'), el('th', {textContent: 'Song'}), el('th', {textContent: 'Kits'}), el('th', {textContent: 'Made with'}), el('th', {textContent: 'Kits it plays'})));
  shown.slice(0, SHOWN).forEach(s => t.append(songRow(s)));
  box.append(t);
  if (shown.length > SHOWN) box.append(el('p', {className: 'hint', textContent: `Showing ${SHOWN} of ${shown.length}: search to find the others.`}));
}
function drawBuild(box) {
  const v = ui.view;
  box.append(el('h4', {textContent: 'Build'}));
  if (!v?.roms.length) { box.append(el('p', {className: 'warn', textContent: 'Add an LSDj (.gb): the carts are built with its program, and it holds the kits for songs made with it.'})); return; }
  const base = el('select', {onchange: () => change(() => { ui.baseId = base.value; })}, ...v.roms.map(r => new Option(`${r.name} (LSDj ${r.version}, ${plural(r.kits, 'kit')})${r.full ? ' ✓ full FM-1 support' : ''}`, r.id)));
  base.value = v.baseId ?? ''; base.setAttribute('aria-label', 'Build the carts with');
  const plan = (value, label) => el('label', {className: 'cm-plan'}, el('input', {type: 'radio', name: 'cm-plan', checked: ui.plan === value, onchange: () => change(() => { ui.plan = value; })}), ' ', label);
  const name = el('input', {type: 'text', value: ui.prefix, maxLength: 24, className: 'cm-name', oninput: () => {
    ui.prefix = name.value.trim() || 'Cart';
    titlesOf(v.plans).forEach((t, i) => { const b = panel.querySelectorAll('.cm-cart .cm-cartname')[i]; if (b && !ui.names[i]) b.placeholder = t; });
  }});
  name.setAttribute('aria-label', 'Cart name');
  box.append(el('label', {className: 'cm-field'}, 'Build with ', base),
    el('p', {className: 'hint', textContent: 'Its program runs the carts. Its kits go in only when a song plays them.'}),
    /* not the LSDj the FM-1 knows fully: the DJ layout loses SYNC, play state and rows on carts made with it */
    v.roms.find(r => r.id === v.baseId)?.full === false ? el('p', {className: 'warn cm-notfull', textContent: v.roms.some(r => r.full)
      ? `The FM-1 knows ${FULL_LSDJ} fully, not this one: carts made with it play, but the DJ layout cannot read their SYNC, what plays or the song rows, and MIDI sync and cues are off. Choose one of those above for them.`
      : `The FM-1 knows ${FULL_LSDJ} fully, not this one: carts made with it play, but the DJ layout cannot read their SYNC, what plays or the song rows, and MIDI sync and cues are off. Add one of those to build with it.`}) : null,
    el('div', {className: 'cm-plans'}, plan('split', 'Every sample (as many carts as it takes)'), plan('most', 'One cart (the kits most songs play)')),
    el('label', {className: 'cm-field'}, 'Name ', name));
  if (!v.plans.length) { box.append(el('p', {className: 'hint', textContent: 'Tick some songs.'})); return; }
  const titles = titlesOf(v.plans);
  for (const [i, p] of v.plans.entries()) {
    const c = ui.carts?.[i], lab = ui.labels[i] ??= {color: 'grey', img: null, url: null};
    /* its own name (empty: the Name box's, numbered) and its label: a colour or a picture, as it shows in the crate */
    const own = el('input', {type: 'text', className: 'cm-cartname', value: ui.names[i] || '', placeholder: defaultTitle(v.plans, i), maxLength: 60,
      oninput: () => { ui.names[i] = own.value.trim(); }});
    own.setAttribute('aria-label', `Cart ${i + 1} name`);
    const swatch = el('span', {className: 'cm-label' + (lab.url ? ' with-art' : '')}, lab.url ? el('img', {src: lab.url, alt: ''}) : null);
    paintLabel(swatch, lab.color);
    const editor = labelEditor({color: lab.color, hasImage: !!lab.img, name: titles[i],
      onColor: col => { lab.color = col; draw(); },
      onImage: f => guard(async () => { lab.img = await shrinkImage(f); if (lab.url) URL.revokeObjectURL(lab.url); lab.url = URL.createObjectURL(new Blob([lab.img], {type: 'image/jpeg'})); draw(); }),
      onNoImage: () => { lab.img = null; if (lab.url) URL.revokeObjectURL(lab.url); lab.url = null; draw(); }});
    const card = el('div', {className: 'cm-cart' + (p.over ? ' over' : '')},
      el('div', {className: 'cm-cart-head'}, swatch, own),
      v.plans.some(x => !x.lsdj.chosen) ? el('p', {className: (p.lsdj.chosen ? 'hint' : 'warn') + ' cm-cartlsdj', textContent: `LSDj ${p.lsdj.version} (${p.lsdj.name})${p.lsdj.chosen ? '' : ': for songs the chosen LSDj can’t open'}${p.lsdj.full ? '' : '; no SYNC, play state or rows in the DJ layout'}`}) : null,
      editor, el('span', {className: 'hint', textContent: ` ${plural(p.songs.length, 'song')}, ${plural(p.kits, 'kit')}, ${p.kib} of ${Math.floor(capacity / 1024)} KB, ${p.blocks} of 191 blocks`}),
      el('div', {className: 'cm-meter'}, el('i', {style: `width:${Math.min(100, p.kib * 102400 / capacity)}%`})),
      el('p', {className: 'cm-cartsongs', textContent: p.songs.join(', ')}));
    for (const l of p.lost) card.append(el('p', {className: 'warn', textContent: `Loses ${l}`}));
    if (p.leftOut.length) card.append(el('p', {className: 'warn', textContent: `Not in this cart (the .sav is full): ${p.leftOut.join(', ')}`}));
    if (c) {
      for (const w of c.warnings) card.append(el('p', {className: 'warn', textContent: w}));
      card.append(c.added ? el('p', {className: 'ok', textContent: 'In the crate.'})
        : btn('Add to the crate', () => guard(() => addOne(c, i)), {className: 'primary', disabled: !c.fits}));
    }
    box.append(card);
  }
  if (!ui.carts) box.append(btn(v.plans.length > 1 ? `Make the ${v.plans.length} carts` : 'Make the cart', () => guard(() => make(titlesOf(v.plans))), {className: 'primary'}));
  else if (ui.carts.some(c => !c.added && c.fits)) box.append(btn('Add them all to the crate', () => guard(async () => { for (const [i, c] of ui.carts.entries()) if (!c.added && c.fits) await addOne(c, i); })));
}
/* the carts' names: each one's own, or the Name box's (as typed now), numbered when there are several */
const defaultTitle = (plans, i) => plans.length > 1 ? `${ui.prefix} ${i + 1}` : ui.prefix;
const titlesOf = plans => plans.map((_, i) => ui.names[i] || defaultTitle(plans, i));
async function make(titles) {
  ui.busy = 'Making the carts…'; draw();
  ui.carts = await call('build', {titles});
  ui.busy = ''; say(`${plural(ui.carts.length, 'cart')} made: add ${ui.carts.length > 1 ? 'them' : 'it'} to the crate.`, 'ok'); draw();
}
async function addOne(c, i) {
  const id = await hashOf(c.rom), name = ui.names[i] || c.title, lab = ui.labels[i] || {};
  store.set(BUILT, JSON.stringify([...new Set([...built(), id])].slice(-500)));
  await addCart({name, rom: c.rom, sav: c.sav, color: lab.color || 'grey', img: lab.img || null});
  c.added = true; await sendLibrary();
  say(`${name} is in the crate: load it onto a deck.`, 'ok'); draw();
}
function draw() {
  if (!panel) return;
  const songs = panel.querySelector('.cm-songs'), side = panel.querySelector('.cm-side');
  songs.replaceChildren(); side.replaceChildren();
  drawSongs(songs); drawBuild(side);
  panel.classList.toggle('busy', !!ui.busy);
  if (ui.busy) say(ui.busy);
}

/* the panel: opened from the crate's bar (crate-ui.js), over the DJ layout; the decks keep playing under it */
export async function openCartMaker({addToCrate, cap} = {}) {
  addCart = addToCrate;
  if (Number.isInteger(cap)) capacity = cap;
  else try { const m = await (await fetch('lsdj/template.json')).json(); if (Number.isInteger(m?.cartridge_capacity)) capacity = m.cartridge_capacity; } catch {}
  if (panel) { panel.hidden = false; await guard(refresh); return; }
  const pick = el('input', {type: 'file', multiple: true, hidden: true, accept: '.sav,.lsdsng,.lsdprj,.gb,.gbc,.kit', onchange: () => { const f = [...pick.files]; pick.value = ''; guard(() => addFiles(f)); }});
  const folder = el('input', {type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: () => { const f = [...folder.files]; folder.value = ''; guard(() => addFiles(f)); }});
  panel = el('section', {className: 'cart-maker', role: 'dialog', ariaLabel: 'New cart'},
    el('div', {className: 'cm-head'}, el('h3', {textContent: 'New cart'}),
      el('p', {className: 'hint', textContent: 'Songs and the kits they play, made into carts for the crate. Each cart\'s LSDj holds only the kits and samples its songs play. Your files are not changed, and nothing leaves this browser.'}),
      btn('✕', () => { panel.hidden = true; }, {className: 'cm-close', ariaLabel: 'Close the cart maker'})),
    el('div', {className: 'row cm-add'}, btn('Add files…', () => pick.click()), pick, btn('Add a folder…', () => folder.click()), folder,
      btn('Start again', () => guard(async () => { await call('clear'); Object.assign(ui, {ticked: null, choices: {madeWith: {}, kitPick: {}}, carts: null, query: ''}); await refresh(); say(''); })),
      el('span', {className: 'hint', textContent: 'or drop them anywhere here'})),
    el('p', {className: 'hint cm-status', role: 'status'}),
    el('div', {className: 'cm-grid'}, el('div', {className: 'cm-songs'}), el('div', {className: 'cm-side'})));
  panel.ondragover = e => { e.preventDefault(); panel.classList.add('drop'); };
  panel.ondragleave = e => { if (e.target === panel) panel.classList.remove('drop'); };
  panel.ondrop = e => { e.preventDefault(); panel.classList.remove('drop'); const items = [...(e.dataTransfer?.items || [])]; guard(async () => addFiles(await entriesOf(items))); };
  panel.onkeydown = e => { if (e.key === 'Escape') panel.hidden = true; };
  document.body.append(panel);
  await guard(async () => { await sendLibrary(); await refresh(); });
  document.addEventListener('kit-library', () => { if (panel && !panel.hidden) void guard(async () => { await sendLibrary(); await refresh(); }); });
}
export const cartMakerState = () => ({...ui, open: !!panel && !panel.hidden});
