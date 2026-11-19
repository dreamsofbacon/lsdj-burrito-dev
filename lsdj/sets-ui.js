// SPDX-License-Identifier: GPL-3.0-only
// Songs & kits › "Make an LSDj for your songs": pick songs from any number of .sav and .lsdsng files; the page
// finds the LSDj each was made with (from the user's LSDj files, remembered in this browser: kit-library.js),
// then builds LSDj + .sav pairs ("sets") holding the kit samples the songs play (lsdj-sets.js). Two plans are
// shown: every sample in as many sets as it takes, or one set with the most-played kits. Downloads as a .zip,
// or a set goes to Install (its songs then sent from Songs & kits). Copies only; nothing is uploaded.
import {parseSav, songBytes, readLsdsng, SavError, SAV_SIZE} from './lsdj-sav.js';
import {kitSlots, parseKit, isKitBank, BANK} from './lsdj-kit.js';
import * as S from './lsdj-sets.js';
import {libraryFiles, addToLibrary, removeFromLibrary, clearLibrary, hashOf} from './kit-library.js';
import {zipStore} from './zip.js';
import {songsState, openSave, sendOpenSave, sendAfterInstall, playButton} from './songs-ui.js';
import {buildSlot, checkRomFile} from './lsdj-rom.js';
import {addToCrate} from './crate-ui.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const DEFAULT_CAPACITY = 502016;

const state = {songs: [], template: null, choices: {madeWith: {}, kitPick: {}}, baseId: null, plan: 'split',
  capacity: DEFAULT_CAPACITY, built: new Set(), roms: [], kitFiles: [], result: null};
let root = null, seq = 0;
const say = (text, cls = 'hint') => { const s = root?.querySelector('#sets-status'); if (s) { s.textContent = text; s.className = cls; } };
async function guard(fn) { try { await fn(); } catch (e) { say(e.message, 'bad'); console.error(e); } }
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const safe = t => String(t).trim().replace(/[^A-Za-z0-9 _.-]/g, '_') || 'file';

/* ---- songs ---- */
function addSongs(list, group, from) {
  for (const s of list) state.songs.push({id: `${group}:${s.slot ?? s.name}:${state.songs.length}`, group, from, ticked: true, ...s});
}
function addSav(bytes, from) {
  if (bytes.length === SAV_SIZE + 16) bytes = bytes.subarray(0, SAV_SIZE);
  const sav = parseSav(bytes.slice());
  state.template ??= sav.bytes;
  const list = [];
  for (const s of sav.songs) {
    try { list.push({slot: s.slot, name: s.name, nameBytes: sav.bytes.slice(0x8000 + s.slot * 8, 0x8008 + s.slot * 8), version: s.version, song: songBytes(sav, s.slot)}); }
    catch (e) { if (!(e instanceof SavError)) throw e; }
  }
  addSongs(list, `sav${seq++}`, from);
  return list.length;
}

/* ---- the library: LSDj files and .kit files ---- */
async function loadLibrary() {
  const files = await libraryFiles();
  state.roms = files.filter(f => f.kind === 'rom').map(f => ({id: f.id, name: f.name, rom: f.bytes, slots: kitSlots(f.bytes)}))
    .filter(r => r.slots.length);
  state.kitFiles = files.filter(f => f.kind === 'kit' && isKitBank(f.bytes)).map(f => ({id: f.id, name: f.name, bank: f.bytes.subarray(0, BANK)}));
  const newest = [...state.roms].sort((a, b) => S.compareVersions(S.lsdjVersion(b.rom) ?? [0], S.lsdjVersion(a.rom) ?? [0]))[0];
  if (!state.roms.some(r => r.id === state.baseId)) state.baseId = newest?.id ?? null;
}
async function addFiles(files) {
  const added = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.kit$/i.test(f.name) || (bytes.length === BANK && isKitBank(bytes))) {
      if (!isKitBank(bytes)) throw new SavError(`${f.name} isn't an LSDj .kit file.`);
      await addToLibrary('kit', f.name, bytes.subarray(0, BANK));
    } else {
      try { checkRomFile(bytes, f.name); } catch (e) { throw new SavError(e.message); }
      if (!kitSlots(bytes).length) throw new SavError(`${f.name}: this LSDj has no kit slots, so sets can't put kits in it.`);
      await addToLibrary('rom', f.name, bytes);
    }
    added.push(f.name);
  }
  return added;
}
/* a ROM chosen anywhere on the page joins the library (not the sets the page built) */
export async function rememberRom(rom, name) {
  if (state.built.has(await hashOf(rom))) return;
  await addToLibrary('rom', name, rom);
}

