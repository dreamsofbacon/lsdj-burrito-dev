// SPDX-License-Identifier: GPL-3.0-only
// The page's one cartridge worker (cart-worker.js, running cart-core.js), for Studio › Build (studio-ui.js) and the DJ
// crate (crate-ui.js): reading hundreds of songs and planning cartridges can take seconds, and the decks keep time.
// Messages: {id, type, ...} out, {id, ok, result | error} back.
let worker = null, nextId = 1;
const pending = new Map();
export function cartWork(type, m = {}, transfer = []) {
  worker ??= Object.assign(new Worker(new URL('./cart-worker.js', import.meta.url), {type: 'module'}), {
    onmessage: ({data}) => { const p = pending.get(data.id); pending.delete(data.id); if (p) data.ok ? p.resolve(data.result) : p.reject(Error(data.error)); },
    onerror: e => { for (const p of pending.values()) p.reject(Error(e.message || 'The cartridge maker stopped.')); pending.clear(); }});
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, {resolve, reject}); worker.postMessage({id, type, ...m}, transfer); });
}
/* songs (.savs) and their LSDj -> cartridges that fit the FM-1 (cart-core.js fitCarts); cap: its cartridge space in bytes */
export const fitInWorker = ({rom, savs, each = false, cap = 502016}) =>
  cartWork('fit', {rom: rom.slice(), savs: savs.map(s => ({name: s.name, bytes: s.bytes.slice()})), capacity: cap, each});
