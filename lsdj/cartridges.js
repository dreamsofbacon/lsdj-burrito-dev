// SPDX-License-Identifier: GPL-3.0-only
// Cartridges: the user's LSDj files kept in this browser (kit-library.js, kind 'rom'), each with what the page
// knows about it: a name of its own, which kits Install puts on the FM-1 (chosen once, kept), and where it came
// from (a file, read from an FM-1, or a kit edit of another cartridge: `parent`). Install, Songs and kits, Sets,
// the crate and the cart maker all choose from these (the cartridge plan, phase 2). Older entries have none of
// the new fields and read as files.
import {libraryFiles, addToLibrary, updateLibrary, removeFromLibrary} from './kit-library.js';
import {checkRomFile, buildSlot, listKits} from './lsdj-rom.js';
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

/* ---- which cartridge an FM-1 has (phase 3) ----
   An FM-1 reports its LSDj as the CRC of its slot data (link.js cartridgeInfo: dataCrc): the LSDj with the kits
   installed. Each cartridge keeps the CRCs it was prepared (Install) or read (from an FM-1) with: 'prints',
   [{dataCrc, kits}], the newest last. */
const PRINTS = 12;
export async function notePrint(id, dataCrc, kits) {
  const c = (await cartridges()).find(x => x.id === id);
  if (!c || !Number.isInteger(dataCrc)) return null;
  const prints = (c.prints || []).filter(p => p.dataCrc !== dataCrc).concat({dataCrc, kits: [...kits].sort((a, b) => a - b)}).slice(-PRINTS);
  return updateLibrary(id, {prints});
}
/* the slot data CRC of an LSDj with these kits, as Install builds it (the slot's size doesn't change it) */
export async function dataCrcOf(rom, kits) {
  const {slot} = await buildSlot(rom, kits, 0x7fffffff);
  return new DataView(slot.buffer, slot.byteOffset).getUint32(16, true) >>> 0;
}
/* the cartridge an FM-1 has (its dataCrc) -> {cart, kits} or null. A CRC kept with a cartridge first; else each
   cartridge with the kits it's set to install, then with all its kits (installs from before cartridges kept CRCs),
   and a match found that way is kept. only: work out just these cartridge ids (saved CRCs are always looked at). */
export async function matchCart(dataCrc, list = null, {only = null} = {}) {
  list ??= await cartridges();
  dataCrc >>>= 0;
  for (const c of list) { const p = (c.prints || []).find(x => x.dataCrc >>> 0 === dataCrc); if (p) return {cart: c, kits: p.kits}; }
  /* only: the ids worth working out (the DJ crate: just the card's own, so a playing deck's clock isn't held up) */
  for (const c of only ? list.filter(x => only.includes(x.id)) : list) {
    const all = listKits(c.bytes).map(k => k.bank);
    for (const kits of c.kits && c.kits.join() !== all.join() ? [c.kits, all] : [all]) {
      let crc = null;
      try { crc = await dataCrcOf(c.bytes, kits); } catch { continue; }
      if (crc === dataCrc) { await notePrint(c.id, dataCrc, kits); return {cart: c, kits}; }
    }
  }
  return null;
}
