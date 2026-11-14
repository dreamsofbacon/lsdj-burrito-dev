// LSDJ Burrito: the fast LSDj swap (0.9.98-dev.6, firmware/lsdj_swap.h). Changes the LSDj (or its kits) on an
// FM-1 that already runs this firmware by rewriting only the slot's 4 KiB flash sectors that differ, over the
// link, instead of installing the whole firmware. The FM-1 encrypts and writes each sector, writes the slot's
// header last, checks the whole slot and restarts; a power cut on the way leaves it on its add-your-LSDj screen
// (never a broken start), and the swap (or a full install) puts LSDj back.
// Firmware without it answers status 1: slotSums gives null, and the page installs as before.
import {crc32, le32, rd32} from './link.js';

export const SWAP_OP = {INFO: 0x08, BEGIN: 0x09, WRITE: 0x0A, END: 0x0B};
export const SECTOR = 4096, PART = 128, SUMS = 30;

/* {capacity, sectors, sums: [crc32 of each plain sector]}, or null: this firmware cannot swap */
export async function slotSums(link, {signal} = {}) {
  const sums = []; let capacity = 0, sectors = 1;
  for (let first = 0; first < sectors; first += SUMS) {
    const r = await link.req(SWAP_OP.INFO, [first], {allow: [0, 1], retries: 2, timeout: 3000, signal});
    if (r.status) return null;
    const d = r.data;
    capacity = rd32(d, 0); sectors = d[4];
    if (d[5] !== first || !sectors || capacity !== sectors * SECTOR) throw Error('The FM-1 described its LSDj slot oddly.');
    for (let k = first; k < Math.min(sectors, first + SUMS); k++) sums.push(rd32(d, 6 + 4 * (k - first)));
  }
  return {capacity, sectors, sums};
}

/* the sectors of slot (the whole new slot: capacity bytes) that differ from the FM-1's, header (0) last */
export function sectorsToSend(slot, sums) {
  const out = [];
  for (let k = 1; k < sums.length; k++) if (crc32(slot.subarray(k * SECTOR, (k + 1) * SECTOR)) !== sums[k]) out.push(k);
  if (out.length || crc32(slot.subarray(0, SECTOR)) !== sums[0]) out.push(0);
  return out;
}

/* Swap the FM-1's slot for `slot` (capacity bytes: the slot as the template holds it, 0xFF after the data).
   onStep(name, done, total): 'begin', 'write' (per sector), 'end'. Resolves {sent, sectors}: sent 0 = it already
   had this slot (nothing changed, LSDj carries on). After a swap the FM-1 restarts: the caller waits for it. */
export async function swapSlot(link, slot, {sums, onStep = () => {}, signal} = {}) {
  sums ??= await slotSums(link, {signal});
  if (!sums) throw Error('This FM-1\'s firmware cannot swap LSDj: install instead.');
  if (slot.length !== sums.capacity) throw Error('This LSDj slot does not fit the FM-1\'s firmware: install instead.');
  const send = sectorsToSend(slot, sums.sums);
  if (!send.length) return {sent: 0, sectors: sums.sectors};
  onStep('begin', 0, send.length);
  await link.req(SWAP_OP.BEGIN, [...le32(crc32(slot)), send.length], {timeout: 15000, signal});   // stores the songs first
  for (let i = 0; i < send.length; i++) {
    const k = send[i];
    for (let p = 0; p < SECTOR / PART; p++) {
      const at = k * SECTOR + p * PART, last = p === SECTOR / PART - 1;
      /* the last part writes the sector (two erases for the first: the header goes first); a part sent again is fine */
      await link.req(SWAP_OP.WRITE, [k, p, ...slot.subarray(at, at + PART)], {timeout: last ? 5000 : 1500, retries: 2, signal});
    }
    onStep('write', i + 1, send.length);
  }
  onStep('end', send.length, send.length);
  /* the header, then the whole slot's check (~0.5 MB); not repeated: once done, the FM-1 is restarting */
  await link.req(SWAP_OP.END, [], {timeout: 10000});
  return {sent: send.length, sectors: sums.sectors};
}
