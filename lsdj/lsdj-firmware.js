// SPDX-License-Identifier: GPL-3.0-only
// Derived from GameDude's rom-firmware.js: only the verified, empty ROM window may change.
import {Package, sha256hex, crc16} from '../vendor/fm1pkg.js';
import {buildSlot, parseSlot, identifyRom, planRom} from './lsdj-rom.js';
import {checkPackage} from './install.js';

async function protectedHash(app, offset, capacity) {
  const bytes = new Uint8Array(app.length - capacity);
  bytes.set(app.subarray(0, offset));
  bytes.set(app.subarray(offset + capacity), offset);
  return sha256hex(bytes);
}

export async function loadTemplate(fetcher = fetch) {
  const get = async (path, json = false) => {
    const r = await fetcher(path, {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!r.ok) throw Error(`Firmware template unavailable (${r.status}). No firmware was prepared.`);
    return json ? r.json() : new Uint8Array(await r.arrayBuffer());
  };
  const metadata = await get('lsdj/template.json', true);
  if (metadata.package !== 'fm1-lsdj-template.fwsc') throw Error('Unexpected template filename.');
  return {metadata, template: await get('lsdj/fm1-lsdj-template.fwsc')};
}

export async function prepareLsdjFirmware(rom, keepKits, template, metadata, {versions = [], experimental = false} = {}) {
  const info = await identifyRom(rom, versions);
  if (!experimental) throw Error('Explicit experimental consent is required. This template is not hardware-validated.');
  if (metadata.lsdj_slot !== 1 || metadata.generic_rom !== true || metadata.experimental !== true ||
      metadata.hardware_validated !== false || metadata.product !== 'FM-1_537000998' || metadata.version !== 'FM-1_998' || metadata.release !== '0.9.98-dev.5' ||
      metadata.usb_updater !== true || metadata.usb_protocol !== 'fm1-ota-v1')
    throw Error('Unsupported LSDj firmware template.');
  if (await sha256hex(template) !== metadata.sha256) throw Error('Firmware template integrity check failed.');
  checkPackage(template);
  const pkg = new Package(template), offset = metadata.cartridge_offset, capacity = metadata.cartridge_capacity;
  if (pkg.product !== metadata.product || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(capacity) ||
      capacity <= 0 || offset + capacity > pkg.app.size)
    throw Error('Invalid template ROM window.');
  const plan = planRom(rom, keepKits, capacity);
  if (!plan.fits) throw Error(`Selected ROM needs ${plan.needed} bytes; only ${capacity} are available. Deselect kits explicitly.`);
  const app = pkg.dec.slice(pkg.appOff, pkg.appOff + pkg.app.size);
  if (!app.subarray(offset, offset + capacity).every(b => b === 255))
    throw Error('Template ROM window is not empty.');
  const loader = pkg.entries.find(e => e.type === 100 && e.name === 'ota.bin');
  const loaderBytes = (bytes, p, e) => bytes.subarray(e.dataOff + p.skew, e.dataOff + p.skew + e.size);
  if (!loader || await protectedHash(app, offset, capacity) !== metadata.protected_app_sha256 ||
      await sha256hex(loaderBytes(template, pkg, loader)) !== metadata.loader_sha256)
    throw Error('Template firmware or loader verification failed.');
  const {slot, stored, kept} = await buildSlot(rom, keepKits, capacity);
  app.set(slot, offset);
  pkg.setApp(app);
  const bytes = pkg.serialize(), checked = checkPackage(bytes), back = new Package(bytes);
  const placed = back.dec.subarray(back.appOff + offset, back.appOff + offset + capacity);
  const parsed = parseSlot(placed, capacity);
  const after = back.dec.subarray(back.appOff, back.appOff + back.app.size);
  if (parsed.error || parsed.stored !== stored || parsed.kits !== kept || parsed.cursorProfile !== info.cursorProfile ||
      await sha256hex(placed.subarray(0, slot.length)) !== await sha256hex(slot) ||
      await protectedHash(after, offset, capacity) !== metadata.protected_app_sha256 ||
      await sha256hex(loaderBytes(bytes, back, loader)) !== metadata.loader_sha256 ||
      crc16(after) !== back.app.dcrc || checked.product !== metadata.product)
    throw Error('Prepared firmware failed its read-back checks.');
  /* the slot as the firmware holds it (its whole capacity, 0xFF after the data): the fast swap (install.js) */
  return {bytes, product: checked.product, sha256: await sha256hex(bytes), info, plan, slot: placed.slice()};
}
