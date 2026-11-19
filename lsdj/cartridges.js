// SPDX-License-Identifier: GPL-3.0-only
// Cartridges: the user's LSDj files kept in this browser (kit-library.js, kind 'rom'), each with what the page
// knows about it: a name of its own, which kits Install puts on the FM-1 (chosen once, kept), and where it came
// from (a file, read from an FM-1, or a kit edit of another cartridge: `parent`). Install, Songs and kits, Sets,
// the crate and the cart maker all choose from these (the cartridge plan, phase 2). Older entries have none of
// the new fields and read as files.
import {libraryFiles, addToLibrary, updateLibrary, removeFromLibrary} from './kit-library.js';
import {checkRomFile} from './lsdj-rom.js';
import {KEY as CRATE_KEY, loadItems} from './crate.js';

const INSTALL = 'burrito-install-cart';
const store = {get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not kept */ } }};

/* a cartridge's own name ('label', typed by the user) or its file's */
export const cartName = c => c.label || c.name;
/* where it came from, in words */
export function originText(c, byId = new Map()) {
  if (c.from === 'edited') { const p = byId.get(c.parent); return p ? `kits changed from ${cartName(p)}` : 'kits changed from another cartridge'; }
  if (c.from === 'fm1') return `read from ${c.fm1 || 'an FM-1'}`;
  if (c.from === 'set') return 'made in Sets';
  return 'a file';
}

/* the cartridges, newest first */
export async function cartridges() {
  return (await libraryFiles()).filter(f => f.kind === 'rom').sort((a, b) => b.added - a.added);
}
/* keeps an LSDj as a cartridge (checked first: the same check everywhere) -> its entry. Already kept (the same
   bytes): that entry, its name and origin unchanged. from: 'file' | 'fm1' | 'edited' | 'set'; parent: the
   cartridge an edit came from; fm1: the FM-1 it was read from */
export async function addCartridge(bytes, name, {from = 'file', parent = null, fm1 = null} = {}) {
  checkRomFile(bytes, name);
  return addToLibrary('rom', name, bytes, {from, ...(parent ? {parent} : {}), ...(fm1 ? {fm1} : {})});
}
export const renameCartridge = (id, label) => updateLibrary(id, {label: String(label || '').trim().slice(0, 60)});
/* the kits Install puts on the FM-1 from this cartridge (logical bank numbers) */
export const saveKitChoice = (id, banks) => updateLibrary(id, {kits: [...banks].sort((a, b) => a - b)});

/* the cartridge Install used last: chosen again when Install opens */
export const installCart = () => store.get(INSTALL);
export const rememberInstallCart = id => store.set(INSTALL, id);

/* crate cards whose LSDj is this cartridge */
export function crateUses(id, text = store.get(CRATE_KEY)) {
  return loadItems(text || '[]').filter(i => i.rom === id);
}

/* kit edits leave a copy at each step: the copies another edit was made from, that nothing uses (not a crate
   card, not Install's cartridge) and that have no name of their own. The first cartridge of a chain (a file, a
   read) always stays. -> the entries */
export function inBetweenCopies(list, {inUse = new Set()} = {}) {
  const parents = new Set(list.filter(c => c.from === 'edited' && c.parent).map(c => c.parent));
  return list.filter(c => c.from === 'edited' && parents.has(c.id) && !inUse.has(c.id) && !c.label);
}
/* forgets the in-between copies (asked first by the caller): their children point at the copy they came from */
export async function cleanUp(copies, list) {
  const gone = new Set(copies.map(c => c.id)), byId = new Map(list.map(c => [c.id, c]));
  const root = id => { while (gone.has(id)) id = byId.get(id)?.parent; return id; };
  for (const c of list) if (!gone.has(c.id) && gone.has(c.parent)) await updateLibrary(c.id, {parent: root(c.parent)});
  for (const c of copies) await removeFromLibrary(c.id);
}
/* forgets a cartridge: not one a crate card plays (the card would lose its LSDj) */
export async function forgetCartridge(id) {
  const n = crateUses(id).length;
  if (n) throw Error(`${n} DJ crate card${n === 1 ? ' plays' : 's play'} this LSDj: remove ${n === 1 ? 'it' : 'them'} from the crate first. Nothing was forgotten.`);
  if (installCart() === id) rememberInstallCart(null);
  await removeFromLibrary(id);
}
