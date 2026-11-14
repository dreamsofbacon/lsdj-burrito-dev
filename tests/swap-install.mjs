// SPDX-License-Identifier: GPL-3.0-only
// The fast LSDj swap in install() (0.9.98-dev.6, lsdj/install.js + lsdj/swap.js): with a pretend FM-1 whose link
// answers the slot ops as firmware/lsdj_swap.h does. Swaps only when the FM-1 already runs the package's firmware
// and can; sends only the sectors that differ, the header last; falls back to the whole install when the swap
// can't start (nothing changed then); never after it began; checks the slot the FM-1 runs after its restart.
// (The swap against the real firmware: harness/swap_emu.mjs, in the FM-1 emulator.)
import assert from 'node:assert/strict';
import {install, InstallError} from '../lsdj/install.js';
import {sectorsToSend, SWAP_OP, SECTOR} from '../lsdj/swap.js';
import {crc32, rd32} from '../lsdj/link.js';

const PRODUCT = 'FM-1_537000998', SECTORS = 8, CAP = SECTORS * SECTOR;
function slotImage(seed) {   /* a slot: a header (magic, header CRC at 252), then data; 0xFF after */
  const s = new Uint8Array(CAP).fill(0xff);
  s.set([...'LSDJSLOT'].map(c => c.charCodeAt(0)));
  for (let i = 8; i < 252; i++) s[i] = (i * 7 + seed) & 255;
  const c = crc32(s.subarray(0, 252)); s.set([c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24], 252);
  for (let i = 256; i < 5 * SECTOR; i++) s[i] = (i < 2 * SECTOR ? i * 3 : i * 3 + seed) & 255;   /* sector 1 the same for every seed */
  return s;
}

/* the pretend FM-1: its slot, what it was sent */
let fw;
function reset(o = {}) {
  fw = {slot: slotImage(1), can: true, product: PRODUCT, ops: [], written: [], upgraded: false, restarts: 0, back: true,
        beginStatus: 0, failWriteAt: -1, keepOld: false, ...o};
}
class FakeLink {
  constructor(input, output) { this.input = input; this.output = output; this.closed = false; }
  close() { this.closed = true; }
  async req(op, bytes = []) {
    fw.ops.push(op);
    const ok = (data = []) => ({status: 0, data});
    if (!fw.can) return {status: 1, data: []};
    if (op === SWAP_OP.INFO) {
      const first = bytes[0], d = [CAP & 255, CAP >>> 8 & 255, CAP >>> 16 & 255, CAP >>> 24, SECTORS, first];
      for (let k = first; k < Math.min(SECTORS, first + 30); k++) { const c = crc32(fw.slot.subarray(k * SECTOR, (k + 1) * SECTOR)); d.push(c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24); }
      return ok(d);
    }
    if (op === SWAP_OP.BEGIN) {
      if (fw.beginStatus) throw Object.assign(new Error('FM-1: flash error'), {status: fw.beginStatus});
      fw.crc = rd32(bytes, 0); fw.next = new Uint8Array(fw.slot); fw.parts = []; return ok();
    }
    if (op === SWAP_OP.WRITE) {
      const [k, p] = bytes;
      if (fw.failWriteAt === fw.written.length) { const e = new Error('The FM-1 did not answer.'); e.cause = 'timeout'; throw e; }
      fw.next.set(bytes.slice(2), k * SECTOR + p * 128);
      if (p === 31) fw.written.push(k);
      return ok();
    }
    if (op === SWAP_OP.END) {
      if (crc32(fw.next) !== fw.crc) return {status: 3, data: []};
      if (!fw.keepOld) fw.slot = fw.next;
      fw.restarts++;
      return ok();
    }
    throw Error('unexpected op ' + op);
  }
  async cartridgeInfo() {
    if (fw.slot[0] !== 0x4c) throw Error('no LSDj');
    return {size: CAP, headerCrc: rd32(fw.slot, 252), dataCrc: 0};
  }
}
/* the updater's side: the FM-1 found by its identity; the whole install as a stub that only notes it ran */
class FakeTransport {
  constructor() {}
  dev(model, text) { return {id: {model, text}, link: {input: {id: 'in'}, output: {id: 'out'}, close() {}, drain() {}, send() { if (model === 'FM-1') fw.upgraded = true; return true; }}}; }
  async findAny() { return this.dev('FM-1', fw.product); }
  async waitForAny(filter) {
    if (!fw.back) return null;
    for (const d of [this.dev('ota-FM-1', 'ota-FM-1_900'), this.dev('FM-1', PRODUCT)]) if (filter(d.id)) return d;
    return null;
  }
  async serve() { return {finished: true, served: 1}; }
}
const run = async (slot, o = {}) => {
  const steps = [], prog = [];
  const id = await install({}, {product: PRODUCT, image: new Uint8Array(16)}, {slot, Transport: FakeTransport, LinkClass: FakeLink,
    onStep: s => steps.push(s), onProgress: (d, t) => prog.push(`${d}/${t}`), hintMs: 50, waitMs: 200, ...o});
  return {id, steps, prog};
};

