// SPDX-License-Identifier: GPL-3.0-only
// Installing an LSDJ Burrito .fwsc from the page (after GameDude's
// install-firmware.js), with the FM-1's own USB updater, as M-UPGRADE does:
//   1. the running firmware reads parts of the package and stages M-VAVE's
//      update loader (nothing is changed before the page says "success");
//   2. the FM-1 restarts into the loader, which reads the whole firmware and
//      writes it; 3. it restarts into the new firmware, which must report the
//      package's version.
// Recovery may be possible if an interrupted install still answers in loader mode.
// Host simulations cannot guarantee recovery after power loss on physical hardware.
import {Updater, UPGRADE, STAGE_DONE, WRITE_DONE, isFm1} from '../vendor/fm1ota.js';
import {Package, logicalImage} from '../vendor/fm1pkg.js';
import {Link, crc32, rd32} from './link.js';
import {slotSums, swapSlot, sectorsToSend} from './swap.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* After a restart Windows sometimes misses the FM-1 joining USB (seen 2026-11-12/13: it waited on UPDATE MODE:
   WAITING FOR THE INSTALLER until its cable was replugged). Wait up to WAIT_MS; after HINT_MS with no answer,
   onStep(hint) once, so the page can say "unplug it and plug it back in", and keep waiting. */
export const HINT_MS = 10000, WAIT_MS = 120000;
export const REPLUG = {
  update: 'No answer yet. If the FM-1 says UPDATE MODE: WAITING FOR THE INSTALLER, unplug its USB cable and plug it back in (keep this tab open): the install carries on.',
  back: 'No answer yet. If the FM-1 shows LSDj, unplug its USB cable and plug it back in (keep this tab open).'};
async function waitWithHint(up, filter, onHint, {hintMs = HINT_MS, waitMs = WAIT_MS} = {}) {
  const t = setTimeout(onHint, hintMs);
  try { return await up.waitForAny(filter, waitMs); } finally { clearTimeout(t); }
}
export class InstallError extends Error {
  constructor(msg, {resumable = false} = {}) { super(msg); this.resumable = resumable; }
}

/* A .fwsc file -> {product, version, burrito, image}; throws (nothing installed) unless it is a whole, valid
   FM-1 package: every CRC in it checks, and it has the FM-1's layout. */
export function checkPackage(bytes) {
  let p;
  try { p = new Package(bytes); } catch (e) { throw new InstallError(`This is not a valid FM-1 firmware file (${e.message}). Nothing was installed.`); }
  const product = p.product;
  /* FM-1_ and 3 to 15 digits (a package name holds 20 characters): FM-1_015, FM-1_991, FM-1_5370992 */
  if (!/^FM-1_\d{3,15}$/.test(product)) throw new InstallError(`This firmware is for "${product}", not the FM-1. Nothing was installed.`);
  if (p.appBase !== 0x4000 || p.appOff !== 0x4120 || p.flashSize !== 0x93000)
    throw new InstallError('This FM-1 firmware has an unknown layout. Nothing was installed.');
  if (p.entries.filter(e => e.type === 100 && e.name === 'ota.bin').length !== 1)
    throw new InstallError('The firmware must include exactly one checked update loader.');
  /* LSDJ Burrito: FM-1_955..FM-1_991, then FM-1_537 + a 4-digit version (FM-1_5370992 = 992), and from 0.9.96
     FM-1_537 + MAJOR MINOR PATCH, two digits each (FM-1_537000996 = 0.9.96 = 996). Compare versions, never the
     identities as text: "FM-1_537000996" sorts before "FM-1_5370995". */
  const old = /^FM-1_537(\d{4})$/.exec(product), rel = /^FM-1_537(\d\d)(\d\d)(\d\d)$/.exec(product), number = +product.slice(5);
  const version = rel ? +rel[1] * 10000 + +rel[2] * 100 + +rel[3] : old ? +old[1] : number;
  const release = rel ? `${+rel[1]}.${+rel[2]}.${+rel[3]}` : null;
  return {product, version, release, burrito: !!(old || rel) || (number >= 955 && number <= 999), image: logicalImage(bytes)};
}

