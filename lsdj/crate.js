// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate: things to load onto a deck's FM-1 (lsdj/crate-ui.js). An item holds a .sav, an LSDj ROM (all its
// kits), or both: the ROM is installed first, then the .sav sent. The list is kept in this browser (localStorage
// 'dj-crate'); the files themselves in its file library (kit-library.js: ROMs as 'rom', shared with Sets, and saves
// as 'sav'), each once. Never uploaded, never in the offline copy.
import {parseSav, savBody, songBytes, SAV_SIZE} from './lsdj-sav.js';
import {validateRom, listKits, crc32} from './lsdj-rom.js';
import {lsdjVersion, versionText, lsdjLabel, lsdjFormat, songFormat, opens} from './lsdj-sets.js';

export const KEY = 'dj-crate';

/* the time left of a transfer from how far it got since it began (since: {at ms, n}): "about 40 s left", or '' while
   too early to tell (under 2 s, or under 3 %). A grab took ~1m45s with no idea how long (Colin's DJ test). */
export function timeLeft(since, n, t, at) {
  if (!since || !t || n <= since.n || at - since.at < 2000 || n / t < 0.03) return '';
  const s = (t - n) * (at - since.at) / (n - since.n) / 1000;
  if (s < 1) return '';
  return s < 60 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s left` : `about ${Math.floor(s / 60)} min ${String(Math.round(s % 60 / 10) * 10).padStart(2, '0')} s left`.replace(' 60 s', ' 50 s');
}

/* a file's kind from its bytes: 'sav' | 'rom' | null */
export function fileKind(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (savBody(bytes).length === SAV_SIZE) { try { parseSav(bytes); return 'sav'; } catch { return null; } }   /* (with a 16-byte footer too) */
  try { validateRom(bytes); return 'rom'; } catch { return null; }
}

const idOk = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/* the stored list (JSON text) -> items {id, name, rom, sav, added}; anything broken is left out */
export function loadItems(text) {
  let list;
  try { list = JSON.parse(text || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter(i => i && typeof i.id === 'string' && (idOk(i.rom) || idOk(i.sav)))
    .map(i => ({id: i.id, name: String(i.name || 'Untitled').slice(0, 60), rom: idOk(i.rom) ? i.rom : null,
      sav: idOk(i.sav) ? i.sav : null, added: +i.added || 0, color: colorOk(i.color), img: idOk(i.img) ? i.img : null}));
}
export const saveItems = items => JSON.stringify(items.map(({id, name, rom, sav, added, color, img}) => ({id, name, rom, sav, added, color, img: img || null})));

/* a cartridge label's colour: a preset (index.html .crate-cart[data-color]) or any colour as #rrggbb (cart-label.js) */
export const CART_COLORS = ['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'];
const colorOk = v => CART_COLORS.includes(v) ? v : typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : 'grey';
export const recolorItem = (items, id, color) => items.map(i => i.id === id ? {...i, color: colorOk(color)} : i);
/* its label's picture: a library id (kind 'img'), or null for none */
export const setImage = (items, id, img) => items.map(i => i.id === id ? {...i, img: idOk(img) ? img : null} : i);
/* pictures no item uses any more (removed from the library with the item, or when replaced) */
export const unusedImages = (items, before) => [...new Set(before.map(i => i.img).filter(Boolean))].filter(x => !items.some(i => i.img === x));
/* your own order (a setlist): the item moved to `to` (its new index) */
export function moveItem(items, id, to) {
  const from = items.findIndex(i => i.id === id);
  if (from < 0) return items;
  const out = items.slice(), [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, it);
  return out;
}
/* what the crate shows: search (a card's name, its songs' names, its LSDj version) and sort ('mine': your order,
   'name', 'newest'); text(item) -> the words searched */
export function viewItems(items, {query = '', sort = 'mine'} = {}, text = () => '') {
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter(i => `${i.name} ${text(i)}`.toLowerCase().includes(q)) : items.slice();
  if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base', numeric: true}));
  else if (sort === 'newest') shown.sort((a, b) => b.added - a.added);
  return shown;
}

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;
/* a new item at the end; rom / sav: library ids. The same pair twice is kept once. */
export function addItem(items, {name, rom = null, sav = null, color = 'grey', img = null}) {
  if (!rom && !sav) return items;
  if (items.some(i => i.rom === rom && i.sav === sav)) return items;
  return [...items, {id: newId(), name: String(name || 'Untitled').slice(0, 60), rom, sav, added: Date.now(), color: colorOk(color), img: idOk(img) ? img : null}];
}
export const removeItem = (items, id) => items.filter(i => i.id !== id);
export const renameItem = (items, id, name) => items.map(i => i.id === id ? {...i, name: String(name || i.name).slice(0, 60)} : i);
/* a ROM-only item and a .sav-only item become one pair (in the first one's place) */
export function pairItems(items, a, b) {
  const x = items.find(i => i.id === a), y = items.find(i => i.id === b);
  if (!x || !y || x === y) return items;
  const rom = x.rom || y.rom, sav = x.sav || y.sav;
  if (!rom || !sav || (x.rom && y.rom) || (x.sav && y.sav)) return items;
  const name = x.rom ? `${y.name} on ${x.name}` : `${x.name} on ${y.name}`;
  return items.filter(i => i !== y).map(i => i === x ? {...i, name: name.slice(0, 60), rom, sav, img: x.img || y.img || null} : i);
}
/* library ids no item uses any more (only saves are removed: ROMs are shared with Sets) */
export const unusedSaves = (items, before) => [...new Set(before.map(i => i.sav).filter(Boolean))].filter(s => !items.some(i => i.sav === s));

/* a card's text: {kinds, songs: [names], open, version, missing} from the library's bytes (by id) */
export function describe(item, bytesOf) {
  const out = {kinds: [item.rom && 'LSDj', item.sav && '.sav'].filter(Boolean), songs: [], songList: [], open: null, free: null,
    version: null, kits: [], crc: null, missing: false, format: null, needs: null, tooNew: []};
  if (item.sav) {
    const b = bytesOf(item.sav);
    if (!b) out.missing = true;
    else try {
      const s = parseSav(b);
      out.songList = s.songs.map(x => { let format = null; try { format = songFormat(songBytes(s, x.slot)); } catch { /* unreadable: unknown */ }
        return {slot: x.slot, name: x.name || '(no name)', blocks: x.blocks, format}; });
      out.needs = Math.max(-1, ...out.songList.map(x => x.format ?? -1)); if (out.needs < 0) out.needs = null;   /* the newest song format in it */
      out.songs = out.songList.map(x => x.name); out.open = s.active; out.free = s.freeBlocks;
      out.crc = crc32(b);   /* (what the FM-1 reports for its save once it holds this one: the deck's badge) */
    } catch { out.missing = true; }
  }
  if (item.rom) {
    const b = bytesOf(item.rom);
    if (!b) out.missing = true;
    else { out.version = lsdjLabel(b); out.format = lsdjFormat(b); try { out.kits = listKits(b).map(k => k.name || `kit ${k.bank}`); } catch { /* not readable: none listed */ } }
  }
  /* its songs its own LSDj can't open (saved by a newer one) */
  if (out.format != null) out.tooNew = out.songList.filter(x => !opens(out.format, x.format)).map(x => x.name);
  return out;
}

/* an LSDj's song format from its title, when only the title is known (an FM-1's INFO): from an LSDj file of that title,
   else the ones measured (lsdj-sets.js songFormat) */
const KNOWN_FORMATS = {'LSDj-v9.3.9': 22, 'LSDj-v5.7.8': 4};
const titleText = t => String(t || '').replace(/[\u0000 ]+$/, '');
export function formatOfTitle(title, roms = []) {
  const t = titleText(title);
  for (const r of roms) if (titleText(String.fromCharCode(...r.subarray(0x134, 0x144))) === t) { const f = lsdjFormat(r); if (f != null) return f; }
  return KNOWN_FORMATS[t] ?? null;
}