/* ---- plans ---- */
function compute() {
  const base = state.roms.find(r => r.id === state.baseId);
  const picked = state.songs.filter(s => s.ticked);
  if (!base || !picked.length) return null;
  const resolved = S.resolveSongs(picked, state.roms, state.kitFiles, state.choices);
  for (const r of resolved) r.blocks = state.songs.find(s => s.id === r.id).blocks ??= S.blocksOf(r.song);
  const ctx = S.setContext(base.rom, state.capacity);
  return {resolved, ctx, split: S.planSplit(resolved, ctx), most: S.planMost(resolved, ctx)};
}
const kib = n => Math.ceil(n / 1024);

/* ---- drawing ---- */
function sourceOptions(selected) {
  const o = [el('option', {value: '', textContent: 'Pick a kit…'}), el('option', {value: 'none', textContent: 'Leave silent', selected: selected === 'none'})];
  for (const r of state.roms) for (const s of r.slots) if (!s.empty)
    o.push(el('option', {value: `rom:${r.id}:${s.number}`, textContent: `${s.kit.name || 'kit'} (${r.name} kit ${hex(s.number)})`, selected: selected === `rom:${r.id}:${s.number}`}));
  for (const k of state.kitFiles) o.push(el('option', {value: `kit:${k.id}`, textContent: `${parseKit(k.bank).name} (${k.name})`, selected: selected === `kit:${k.id}`}));
  return o;
}
function drawSongs(box, result) {
  if (!state.songs.length) { box.append(el('p', {className: 'hint', textContent: 'No songs yet: add .sav or .lsdsng files, or the songs opened above.'})); return; }
  const byId = new Map((result?.resolved ?? []).map(r => [r.id, r]));
  const t = el('table', {className: 'st-table'});
  t.append(el('tr', {}, el('th'), el('th', {textContent: 'Song'}), el('th', {textContent: 'From'}), el('th', {textContent: 'Made with'}), el('th', {textContent: 'Kits it plays'})));
  for (const s of state.songs) {
    const r = byId.get(s.id);
    const tick = el('input', {type: 'checkbox', checked: s.ticked, onchange: () => { s.ticked = tick.checked; draw(); }});
    const made = el('select', {onchange: () => { if (made.value) state.choices.madeWith[s.id] = made.value; else delete state.choices.madeWith[s.id]; draw(); }},
      el('option', {value: '', textContent: r?.auto && r.rom ? `${r.rom.name} (best fit)` : 'Best fit'}),
      ...state.roms.map(x => el('option', {value: x.id, textContent: x.name, selected: state.choices.madeWith[s.id] === x.id})));
    const kits = el('td');
    if (r) {
      if (!r.kits.length) kits.append(el('span', {className: 'hint', textContent: 'none'}));
      for (const k of r.kits) {
        const key = `${s.id}:${k.number}`, pick = state.choices.kitPick[key];
        const line = el('div', {}, el('b', {textContent: `${hex(k.number)} `}),
          k.bank ? `${k.name || 'kit'} (${plural(k.samples.size, 'sample')})` : el('span', {className: 'bad', textContent: pick === 'none' ? 'left silent ' : 'not in your LSDj files '}));
        if (!k.bank || pick) {
          const sel = el('select', {onchange: () => { if (sel.value) state.choices.kitPick[key] = sel.value; else delete state.choices.kitPick[key]; draw(); }}, ...sourceOptions(pick));
          line.append(sel);
        }
        kits.append(line);
      }
    } else kits.append(el('span', {className: 'hint', textContent: s.ticked ? 'add your LSDj files below' : ''}));
    t.append(el('tr', {}, el('td', {}, tick), el('td', {className: 'mono', textContent: s.name}), el('td', {className: 'hint', textContent: s.from}), el('td', {}, made), kits));
  }
  box.append(t);
}
/* "Listen": each kit's samples with a ▶, drawn when opened (an LSDj can have dozens of kits) */
function listen(kits) {
  const d = el('details', {className: 'sets-listen'}, el('summary', {textContent: 'Listen'}));
  d.ontoggle = () => {
    if (!d.open || d.childElementCount > 1) return;
    for (const {bank, name, number} of kits) {
      const kit = parseKit(bank);
      const line = el('div', {}, el('b', {textContent: `${number == null ? '' : hex(number) + ' '}${kit.name || name}: `}));
      kit.samples.forEach(s => { const n = s.name.replace(/-+$/, '') || `#${s.index + 1}`; line.append(el('span', {className: 'smp'}, playButton(bank, s.index, n), n), ' '); });
      d.append(line);
    }
  };
  return d;
}
function drawLibrary(box) {
  const list = el('ul', {className: 'sets-lib'});
  for (const r of state.roms) list.append(el('li', {}, `${r.name}: LSDj ${S.versionText(S.lsdjVersion(r.rom))}, ${plural(r.slots.filter(s => !s.empty).length, 'kit')} `,
    el('button', {type: 'button', textContent: 'Forget', onclick: () => guard(async () => { await removeFromLibrary(r.id); })}),
    listen(r.slots.filter(s => !s.empty).map(s => ({bank: r.rom.subarray(s.bank * BANK, (s.bank + 1) * BANK), name: `Kit ${hex(s.number)}`, number: s.number})))));
  for (const k of state.kitFiles) list.append(el('li', {}, `${k.name}: kit ${parseKit(k.bank).name} `,
    el('button', {type: 'button', textContent: 'Load', title: 'Put this kit in an empty kit slot of the LSDj chosen in Install',
      onclick: () => document.dispatchEvent(new CustomEvent('install-this-kit', {detail: {bytes: k.bank, name: k.name}}))}), ' ',
    el('button', {type: 'button', textContent: 'Forget', onclick: () => guard(async () => { await removeFromLibrary(k.id); })}),
    listen([{bank: k.bank, name: k.name}])));
  box.append(el('h4', {textContent: 'Your LSDj files and kits'}),
    el('p', {className: 'hint', textContent: 'Kept in this browser on this computer only, so you don\'t have to pick them again. Every LSDj chosen on this page is added. Add the LSDj each song was made with.'}),
    state.roms.length || state.kitFiles.length ? list : el('p', {className: 'warn', textContent: 'None yet: add your LSDj .gb files (and any .kit files).'}));
  if (state.roms.length) {
    const base = el('select', {onchange: () => { state.baseId = base.value; draw(); }},
      ...state.roms.map(r => el('option', {value: r.id, textContent: `${r.name} (LSDj ${S.versionText(S.lsdjVersion(r.rom))})`, selected: r.id === state.baseId})));
    box.append(el('p', {}, 'Build the sets with: ', base, el('span', {className: 'hint', textContent: ' (its program; its own kits are used only when a song plays them)'})));
  }
}
function setTitle(i) { return `Set ${i + 1}`; }
function drawPlans(box, result) {
  if (!result) return;
  const {split, most, ctx} = result;
  const lostSongs = new Set(most.lost.map(l => l.song));
  const opt = (value, label, detail) => el('label', {className: 'sets-plan'},
    el('input', {type: 'radio', name: 'sets-plan', value, checked: state.plan === value, onchange: () => { state.plan = value; draw(); }}), el('b', {textContent: label}), ' ', detail);
  box.append(el('h4', {textContent: 'Plans'}),
    opt('split', split.length === 1 ? 'Everything fits in one set' : `Every sample: ${split.length} sets`,
      split.length === 1 ? 'with every sample the songs play.' : `each an LSDj + .sav; every song gets all its samples${split.some(s => s.over) ? ' (except songs too big for one LSDj on their own)' : ''}.`),
    opt('most', 'One set', most.lost.length || most.leftOut.length
      ? `${plural(most.kits.size, 'kit')}; ${lostSongs.size ? `${plural(lostSongs.size, 'song')} lose samples` : 'no song loses samples'}` +
        `${most.leftOut.length ? `; ${plural(most.leftOut.length, 'song')} don't fit the .sav` : ''}.`
      : 'with every sample (the same as above).'));
  const plans = state.plan === 'most' ? [most] : split;
  const built = plans.map(p => S.buildSet(p, ctx, state.template));
  state.result = {plans, built, ctx};
  const all = el('button', {type: 'button', textContent: plans.length > 1 ? `Download all ${plans.length} sets (.zip)` : 'Download the set (.zip)',
    onclick: () => guard(() => download(zipOf(built.map((b, i) => [b, i]), ctx), 'lsdj-sets.zip'))});
  box.append(el('div', {className: 'row'}, all));
  built.forEach((b, i) => box.append(setCard(b, i, plans[i], ctx)));
  if (state.plan === 'most' && most.leftOut.length) box.append(el('p', {className: 'warn', textContent: `Not in this set (the .sav is full): ${most.leftOut.map(e => e.name).join(', ')}.`}));
}
function setCard(b, i, plan, ctx) {
  const title = setTitle(i);
  const card = el('div', {className: 'sets-card'});
  card.append(el('h4', {textContent: `${title}: ${plural(b.songs.length, 'song')}, ${plural(b.kits.length, 'kit')}, ${kib(b.plan.needed)} of ${Math.floor(ctx.capacity / 1024)} KiB, ${plan.blocks} of 191 blocks`}),
    el('p', {}, el('b', {textContent: 'Songs: '}), b.songs.map(s => s.name + (s.lost.length ? ` (loses ${s.lost.map(l => l.name || 'kit ' + hex(l.kit)).join(', ')})` : '')).join(', ')),
    el('p', {}, el('b', {textContent: 'Kits: '}), b.kits.map(k => `${hex(k.number)} ${k.name} (${k.kept.length}/${k.kept.length + k.dropped.length})`).join(', ') || 'none'));
  for (const w of b.warnings) card.append(el('p', {className: 'warn', textContent: w}));
  card.append(el('div', {className: 'row'},
    el('button', {type: 'button', textContent: `Download ${title} (.zip)`, onclick: () => guard(() => download(zipOf([[b, i]], ctx), `lsdj-set-${i + 1}.zip`))}),
    el('button', {type: 'button', textContent: 'Report', onclick: () => guard(() => download(new TextEncoder().encode(S.setReport(b, title, ctx)), `lsdj-set-${i + 1}.txt`))})),
    el('p', {className: 'hint', textContent: `The kits are in ${title}'s LSDj, the songs in its .sav: Install puts the LSDj on the FM-1, then the songs are sent by themselves. ` +
      `Send only the songs when ${title}'s LSDj is already installed (the page checks; with another LSDj their kit notes play the wrong samples or none).`}),
    el('div', {className: 'row'},
      el('button', {type: 'button', textContent: `Install ${title} on the FM-1 (LSDj + songs)…`, disabled: !b.plan.fits, onclick: () => guard(() => installSet(b, i))}),
      el('button', {type: 'button', textContent: `Send only ${title}'s songs`, onclick: () => guard(async () => {
        openSave(b.sav, `${title} (made here)`, needsOf(b, i));
        await sendOpenSave();
      })}),
      el('button', {type: 'button', textContent: 'Add to the DJ crate', disabled: !b.plan.fits, title: 'Its LSDj and songs, as one crate card: load it onto a deck in Perform › DJ',
        onclick: () => guard(async () => { await addToCrate({name: title, rom: b.rom, sav: b.sav}); say(`${title} is in the DJ crate (Perform › DJ).`, 'ok'); })})));
  return card;
}
/* what the FM-1 must have for a set's songs: its LSDj, as Install builds it with all its kits (the slot data CRC
   the FM-1 reports, lsdj-rom.js buildSlot) */