/* MIDI access without some ports: a live view (ports that appear later, such as the FM-1 in update mode, show up) */
export function accessWithout(access, avoid) {
  const skip = new Set(avoid);
  const without = map => new Map([...map].filter(([id, p]) => !skip.has(id) && !skip.has(p?.id)));
  return {get inputs() { return without(access.inputs); }, get outputs() { return without(access.outputs); }};
}
/* Install pkg on one FM-1 while other FM-1s and MIDI gear stay plugged in and playing (the DJ crate). The same
   install() runs, unchanged, on a view of the MIDI ports without `avoid` (every other FM-1's ports, the other
   decks' and the mixer's), so nothing is ever sent to those. Its first FM-1 must be `target` ({input, output}
   port ids), or nothing is installed. Afterwards every avoided port must still be there: if one went away during
   the install, the FM-1 that came back can't be told apart from it -> {id, confirmed: false}. */
export async function installOn(access, pkg, {target, avoid = [], Transport = Updater, ...options} = {}) {
  if (!target?.input || !target?.output) throw new InstallError('No FM-1 chosen. Nothing was installed.');
  if (avoid.includes(target.input) || avoid.includes(target.output)) throw new InstallError('That FM-1 is in use elsewhere. Nothing was installed.');
  const present = id => { const p = access.inputs.get(id) || access.outputs.get(id); return !!p && p.state !== 'disconnected'; };
  const others = avoid.filter(present);
  let first = true;
  class Targeted extends Transport {
    async findAny(filter, opts) {
      const dev = await super.findAny(filter, opts);
      if (first && dev) {
        first = false;
        const input = dev.link?.input?.id, output = dev.link?.output?.id;
        /* (an FM-1 already in update mode can't be told apart: finishing it belongs in Install, with only it plugged in) */
        const why = dev.id.model !== 'FM-1' ? 'An FM-1 is in update mode. Finish that in Install, with only that FM-1 plugged in.'
          : input !== target.input || output !== target.output ? 'A different FM-1 answered than the one chosen.' : '';
        if (why) { dev.link?.close?.(); throw new InstallError(`${why} Nothing was installed.`); }
      }
      return dev;
    }
  }
  const id = await install(accessWithout(access, avoid), pkg, {...options, Transport: Targeted});
  return {id, confirmed: others.every(present)};
}

/* The fast LSDj swap (0.9.98-dev.6, swap.js): the FM-1 already runs this package's firmware, so only its LSDj slot
   changes, the sectors that differ. null: this FM-1 cannot swap, or the swap stopped before anything changed (the
   caller installs instead); else the identity it reports after its restart. */
async function swapInstead(up, dev, slot, product, {log, onStep, onProgress, hintMs, waitMs, LinkClass}) {
  const {input, output} = dev.link;
  dev.link.close();
  let link = new LinkClass(input, output), begun = false, r;
  try {
    const sums = await slotSums(link).catch(() => null);
    if (!sums || sums.capacity !== slot.length) {
      log(`This FM-1 cannot swap its LSDj (${sums ? `its slot holds ${sums.capacity} bytes, this one ${slot.length}` : 'no slot information'}): installing the whole firmware.`);
      return null;
    }
    log(`LSDj swap: ${sectorsToSend(slot, sums.sums).length} of ${sums.sectors} sectors differ.`);
    r = await swapSlot(link, slot, {sums, onStep: (s, d, t) => {
      if (s === 'begin') onStep('swap');
      if (s === 'begun') begun = true;
      if (s === 'write') onProgress(d, t);
    }});
  } catch (e) {
    if (!begun) { log(`The swap did not start (${e.message}): installing the whole firmware.`); return null; }
    throw new InstallError(`The LSDj swap stopped (${e.message}). Your songs were saved first. The FM-1 restarts by itself, ` +
      'without LSDj if part of it was written: press Install again (it swaps, or installs).', {resumable: true});
  } finally { link.close(); }
  if (!r.sent) { onStep('done', product); return product; }   /* it already had this LSDj */
  if (r.unconfirmed) log('The FM-1 did not confirm the end of the swap: checking after its restart.');
  onStep('restart');
  await sleep(2000);
  const back = await waitWithHint(up, (id) => id.model === 'FM-1', () => onStep('replug-back'), {hintMs, waitMs});
  if (!back) throw new InstallError('The swap finished, but the FM-1 did not report back. Check its screen; unplug its USB cable and plug it back in.', {resumable: true});
  const {input: i2, output: o2} = back.link;
  back.link.close();
  link = new LinkClass(i2, o2);
  try {
    /* the slot it now runs: its header CRC (CART_INFO), so a slot that did not check out (no LSDj) is told */
    const cart = await link.cartridgeInfo().catch(() => null);
    if (!cart || cart.headerCrc !== rd32(slot, 252) || cart.headerCrc !== crc32(slot.subarray(0, 252)))
      throw new InstallError('The FM-1 restarted without the new LSDj. Press Install again (it swaps, or installs).', {resumable: true});
  } finally { link.close(); }
  onStep('done', back.id.text);
  return back.id.text;
}

