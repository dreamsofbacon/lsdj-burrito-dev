// SPDX-License-Identifier: GPL-3.0-only
// Perform › Master: the FM-1's 8 presets (FM-1 0.9.98-dev.6, lsdj/presets.js). A click loads one, as EDIT + its key
// does on the FM-1; Manage… keeps the FM-1's current state in a slot, names, exports, imports and clears them.
// app.js gives: link() (the FM-1 in use), run(statusId, fn) (one device operation at a time), say(id, text, cls),
// download(bytes, name, type), firmware() (its id, for files), afterLoad() (read its settings, MIDI, switches and
// colours again: a preset brings them all).
import {SLOTS, KEYS, fromSlot, toSlot, presetFile, bankFile, readPresetFile, fileName, summary, cleanName} from './presets.js';

const $ = id => document.getElementById(id);
let deps = null, shown = false, list = null, slots = null, importTo = -1;
/* the presets' device operations one after another (a name changed while the last one runs is not lost) */
let queue = Promise.resolve();
const queued = (statusId, fn) => (queue = queue.then(() => deps.run(statusId, fn)));

export function initPresets(d) {
  deps = d;
  $('preset-manage').onclick = () => openManage();
  $('preset-dlg-close').onclick = () => $('preset-dlg').close();
  $('preset-export-all').onclick = () => op('Exporting all presets…', async l => {
    const all = await readAll(l);
    deps.download(new TextEncoder().encode(bankFile(all, deps.firmware())), `lsdj-burrito-presets-${stamp()}.json`, 'application/json');
    return `Exported ${all.filter(Boolean).length} presets (all 8 slots) to one file.`;
  });
  $('preset-import-pick').onclick = () => { importTo = -1; $('preset-import').click(); };
  $('preset-import').onchange = e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const to = importTo;
    op(`Reading ${file.name}…`, async l => {
      const f = readPresetFile(await file.text());
      if (f.kind === 'bank') {
        if (to >= 0) throw Error(`${file.name} holds all 8 slots: use Import file… below the list.`);
        if (!confirm(`Replace all 8 presets on the FM-1 with the ones in ${file.name}? Empty slots in the file empty them on the FM-1.`)) return 'Nothing changed.';
        for (let i = 0; i < SLOTS; i++) await put(l, i, f.presets[i]);
        return `Imported all 8 slots from ${file.name}.`;
      }
      let i = to;
      if (i < 0) { i = (list?.names || []).findIndex(n => n === null); if (i < 0) throw Error('Every slot holds a preset: use Import… on the slot to replace.'); }
      else if (list?.names[i] && !confirm(`Replace preset ${i + 1} (${list.names[i]}) with ${f.preset.name}?`)) return 'Nothing changed.';
      await put(l, i, f.preset);
      return `Imported ${f.preset.name} into slot ${i + 1} (${KEYS[i]}).`;
    });
  };
}
/* the FM-1 in use has presets (INFO): the row shows */
export function presetsShown(on) {
  shown = on; $('preset-row').hidden = !on;
  if (!on) { list = null; slots = null; if ($('preset-dlg').open) $('preset-dlg').close(); drawRow(); }
}
/* read the list (the live poll, now and then): true if the current slot changed meanwhile (EDIT + a key on the
   FM-1), so app.js reads the rest again */
export async function readPresetList(l) {
  if (!shown || !l) return false;
  const before = list?.current, got = await l.presetList();
  const changed = list !== null && got.current !== before;
  if (JSON.stringify(got) !== JSON.stringify(list)) {   /* (a note about the old list goes) */
    if (list) deps.say('preset-note', '');
    list = got; drawRow(); if ($('preset-dlg').open && changed) drawManage();
  }
  return changed;
}

function drawRow() {
  const box = $('preset-slots'); box.replaceChildren();
  for (let i = 0; i < SLOTS; i++) {
    const name = list?.names[i] ?? null, b = document.createElement('button');
    b.type = 'button'; b.className = 'preset-slot' + (name ? '' : ' empty') + (list?.current === i ? ' on' : '');
    b.innerHTML = `<b>${i + 1}</b> <span></span>`; b.lastChild.textContent = name || '—';
    b.title = name ? `Load ${name} (on the FM-1: hold EDIT, press ${KEYS[i]})` : `Slot ${i + 1} is empty. Keep the FM-1's current state here: Manage…, or on the FM-1 hold EDIT, press SELECT, then ${KEYS[i]}.`;
    b.setAttribute('aria-pressed', String(list?.current === i));
    b.onclick = () => load(i);
    box.append(b);
  }
}
function load(i) {
  const name = list?.names[i];
  if (!name) return deps.say('preset-note', `Slot ${i + 1} is empty. Keep a preset there with Manage…, or on the FM-1: hold EDIT, press SELECT, then ${KEYS[i]}.`, 'warn');
  queued('preset-note', async () => {
    const l = deps.link();
    if (await l.presetLoad(i) === 'empty') throw Error(`Slot ${i + 1} is empty on the FM-1.`);
    await deps.afterLoad();
    await readPresetList(l);
    deps.say('preset-note', `Loaded ${name}.`, 'ok');
  });
}