function needsOf(b, i) {
  return {title: setTitle(i), dataCrc: async () => {
    if (b.dataCrc == null) {
      const {slot} = await buildSlot(b.rom, kitSlots(b.rom).filter(s => !s.empty).map(s => s.bank), state.capacity);
      b.dataCrc = new DataView(slot.buffer).getUint32(16, true);
    }
    return b.dataCrc;
  }};
}
function zipOf(list, ctx) {
  const enc = new TextEncoder(), files = [];
  let csv = '';
  for (const [b, i] of list) {
    const dir = `set-${i + 1}/`;
    files.push({name: dir + `lsdj-set-${i + 1}.gb`, bytes: b.rom}, {name: dir + `lsdj-set-${i + 1}.sav`, bytes: b.sav},
      {name: dir + 'report.txt', bytes: enc.encode(S.setReport(b, setTitle(i), ctx))});
    csv += S.setCsv(b, setTitle(i)).split('\r\n').slice(csv ? 1 : 0).join('\r\n');
  }
  files.push({name: 'kits.csv', bytes: enc.encode(csv)},
    {name: 'README.txt', bytes: enc.encode('Song sets made by the LSDJ Burrito page from your own LSDj files and songs.\n' +
      'Each set-N folder holds an LSDj (.gb) and a save (.sav) to use together (same name, so emulators pair them).\n' +
      'On the FM-1: install the .gb in Install, then send the .sav in Songs & kits.\n' +
      'Kits keep only the samples the songs play; songs point at the kits\' new numbers. Your own files are unchanged.\n')});
  return zipStore(files);
}
async function installSet(b, i) {
  const t = setTitle(i);
  if (!confirm(`Install ${t} on the FM-1?\n\nIts LSDj goes to Install: install it there as usual (leave every kit ticked). ` +
    `When the install is done, this page sends ${t}'s songs by itself, replacing the songs on the FM-1. ` +
    'Back up your songs first (Songs › Back up) if you want to keep them.')) return;
  state.built.add(await hashOf(b.rom));
  sendAfterInstall(b.sav, `${t} (made here)`, needsOf(b, i));
  document.dispatchEvent(new CustomEvent('install-this-rom', {detail: {rom: b.rom, name: `lsdj-set-${i + 1}.gb`}}));
  say(`${t}'s LSDj is in Install with all its kits ticked. Install it there; its songs follow by themselves when it's done.`, 'ok');
}

