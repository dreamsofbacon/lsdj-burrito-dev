// SPDX-License-Identifier: GPL-3.0-only
// The Cartridges tab (#carts): every LSDj kept in this browser (cartridges.js) in one place: its version, whether
// it's a tested build, its kits (with ▶), the kits Install puts on the FM-1, where it came from; Install it, use
// it in Songs and kits, rename, download, forget; the .kit files; clean up the copies kit edits leave. And the one
// cartridge picker Install and Songs and kits use (cartPicker). The cartridge plan, phase 2.
import {cartridges, cartName, originText, addCartridge, renameCartridge, installCart, crateUses, inBetweenCopies,
  cleanUp, forgetCartridge, matchCart, notePrint} from './cartridges.js';
import {libraryFiles, addToLibrary, removeFromLibrary, storageState} from './kit-library.js';
import {identifyRom, listKits, checkRomFile} from './lsdj-rom.js';
import {lsdjLabel} from './lsdj-sets.js';
import {isKitBank, parseKit, BANK} from './lsdj-kit.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, fn, props = {}) => el('button', {type: 'button', textContent: text, onclick: () => guard(fn), ...props});
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let root = null, catalog = null, connected = false;
let onFm1 = null;   /* {id, fm1}: the cartridge the FM-1 in use has, when last checked */
const ids = new Map();   /* cartridge id -> identifyRom's answer (tested or not), worked out once */

const say = (text, cls = 'hint') => { const s = root?.querySelector('#carts-status'); if (s) { s.textContent = text; s.className = cls; } };
async function guard(fn) { try { await fn(); } catch (e) { say(e.message, 'bad'); console.error(e); } }
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const fileName = c => cartName(c).replace(/[^\w .()-]+/g, '-').replace(/(\.gbc?)?$/i, '.gb');

/* ---- the one picker: a list of the cartridges; onPick(entry) ---- */
export function cartPicker({id, label = 'From my cartridges', onPick}) {
  const sel = el('select', {id, ariaLabel: label, title: 'An LSDj kept in this browser (Cartridges)'});
  const fill = async () => {
    const list = await cartridges();
    sel.replaceChildren(el('option', {value: '', textContent: list.length ? `${label}…` : `${label}: none yet`}),
      ...list.map(c => el('option', {value: c.id, textContent: `${cartName(c)} · LSDj ${lsdjLabel(c.bytes)}`})));
    sel.disabled = !list.length;
  };
  sel.onchange = () => guard(async () => {
    const c = (await cartridges()).find(x => x.id === sel.value);
    sel.value = '';
    if (c) await onPick(c);
  });
  document.addEventListener('kit-library', () => void fill());
  void fill();
  return sel;
}

/* ---- the FM-1's cartridge (phase 3) ---- */
/* reads the LSDj on the FM-1 in use and keeps it as a cartridge, with the CRC that FM-1 reports -> the entry */
export async function readAndKeep(progress = () => {}) {
  const [{readInstalledCartridge, installedCartInfo}, {romFromSlot}] = await Promise.all([import('./app.js'), import('./lsdj-rom.js')]);
  const {fm1} = await installedCartInfo();
  const slot = await readInstalledCartridge(progress);
  const rom = romFromSlot(slot), crc = new DataView(slot.buffer, slot.byteOffset).getUint32(16, true) >>> 0;
  const c = await addCartridge(rom, `LSDj read from ${fm1.replace(/^The /, 'the ')} ${new Date().toLocaleDateString([], {dateStyle: 'medium'})}.gb`, {from: 'fm1', fm1});
  await notePrint(c.id, crc, listKits(rom).map(k => k.bank));
  onFm1 = {id: c.id, fm1};
  return c;
}
/* which cartridge the FM-1 in use has -> {fm1, cart, kits} (cart null: one not kept here). Throws if it can't tell */
export async function fm1Cartridge() {
  const {installedCartInfo} = await import('./app.js');
  const info = await installedCartInfo();
  const m = await matchCart(info.dataCrc);
  onFm1 = m ? {id: m.cart.id, fm1: info.fm1} : null;
  return {fm1: info.fm1, cart: m?.cart ?? null, kits: m?.kits ?? null};
}
/* before an install from Install (install-ui.js): an LSDj on the FM-1 that isn't kept here would be gone for good
   with any kits only it has, so a copy is offered first. -> false: stop (nothing installed) */