/* Install (or finish an interrupted install of) pkg. onStep(phase, detail): 'found', 'stage', 'loader',
   'write', 'restart', 'done', and 'replug' / 'replug-back' when the FM-1 is slow to answer after a restart; onProgress(bytes, total) during the write. Resolves the identity the FM-1
   reports afterwards.
   slot (0.9.98-dev.6): the package's LSDj slot (its whole capacity, lsdj-firmware.js). If the FM-1 already runs
   this very firmware and can swap, only the slot changes ('swap', then onProgress(sectors, total), 'restart',
   'done'); otherwise the whole install, as before. */
export async function install(access, pkg, {log = () => {}, onStep = () => {}, onProgress = () => {}, Transport = Updater, hintMs, waitMs,
                                            slot = null, LinkClass = Link} = {}) {
  const up = new Transport(access, log);
  let dev = await up.findAny(isFm1);
  if (!dev) throw new InstallError('No FM-1 found. Connect it with a USB data cable, close M-UPGRADE and other MIDI apps, and try again. Nothing was installed.');
  onStep('found', dev.id.text);
  if (slot && !(dev.id.model === 'FM-1' && dev.id.text === pkg.product))
    log(`No LSDj swap: the FM-1 reports ${dev.id.text}, this firmware is ${pkg.product}: installing the whole firmware.`);
  if (slot && dev.id.model === 'FM-1' && dev.id.text === pkg.product) {
    const id = await swapInstead(up, dev, slot, pkg.product, {log, onStep, onProgress, hintMs, waitMs, LinkClass});
    if (id) return id;
    dev = await up.findAny(isFm1);   /* (its updater's link was closed for the swap) */
    if (!dev) throw new InstallError('The FM-1 went away. Nothing was installed.');
  }
  try {
    if (dev.id.model === 'FM-1') {
      // step 1: the running firmware stages the loader; nothing is committed without our "success"
      onStep('stage');
      if (!dev.link.send(UPGRADE)) throw new InstallError('The FM-1 went away before the update started. Nothing was installed.');
      const s1 = await up.serve(dev.link, pkg.image, STAGE_DONE, 15000);
      dev.link.close();
      if (!s1.finished) throw new InstallError('The FM-1 stopped preparing the update. Nothing was installed: it is still running its firmware.');
      onStep('loader');
      await sleep(1500);
      dev = await waitWithHint(up, (id) => id.model === 'ota-FM-1', () => onStep('replug'), {hintMs, waitMs});
      if (!dev) throw new InstallError('The FM-1 did not come back in update mode. Keep it powered. If its screen says UPDATE MODE: WAITING FOR THE INSTALLER, unplug its USB cable, plug it back in and press Install again with the same file; recovery is not guaranteed.', {resumable: true});
    } else log('The FM-1 is in update mode (an install that was cut off): finishing it.');
    // step 2: the loader reads everything and writes it
    onStep('write');
    dev.link.drain();
    if (!dev.link.send(UPGRADE)) throw new InstallError('The FM-1 went away before the write started. Replug it and press Install again.', {resumable: true});
    const s2 = await up.serve(dev.link, pkg.image, WRITE_DONE, 60000, onProgress);
    dev.link.close();
    if (!s2.finished)
      throw new InstallError(`The write stopped after ${s2.served} parts${s2.lost ? ' (the FM-1 was disconnected)' : ''}. ` +
        'Keep the FM-1 powered. If it still responds in update mode, retry the same file. Recovery is not guaranteed.', {resumable: true});
    // step 3: the new firmware must say who it is
    onStep('restart');
    await sleep(2000);
    const back = await waitWithHint(up, (id) => id.model === 'FM-1', () => onStep('replug-back'), {hintMs, waitMs});
    if (!back) throw new InstallError('The write finished, but the FM-1 did not report back. Check its screen; unplug its USB cable and plug it back in. Installation is unconfirmed; recovery is not guaranteed.', {resumable: true});
    back.link.close();
    if (back.id.text !== pkg.product) throw new InstallError(`The FM-1 now reports ${back.id.text}, not ${pkg.product}. Press Install again.`, {resumable: true});
    onStep('done', back.id.text);
    return back.id.text;
  } finally { dev?.link?.close?.(); }
}