function draw() {
  if (!root) return;
  const box = root.querySelector('#sets-body');
  box.replaceChildren();
  let result = null;
  try { result = compute(); } catch (e) { say(e.message, 'bad'); console.error(e); }
  drawSongs(box, result);
  drawLibrary(box);
  if (!state.roms.length && state.songs.length) box.append(el('p', {className: 'warn', textContent: 'Add your LSDj files to see which kits the songs need.'}));
  try { drawPlans(box, result); } catch (e) { say(e.message, 'bad'); console.error(e); }
}
async function refresh() { await loadLibrary(); draw(); }

export function mountSetsUi(box) {
  root = box;
  const file = (accept, multiple, f) => {
    const i = el('input', {type: 'file', accept, multiple, hidden: true});
    i.onchange = () => { const x = [...i.files]; i.value = ''; if (x.length) guard(() => f(x)); };
    return i;
  };
  const savIn = file('.sav', true, async fs => {
    let n = 0; for (const f of fs) n += addSav(new Uint8Array(await f.arrayBuffer()), f.name);
    draw(); say(`Added ${plural(n, 'song')}.`, 'ok');
  });
  const songIn = file('.lsdsng', true, async fs => {
    const list = [];
    for (const f of fs) { const s = readLsdsng(new Uint8Array(await f.arrayBuffer())); list.push({...s, slot: null}); }
    addSongs(list, `lsdsng${seq++}`, '.lsdsng'); draw(); say(`Added ${plural(list.length, 'song')}.`, 'ok');
  });
  const libIn = file('.gb,.gbc,.kit', true, async fs => { const a = await addFiles(fs); say(`Added ${a.join(', ')}.`, 'ok'); });
  const b = (text, fn, props = {}) => el('button', {type: 'button', textContent: text, onclick: () => guard(fn), ...props});
  box.replaceChildren(
    el('h3', {className: 'subhead', textContent: 'Make an LSDj for your songs'}),
    el('p', {className: 'hint', textContent: 'Pick songs from any of your saves. The page finds the kits and samples they play in your LSDj files and builds an LSDj with just those (unplayed samples left out to save room) and a .sav with the songs. If they don\'t all fit one FM-1, choose: more sets with every sample, or one set with the kits most songs play. New copies only: your files are not changed.'}),
    el('div', {className: 'row'},
      b('Add .sav files…', () => savIn.click()), savIn,
      b('Add .lsdsng songs…', () => songIn.click()), songIn,
      b('Add the songs opened above', () => {
        const st = songsState();
        if (!st.sav) throw new SavError('Open a .sav above first (or read the songs from the FM-1).');
        const list = st.items.filter(s => s.song).map(s => ({slot: s.slot, name: s.name, nameBytes: s.nameBytes, version: s.version, song: s.song}));
        state.template ??= st.sav.bytes.slice();
        addSongs(list, `open${seq++}`, st.from); draw(); say(`Added ${plural(list.length, 'song')}.`, 'ok');
      }),
      b('Clear the list', () => { state.songs = []; state.template = null; state.choices = {madeWith: {}, kitPick: {}}; draw(); say(''); })),
    el('div', {className: 'row'},
      b('Add LSDj (.gb) or .kit files…', () => libIn.click()), libIn,
      b('Forget all my LSDj files and kits', async () => { if (confirm('Forget every LSDj and .kit file this page remembers? (Your files stay where they are.)')) await clearLibrary(); })),
    el('p', {id: 'sets-status', className: 'hint', role: 'status'}),
    el('div', {id: 'sets-body'}));
  document.addEventListener('kit-library', () => guard(refresh));
  document.addEventListener('install-rom', e => { if (e.detail?.rom) guard(() => rememberRom(e.detail.rom, e.detail.name)); });
  fetch('lsdj/template.json').then(r => r.json()).then(m => { if (Number.isInteger(m?.cartridge_capacity)) { state.capacity = m.cartridge_capacity; draw(); } }).catch(() => {});
  guard(refresh);
}
export const setsState = () => state;