/* ---------- Manage… ---------- */
async function readAll(l) {
  const all = [];
  for (let i = 0; i < SLOTS; i++) all.push(fromSlot(await l.presetGet(i)));
  return all;
}
/* a preset (or null: empty) into slot i; the FM-1 checks every value */
async function put(l, i, p) {
  if (!await l.presetPut(i, toSlot(p))) throw Error(`The FM-1 refused ${p?.name || 'it'} for slot ${i + 1}: a value doesn't fit its firmware (update it).`);
}
/* one device operation from the dialog: its message in the dialog, then the list and rows read again (also after a
   refusal: the rows show what the FM-1 holds) */
function op(working, fn) {
  return queued('preset-dlg-status', async () => {
    const l = deps.link();
    deps.say('preset-dlg-status', working);
    let done, err;
    try { done = await fn(l); } catch (e) { err = e; }
    list = null; await readPresetList(l).catch(() => {});
    slots = await readAll(l); drawManage();
    if (err) throw err;
    deps.say('preset-dlg-status', done, 'ok');
  });
}
function openManage() {
  const dlg = $('preset-dlg');
  slots = null; drawManage(); dlg.showModal();
  queued('preset-dlg-status', async () => {
    deps.say('preset-dlg-status', 'Reading the presets…');
    const l = deps.link(); slots = await readAll(l); list = null; await readPresetList(l); drawManage();
    deps.say('preset-dlg-status', '');
  });
}
function drawManage() {
  const body = $('preset-table'); body.replaceChildren();
  for (let i = 0; i < SLOTS; i++) {
    const p = slots?.[i] ?? null, tr = document.createElement('tr');
    if (list?.current === i) tr.className = 'on';
    const th = document.createElement('th'); th.innerHTML = `${i + 1}<span class="hint"> · ${KEYS[i]}</span>`;
    const name = document.createElement('input');
    name.maxLength = 12; name.value = p?.name || ''; name.placeholder = p ? '' : 'empty'; name.setAttribute('aria-label', `Preset ${i + 1} name`);
    name.disabled = !slots;
    name.onchange = () => {
      const v = cleanName(name.value);
      if (!p) return deps.say('preset-dlg-status', `Slot ${i + 1} is empty: the name is used when you press Keep current here.`);
      if (!v) { name.value = p.name; return deps.say('preset-dlg-status', 'A name needs letters or numbers.', 'warn'); }
      if (v === p.name) { name.value = v; return; }
      op(`Renaming ${p.name}…`, async l => { await put(l, i, {...p, name: v}); return `Renamed to ${v}.`; });
    };
    const what = document.createElement('td'); what.className = 'hint'; what.textContent = p ? summary(p) : slots ? 'empty' : '…';
    const acts = document.createElement('td'); acts.className = 'preset-acts';
    const btn = (text, title, fn, off = false) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.disabled = off || !slots; b.onclick = fn; acts.append(b); };
    btn('Load', `Load it now (on the FM-1: EDIT + ${KEYS[i]})`, () => { $('preset-dlg').close(); load(i); }, !p);
    btn('Keep current here', 'Keep everything the FM-1 has now (effects, settings, MIDI, switches, colours) in this slot', () => {
      const n = cleanName(name.value) || null;
      if (p && !confirm(`Replace preset ${i + 1} (${p.name}) with the FM-1's current state?`)) return;
      op('Keeping the current state…', async l => { await l.presetSave(i, n); return `Kept the FM-1's current state in slot ${i + 1}${n ? ` as ${n}` : ''}.`; });
    });
    btn('Export', 'Save this preset as a file', () => {
      deps.download(new TextEncoder().encode(presetFile(p, deps.firmware())), fileName(p, i), 'application/json');
      deps.say('preset-dlg-status', `Exported ${p.name} as ${fileName(p, i)}.`, 'ok');
    }, !p);
    btn('Import…', 'Load a preset file into this slot', () => { importTo = i; $('preset-import').click(); });
    btn('Clear', 'Empty this slot', () => {
      if (!confirm(`Empty preset ${i + 1} (${p.name})?`)) return;
      op('Clearing…', async l => { await put(l, i, null); return `Slot ${i + 1} is empty.`; });
    }, !p);
    tr.append(th, Object.assign(document.createElement('td'), {className: 'preset-name'}), what, acts);
    tr.children[1].append(name);
    body.append(tr);
  }
}
const stamp = () => new Date().toISOString().slice(0, 10);