export async function keepBeforeInstall(log = () => {}) {
  let r;
  try { r = await fm1Cartridge(); }
  catch (e) { log(`Couldn't tell which LSDj the FM-1 has (${e.message}): no copy of it was kept first.`); return true; }
  if (r.cart) { log(`${r.fm1} has ${cartName(r.cart)}: it's kept in Cartridges.`); return true; }
  if (!confirm(`${r.fm1} has an LSDj that isn't kept in this browser. Any kits only it has would be gone for good after this install.\n\n` +
    'OK: keep a copy in Cartridges first (read from the FM-1; nothing is written to it).\nCancel: install without a copy.')) {
    log(`${r.fm1}: installing without a copy of its LSDj (you chose to).`); return true;
  }
  try {
    log(`Reading the LSDj on ${r.fm1} to keep a copy…`);
    const c = await readAndKeep();
    log(`Kept ${cartName(c)} in Cartridges.`);
    return true;
  } catch (e) {
    log(`The copy couldn't be read (${e.message}). Nothing was installed.`);
    return false;
  }
}
async function drawFm1(check = false) {
  const box = root?.querySelector('#carts-fm1');
  if (!box) return;
  const line = (text, cls, ...more) => box.replaceChildren(el('span', {className: cls, textContent: text}), ...more);
  const checkBtn = btn('Check which LSDj the FM-1 has', () => drawFm1(true));
  if (!check) return line(connected ? '' : 'Connect an FM-1 (My FM-1) to see which of these it has.', 'hint', checkBtn);
  line('Asking the FM-1 which LSDj it has…', 'hint');
  try {
    const r = await fm1Cartridge();
    if (r.cart) line(`${r.fm1} has ${cartName(r.cart)} (${plural(r.kits.length, 'kit')}).`, 'ok', ' ', checkBtn);
    else line(`${r.fm1} has an LSDj that isn't kept here: kits only it has exist nowhere else in this browser. `, 'warn',
      btn('Keep a copy (read it)', async () => {
        line('Reading the LSDj on the FM-1 (nothing is written to it)…', 'hint');
        const c = await readAndKeep((n, t) => line(`Reading the LSDj on the FM-1: ${Math.round(100 * n / t)} %. Nothing is written to it.`, 'hint'));
        line(`Kept ${cartName(c)}. It's what ${r.fm1} has.`, 'ok', ' ', checkBtn);
      }, {className: 'primary'}), ' ', checkBtn);
  } catch (e) { line(`Couldn't tell: ${e.message}`, 'warn', ' ', checkBtn); }
  void draw();
}