/* the page's plan: only the differing sectors, header last */
{
  const a = slotImage(1), b = slotImage(2);
  const sums = Array.from({length: SECTORS}, (_, k) => crc32(a.subarray(k * SECTOR, (k + 1) * SECTOR)));
  assert.deepEqual(sectorsToSend(b, sums), [2, 3, 4, 0]);
  assert.deepEqual(sectorsToSend(a, sums), []);
}
/* 1. the same firmware, can swap: only the slot changes, no whole install */
{
  reset(); const b = slotImage(2);
  const {id, steps, prog} = await run(b);
  assert.equal(id, PRODUCT);
  assert.deepEqual(fw.written, [2, 3, 4, 0], 'the differing sectors, the header last');
  assert.ok(fw.slot.every((v, i) => v === b[i]) && fw.restarts === 1 && !fw.upgraded);
  assert.deepEqual(steps, ['found', 'swap', 'restart', 'done']);
  assert.deepEqual(prog, ['1/4', '2/4', '3/4', '4/4']);
}
/* 2. it already has this LSDj: nothing sent, no restart */
{
  reset();
  const {steps} = await run(slotImage(1));
  assert.deepEqual(steps, ['found', 'done']);
  assert.ok(!fw.ops.includes(SWAP_OP.BEGIN) && !fw.upgraded && fw.restarts === 0);
}
/* 3. firmware that cannot swap (status 1), another firmware, or no slot given: the whole install, as before */
{
  reset({can: false});
  const {steps} = await run(slotImage(2));
  assert.ok(fw.upgraded && steps.includes('stage') && steps.includes('write') && !steps.includes('swap'));
  reset({product: 'FM-1_537000997'});
  await run(slotImage(2));
  assert.ok(fw.upgraded && fw.ops.length === 0, 'an older firmware: never asked to swap');
  reset();
  await run(null);
  assert.ok(fw.upgraded && fw.ops.length === 0);
}
/* 4. the swap does not start (BEGIN refused: nothing changed): the whole install */
{
  reset({beginStatus: 4});
  const {steps} = await run(slotImage(2));
  assert.ok(fw.upgraded && steps.includes('write') && fw.written.length === 0);
}
/* 5. it stops after it began: an error to retry, never a whole install on top */
{
  reset({failWriteAt: 1});
  await assert.rejects(run(slotImage(2)), e => e instanceof InstallError && e.resumable && /swap stopped/.test(e.message));
  assert.ok(!fw.upgraded);
}
/* 6. after the restart the FM-1 must run the new slot */
{
  reset({keepOld: true});   /* END said ok, but it came back with the old one */
  await assert.rejects(run(slotImage(2)), e => e instanceof InstallError && /without the new LSDj/.test(e.message));
  reset({back: false});
  await assert.rejects(run(slotImage(2)), e => e instanceof InstallError && /did not report back/.test(e.message));
}
console.log('PASS swap-install: only the sectors that differ, header last; whole install when it cannot (or did not start); errors after it began; the slot checked after the restart');