/* ---- the tab ---- */
async function tested(c) {
  if (ids.has(c.id)) return ids.get(c.id);
  catalog ??= await fetch('lsdj/versions.json').then(r => r.json()).catch(() => []);
  const info = await identifyRom(c.bytes, catalog).catch(() => null);
  ids.set(c.id, info);
  return info;
}
function kitList(c) {
  const d = el('details', {className: 'cart-kits'}, el('summary', {textContent: 'Kits'}));
  d.ontoggle = () => {
    if (!d.open || d.childElementCount > 1) return;
    const kits = listKits(c.bytes), keep = c.kits ? new Set(c.kits) : null;
    if (!kits.length) { d.append(el('p', {className: 'hint', textContent: 'No sample kits.'})); return; }
    void import('./songs-ui.js').then(({playButton}) => {
      for (const k of kits) {
        const bank = c.bytes.subarray(k.bank * BANK, (k.bank + 1) * BANK), kit = parseKit(bank);
        const line = el('div', {}, el('b', {textContent: `${hex(k.bank)} ${k.name || '(unnamed)'}`}),
          keep && !keep.has(k.bank) ? el('span', {className: 'hint', textContent: ' · left out by Install'}) : null, ': ');
        kit.samples.forEach(s => { const n = s.name.replace(/-+$/, '') || `#${s.index + 1}`; line.append(el('span', {className: 'smp'}, playButton(bank, s.index, n), n), ' '); });
        d.append(line);
      }
    });
  };
  return d;
}
function card(c, byId) {
  const kits = listKits(c.bytes), crate = crateUses(c.id).length, mine = installCart() === c.id;
  const status = el('span', {className: 'hint', textContent: ' · checking…'});
  void tested(c).then(info => {
    status.textContent = !info ? ' · not a usable LSDj' : info.tested ? ' · a tested build' : info.sameProgram ? ' · a tested program, its own samples' : ' · an untested build';
    status.className = info?.tested || info?.sameProgram ? 'hint' : 'warn';
    if (info && !info.tested && !info.sameProgram) status.title = 'The FM-1 hasn\'t been tried with this LSDj: it may not start or sound right. Your songs stay on the FM-1 either way.';
  });
  const facts = [`LSDj ${lsdjLabel(c.bytes)}`, plural(kits.length, 'kit'),
    c.kits ? `Install puts ${c.kits.length} on the FM-1` : null, originText(c, byId),
    `added ${new Date(c.added).toLocaleDateString([], {dateStyle: 'medium'})}`].filter(Boolean).join(' · ');
  const rename = () => {
    const name = prompt('Name this cartridge:', cartName(c));
    if (name != null) return renameCartridge(c.id, name);
  };
  const forget = async () => {
    if (!confirm(`Forget ${cartName(c)}? It's removed from this browser only: your own files stay where they are.`)) return;
    await forgetCartridge(c.id); say(`Forgot ${cartName(c)}.`, 'ok');
  };
  return el('li', {className: 'cart-card' + (mine ? ' on' : '')},
    el('div', {className: 'cart-head'}, el('b', {textContent: cartName(c)}),
      mine ? el('span', {className: 'badge', textContent: 'Install\'s'}) : null,
      onFm1?.id === c.id ? el('span', {className: 'badge on', textContent: `on ${onFm1.fm1.replace(/^The /, 'the ')}`}) : null,
      crate ? el('span', {className: 'badge', textContent: `in the crate ×${crate}`}) : null),
    el('div', {className: 'hint'}, facts, status),
    kitList(c),
    el('div', {className: 'row'},
      btn('Install…', () => { document.dispatchEvent(new CustomEvent('install-this-cart', {detail: {id: c.id}})); location.hash = '#install'; },
        {className: 'primary', title: 'Open it in Install, with the kits chosen last time'}),
      btn('Use in Songs & kits', () => { document.dispatchEvent(new CustomEvent('songs-this-cart', {detail: {id: c.id}})); location.hash = '#songtools'; },
        {title: 'Kit and sample names for your songs from this LSDj'}),
      btn('Rename', rename),
      btn('Download .gb', () => download(c.bytes, fileName(c))),
      btn('Forget', forget, {disabled: !!crate, title: crate ? 'A DJ crate card plays it: remove the card first' : 'Remove it from this browser'})));
}
async function draw() {
  const box = root?.querySelector('#carts-list');
  if (!box) return;
  const files = await libraryFiles(), list = await cartridges();
  const kitFiles = files.filter(f => f.kind === 'kit' && isKitBank(f.bytes));
  const byId = new Map(list.map(c => [c.id, c])), inUse = new Set([installCart(), ...list.filter(c => crateUses(c.id).length).map(c => c.id)]);
  const copies = inBetweenCopies(list, {inUse});
  const now = root.querySelector('#carts-list');
  if (!now) return;
  now.replaceChildren(
    list.length ? el('ul', {className: 'cart-list'}, ...list.map(c => card(c, byId)))
      : el('p', {className: 'warn', textContent: 'No cartridges yet: add your LSDj .gb file, or read the one on your FM-1.'}),
    copies.length ? el('p', {className: 'row'}, el('span', {className: 'hint', textContent: `${plural(copies.length, 'copy')} left by kit edits (each edit keeps a copy). `}),
      btn(`Clean up ${plural(copies.length, 'copy')}`, async () => {
        if (!confirm(`Forget these in-between copies?\n\n${copies.map(cartName).join('\n')}\n\nThe newest version of each and the cartridge it started from stay. Copies you named, Install's and the crate's stay too.`)) return;
        await cleanUp(copies, list); say(`Cleaned up ${plural(copies.length, 'copy')}.`, 'ok');
      })) : null,
    el('h3', {className: 'subhead', textContent: '.kit files'}),
    kitFiles.length ? el('ul', {className: 'sets-lib'}, ...kitFiles.map(k => el('li', {}, `${k.name}: kit ${parseKit(k.bytes).name} `,
      btn('Put in Install\'s LSDj', () => { document.dispatchEvent(new CustomEvent('install-this-kit', {detail: {bytes: k.bytes.subarray(0, BANK), name: k.name}})); },
        {title: 'Into the first empty kit slot of the LSDj chosen in Install (a new copy)'}), ' ',
      btn('Forget', async () => { if (confirm(`Forget ${k.name}?`)) await removeFromLibrary(k.id); }))))
      : el('p', {className: 'hint', textContent: 'None. Add .kit files to put them in an LSDj, or for Sets to find kits your songs play.'}));
  void drawStorage();
}
async function drawStorage() {
  const p = root?.querySelector('#carts-storage');
  if (!p) return;
  const s = await storageState();
  const text = s.trouble || (!s.kept ? 'This browser keeps no files for this page: your cartridges last only until it closes.' : '');
  p.textContent = text; p.hidden = !text;
}
/* LSDj (.gb, .gbc) and .kit files added here: each checked, the rest still added if one fails */
async function addFiles(fs) {
  const ok = [], bad = [];
  for (const f of fs) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      if (/\.kit$/i.test(f.name) || (bytes.length === BANK && isKitBank(bytes))) {
        if (!isKitBank(bytes)) throw Error(`${f.name} isn't an LSDj .kit file.`);
        await addToLibrary('kit', f.name, bytes.subarray(0, BANK));
      } else { checkRomFile(bytes, f.name); await addCartridge(bytes, f.name, {from: 'file'}); }
      ok.push(f.name);
    } catch (e) { bad.push(e.message); }
  }
  say((ok.length ? `Added ${ok.join(', ')}. ` : '') + (bad.length ? `Not added: ${bad.join(' ')}` : ''), bad.length ? (ok.length ? 'warn' : 'bad') : 'ok');
}
export function mountCarts(box) {
  root = box;
  const input = el('input', {type: 'file', accept: '.gb,.gbc,.kit', multiple: true, hidden: true});
  input.onchange = () => { const x = [...input.files]; input.value = ''; if (x.length) guard(() => addFiles(x)); };
  const read = btn('Read the LSDj on my FM-1', async () => {
    say('Reading the LSDj installed on the FM-1 (nothing is written to it)…');
    const c = await readAndKeep((n, t) => say(`Reading the LSDj on the FM-1: ${Math.round(100 * n / t)} %. Nothing is written to it.`));
    say(`Kept ${cartName(c)}. Kits left out when it was installed aren't in it: only your original file has them.`, 'ok');
    void draw();
  });
  box.replaceChildren(
    el('p', {className: 'hint', textContent: 'Your LSDj files, kept in this browser on this computer only (never uploaded). Install, Songs & kits, Sets and the DJ crate all choose from these. Each remembers which kits Install puts on the FM-1.'}),
    el('div', {className: 'row'}, btn('Add LSDj or .kit files…', () => input.click(), {className: 'primary'}), input, read),
    el('p', {id: 'carts-fm1', className: 'row'}),
    el('p', {id: 'carts-status', className: 'hint', role: 'status'}),
    el('p', {id: 'carts-storage', className: 'warn', hidden: true}),
    el('div', {id: 'carts-list'}));
  document.addEventListener('kit-library', () => void draw());
  document.addEventListener('kit-library-trouble', () => void drawStorage());
  window.addEventListener('storage', e => { if (e.key === 'dj-crate') void draw(); });
  window.addEventListener('hashchange', () => { if (location.hash === '#carts') { void draw(); if (connected) void drawFm1(true); } });   /* (crate cards may have changed) */
  document.addEventListener('device-state', e => { connected = !!e.detail?.connected; if (!connected) onFm1 = null; void drawFm1(connected && location.hash === '#carts'); });
  void draw(); void drawFm1();
}
