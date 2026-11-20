import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BANK, SLOT_HEADER, crc32, identifyRom, programHash, listKits, sparsePack, planRom, buildSlot, parseSlot, romFromSlot, codeHash, LSDJ_PROFILES, SLOT_ADDRS, SLOT_ADDR_AT} from '../lsdj/lsdj-rom.js';
import {prepareLsdjFirmware} from '../lsdj/lsdj-firmware.js';
import {checkPackage} from '../lsdj/install.js';
import {Package, crc16} from '../vendor/fm1pkg.js';
import {Updater, pack7, STAGE_DONE, WRITE_DONE} from '../vendor/fm1ota.js';

function header(rom) {
  let n = 0;
  for (let i = 0x134; i < 0x14d; i++) n = (n - rom[i] - 1) & 255;
  rom[0x14d] = n;
}
function synthetic() {
  const rom = new Uint8Array(64 * BANK).fill(255);
  rom.fill(0, 0, 2 * BANK);
  rom.fill(1, BANK, 2 * BANK);
  rom.set(new TextEncoder().encode('LSDj-v9.3.9'), 0x134);
  rom[0x147] = 0x1b; rom[0x148] = 5; rom[0x149] = 4;
  for (const b of [8, 26, 40]) {
    rom.fill(b, b * BANK, (b + 1) * BANK);
    rom[b * BANK] = 0x60; rom[b * BANK + 1] = 0x40;
  }
  header(rom);
  return rom;
}
const rom = synthetic(), original = rom.slice(), cap = SLOT_HEADER + 4 * (8 + BANK);   /* slot v2: a table entry per bank */
assert.deepEqual(listKits(rom).map(k => k.bank), [8, 26, 40]);
assert.equal(planRom(rom, [8, 26, 40], cap).fits, false);
const plan = planRom(rom, [26, 40], cap);
assert.equal(plan.fits, true); assert.deepEqual(plan.omitted.map(k => k.bank), [8]);
const packed = sparsePack(rom, [26, 40]);
assert.equal(packed.bankMap[8], 255);
assert.equal(packed.bankMap[26], 2); assert.equal(packed.bankMap[40], 3);
assert.deepEqual(packed.storage.subarray(2 * BANK, 3 * BANK), rom.subarray(26 * BANK, 27 * BANK));
assert.deepEqual(rom, original);
const zeroBank = rom.slice(); zeroBank.fill(0, 2 * BANK, 3 * BANK);
assert.notEqual(sparsePack(zeroBank, []).bankMap[2], 255);
assert.notEqual(await programHash(zeroBank), await programHash(rom));
assert.throws(() => sparsePack(rom, [1]), /selection/);
await assert.rejects(buildSlot(rom, [8, 26, 40], cap), /Too many/);
let total = 0;
for (let b = 0; b < 64; b++) for (let i = 0; i < BANK; i++) {
  if (!b && (i === 0x14e || i === 0x14f)) continue;
  total = (total + (packed.bankMap[b] === 255 ? 255 : packed.storage[packed.bankMap[b] * BANK + i])) & 65535;
}
assert.equal(total, packed.storage[0x14e] << 8 | packed.storage[0x14f]);
const {slot} = await buildSlot(rom, [26, 40], cap);
assert.equal(parseSlot(slot, cap).stored, 4);
assert.equal(parseSlot(slot, cap).cursorProfile, 0, 'a matching title alone cannot enable cursor tracking');
const badProfile = slot.slice(); badProfile[148] = 2;
new DataView(badProfile.buffer).setUint32(252, crc32(badProfile.subarray(0, 252)), true);
assert.equal(parseSlot(badProfile, cap).error, 'layout');
{ // profile 2: another known LSDj, its cursor and tempo bytes at 149 / 151
  const p2 = slot.slice(), dv = new DataView(p2.buffer); p2[148] = 2; dv.setUint16(149, 0xc41e, true); dv.setUint16(151, 0xc52a, true);
  const seal = () => dv.setUint32(252, crc32(p2.subarray(0, 252)), true); seal();
  assert.deepEqual([parseSlot(p2, cap).cursorProfile, parseSlot(p2, cap).cursor, parseSlot(p2, cap).tempo], [2, 0xc41e, 0xc52a]);
  dv.setUint16(149, 0x8000, true); seal(); assert.equal(parseSlot(p2, cap).error, 'layout');
  p2[148] = 0; dv.setUint16(149, 0xc41e, true); seal(); assert.equal(parseSlot(p2, cap).error, 'layout');
  p2[148] = 3; seal(); assert.equal(parseSlot(p2, cap).error, 'layout');   /* profile 3 without its addresses */
}
{ /* profile 3 (0.9.98-dev.18): another LSDj with every helper, its addresses in the header (src/lsdj_slot.h); a
     profile for this program (its title and code) builds it, and it reads back; an address outside its memory is refused */
  const title = String.fromCharCode(...rom.subarray(0x134, 0x144)).replace(/\0.*$/, '');
  const addr = {sync: 0x3fbd, armed: 0xc0e0, row: 0xc16c, live: 0xc529, songrow: 0xc200, chainpos: 0xc17c, songtab: 0x1290, period: 0xc952,
    songtempo: 0x3fb4, screen: 0xc402, synclive: 0xcb64, syncmask: 0xcb6b, songcur: 0xc41f, chaintab: 0x2080, playtime: 0x3fb3};
  const entry = {title, profile: 3, cursor: 0xc41e, tempo: 0xc52a, mask: [], codeHash: await codeHash(rom, []), addr};
  LSDJ_PROFILES.push(entry);
  try {
    const {slot: s3} = await buildSlot(rom, [26, 40], cap), p = parseSlot(s3, cap);
    assert.deepEqual([p.cursorProfile, p.cursor, p.tempo, p.addr], [3, 0xc41e, 0xc52a, addr], 'profile 3 reads back');
    assert.equal(s3[148], 3);
    SLOT_ADDRS.forEach(([n], i) => assert.equal(new DataView(s3.buffer).getUint16(SLOT_ADDR_AT + 2 * i, true), addr[n], n));
    const bad = s3.slice(), dv = new DataView(bad.buffer), seal = () => dv.setUint32(252, crc32(bad.subarray(0, 252)), true);
    for (const [n, v] of [['armed', 0xdffd], ['syncmask', 0xdfff], ['sync', 0x8000], ['songtab', 0x7c01], ['chaintab', 0x7801], ['screen', 0]]) {
      const i = SLOT_ADDRS.findIndex(s => s[0] === n);
      dv.setUint16(SLOT_ADDR_AT + 2 * i, v, true); seal(); assert.equal(parseSlot(bad, cap).error, 'layout', `${n} ${v.toString(16)}`);
      dv.setUint16(SLOT_ADDR_AT + 2 * i, addr[n], true);
    }
    seal(); assert.equal(parseSlot(bad, cap).cursorProfile, 3);
    bad[148] = 2; seal(); assert.equal(parseSlot(bad, cap).error, 'layout', 'profile 2 with profile 3\'s addresses');
    entry.addr = {...addr, armed: 0xdffd};
    await assert.rejects(buildSlot(rom, [26, 40], cap), /armed address doesn't fit/, 'never written out of its memory');
  } finally { LSDJ_PROFILES.splice(LSDJ_PROFILES.indexOf(entry), 1); }
}
for (const size of [0, 8, 255, slot.length - 1]) assert.ok(parseSlot(slot.subarray(0, size), cap).error);
const corrupt = slot.slice(); corrupt[1000] ^= 1; assert.equal(parseSlot(corrupt, cap).error, 'data');
{ /* slot v2 (FM-1_991): banks stored without their 0xFF filler; read back byte for byte */
  const half = rom.slice(); half.fill(255, 26 * BANK + 5000, 27 * BANK); half.fill(255, 40 * BANK + 9, 41 * BANK);
  const hp = planRom(half, [8, 26, 40], cap);
  assert.equal(hp.fits, true, 'three kits fit once two of them are trimmed');
  assert.equal(hp.needed, SLOT_HEADER + 5 * 8 + 3 * BANK + 5000 + 9);
  const hs = (await buildSlot(half, [8, 26, 40], cap)).slot, hparsed = parseSlot(hs, cap);
  assert.equal(hs.length, hp.needed); assert.equal(hparsed.version, 2);
  assert.deepEqual(hparsed.lengths, [BANK, BANK, BANK, 5000, 9]);
  const back = romFromSlot(hs);
  assert.deepEqual(back.subarray(BANK), half.subarray(BANK), 'every bank reads back exactly (bank 0: its checksum bytes are recomputed)');
  assert.deepEqual(back.subarray(0, 0x14e), half.subarray(0, 0x14e));
  /* a version 1 slot (FM-1_990 and older) still reads back */
  const v1 = new Uint8Array(SLOT_HEADER + 5 * BANK); v1.set(hs.subarray(0, SLOT_HEADER)); const dv = new DataView(v1.buffer);
  dv.setUint16(8, 1, true); dv.setUint32(153, 0, true);
  hparsed.lengths.forEach((n, i) => { v1.fill(255, SLOT_HEADER + i * BANK, SLOT_HEADER + (i + 1) * BANK); v1.set(hs.subarray(hparsed.dataOff + hparsed.starts[i], hparsed.dataOff + hparsed.starts[i] + n), SLOT_HEADER + i * BANK); });
  dv.setUint32(16, crc32(v1.subarray(SLOT_HEADER)), true); dv.setUint32(252, crc32(v1.subarray(0, 252)), true);
  assert.equal(parseSlot(v1, v1.length).version, 1);
  assert.deepEqual(romFromSlot(v1), back, 'version 1 and 2 read back the same ROM');
  /* a broken table */
  const gap = hs.slice(), gv = new DataView(gap.buffer); gv.setUint32(SLOT_HEADER + 8 * 4, 1 + gv.getUint32(SLOT_HEADER + 8 * 4, true), true);
  gv.setUint32(252, crc32(gap.subarray(0, 252)), true); assert.equal(parseSlot(gap, cap).error, 'layout');
}
const duplicate = slot.slice(); duplicate[20 + 40] = 2;
new DataView(duplicate.buffer).setUint32(252, crc32(duplicate.subarray(0, 252)), true);
assert.equal(parseSlot(duplicate, cap).error, 'layout');
const changedKit = rom.slice(); changedKit[26 * BANK + 600] ^= 1;
assert.equal(await programHash(changedKit), await programHash(rom));
const changedCode = rom.slice(); changedCode[BANK + 600] ^= 1;
assert.notEqual(await programHash(changedCode), await programHash(rom));
for (const [offset, value] of [[0x148, 4], [0x149, 3], [0x147, 0x1c], [0x143, 0xc0]]) {
  const bad = rom.slice(); bad[offset] = value; header(bad);
  await assert.rejects(identifyRom(bad, []));
}
await assert.rejects(identifyRom(new Uint8Array(40), []), /not an LSDj/);

function request(addr, len) {
  const u = [0, 0x59, 0x30, 15, 0, 0, 0, addr & 255, addr >>> 8 & 255, addr >>> 16 & 255,
    addr >>> 24, len & 255, len >>> 8 & 255, 0];
  u.push(~u.slice(6).reduce((n, b) => n + b, 0) & 255);
  return [0xf0, ...pack7(u), 0xf7];
}
const updater = new Updater({});
function link(q) { return {q, lost: false, sent: [], send(m) { this.sent.push(m); return true; }}; }
const queued = link([request(STAGE_DONE, 8)]);
assert.equal((await updater.serve(queued, new Uint8Array(1024), STAGE_DONE, 100)).finished, true);
assert.equal(queued.onSysex, null);
for (const q of [[request(WRITE_DONE, 8)], [request(0, 0)], [request(1020, 8)], [request(STAGE_DONE, 7)]]) {
  const l = link(q);
  await assert.rejects(updater.serve(l, new Uint8Array(1024), STAGE_DONE, 100));
  assert.equal(l.sent.length, 0); assert.equal(l.onSysex, null);
}
const retries = link([request(512, 512), request(0, 512), request(0, 512), request(WRITE_DONE, 8)]);
const progress = [];
assert.equal((await updater.serve(retries, new Uint8Array(1024), WRITE_DONE, 100, n => progress.push(n))).finished, true);
assert.deepEqual(progress, [1024, 1024, 1024]);

const metaPath = new URL('../lsdj/template.json', import.meta.url);
const metadata = JSON.parse(readFileSync(metaPath));
const template = new Uint8Array(readFileSync(new URL('../lsdj/fm1-lsdj-template.fwsc', import.meta.url)));
const templateBefore = template.slice();
await assert.rejects(prepareLsdjFirmware(rom, [26, 40], template, metadata), /consent/);
const result = await prepareLsdjFirmware(rom, [26, 40], template, metadata, {experimental: true});
assert.equal(checkPackage(result.bytes).product, 'FM-1_537000998');
{ const c = checkPackage(result.bytes); assert.ok(c.burrito && c.version === 998 && c.release === '0.9.98', 'FM-1_537 + MMmmpp: LSDJ Burrito 0.9.98, version 998, newer than 997'); }
await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, product: 'FM-1_972'}, {experimental: true}), /Unsupported/);
assert.deepEqual(template, templateBefore);
const p = new Package(result.bytes);
assert.equal(crc16(p.dec.subarray(p.appOff, p.appOff + p.app.size)), p.app.dcrc);
const loader = p.entries.find(e => e.name === 'ota.bin');
const damagedLoader = result.bytes.slice(); damagedLoader[loader.dataOff + p.skew + 10] ^= 1;
assert.throws(() => checkPackage(damagedLoader), /CRC/);
await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, cartridge_offset: -1}, {experimental: true}), /window/);
const badTemplate = template.slice(); badTemplate[1000] ^= 1;
await assert.rejects(prepareLsdjFirmware(rom, [], badTemplate, metadata, {experimental: true}), /integrity/);
for (const key of ['protected_app_sha256', 'loader_sha256']) {
  await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, [key]: '0'.repeat(64)}, {experimental: true}), /verification/);
}
const versions = JSON.parse(readFileSync(new URL('../lsdj/versions.json', import.meta.url)));
for (const file of process.argv.slice(2)) {
  const local = new Uint8Array(readFileSync(file)), kits = listKits(local);
  const info = await identifyRom(local, versions);
  if (info.tested) assert.equal(info.sameProgram, true, 'catalogue program fingerprint matches known full ROM');
  const full = planRom(local, kits.map(k => k.bank), metadata.cartridge_capacity);
  // Test explicit first-kit selection only; the UI never makes this choice for the user.
  /* the first kits that fit (slot v2: by their real length, FM-1_991) */
  const keep = [];
  for (const k of kits) if (planRom(local, [...keep, k.bank], metadata.cartridge_capacity).fits) keep.push(k.bank); else break;
  if (!planRom(local, [], metadata.cartridge_capacity).fits) {
    await assert.rejects(prepareLsdjFirmware(local, [], template, metadata, {experimental: true}), /Deselect kits/);
    console.log('PASS oversized program refused:', (await identifyRom(local, [])).title);
    continue;
  }
  const r = await prepareLsdjFirmware(local, keep, template, metadata, {experimental: true});
  assert.equal(r.plan.kept, keep.length);
  if (info.tested && info.version === '9.3.9') {
    assert.equal(r.info.cursorProfile, 1);
    for (const selected of [[], keep]) {
      const originalSlot = await buildSlot(local, selected, metadata.cartridge_capacity);
      assert.equal(parseSlot(originalSlot.slot, metadata.cartridge_capacity).cursorProfile, 1);
    }
    const samples = local.slice();
    assert.ok(kits.length);
    samples[kits[0].bank * BANK + 600] ^= 1;
    const sampleSlot = await buildSlot(samples, keep, metadata.cartridge_capacity);
    assert.equal(parseSlot(sampleSlot.slot, metadata.cartridge_capacity).cursorProfile, 1, 'custom kits retain cursor profile');
    const program = local.slice(); program[BANK + 600] ^= 1;
    const unknownSlot = await buildSlot(program, keep, metadata.cartridge_capacity);
    assert.equal(parseSlot(unknownSlot.slot, metadata.cartridge_capacity).cursorProfile, 0, 'changed program cannot inherit a cursor profile');
    // FM-1_986: custom palettes (colours in bank 1, names in bank 1B) and blank kit slots keep LSDj 9.3.9
    const palettes = local.slice(); palettes[BANK + 0x16b0] ^= 0x55; palettes[0x1b * BANK + 0x1740] = 0x41;
    if (local.length > 0x23 * BANK) palettes.fill(0x20, 0x22 * BANK + 0x22, 0x22 * BANK + 0x58);
    assert.equal((await identifyRom(palettes, [])).cursorProfile, 1, 'custom palettes keep LSDj 9.3.9');
    assert.equal(parseSlot((await buildSlot(palettes, [], metadata.cartridge_capacity)).slot, metadata.cartridge_capacity).cursorProfile, 1);
    const code = local.slice(); code[BANK + 0x1690] ^= 1;   /* code next to the palettes */
    assert.equal((await identifyRom(code, [])).cursorProfile, 0, 'code next to the palettes still counts');
  }
  console.log('PASS local package round trip:', r.info.title, 'code', r.plan.codeBanks, 'kits', keep.length, '/', kits.length);
  if (process.env.LSDJ_SLOT_SMOKE) {
    const dir = mkdtempSync(join(tmpdir(), 'lsdj-slot-')), path = join(dir, 'slot.bin');
    try {
      writeFileSync(path, (await buildSlot(local, keep, metadata.cartridge_capacity)).slot);
      const args = process.env.LSDJ_CURSOR_SAVE ? [path, process.env.LSDJ_CURSOR_SAVE] : [path];
      const smoke = spawnSync(process.env.LSDJ_SLOT_SMOKE, args, {encoding: 'utf8', timeout: 120000});
      assert.equal(smoke.status, 0, String(smoke.error || smoke.stderr));
      if (info.cursorProfile && process.env.LSDJ_CURSOR_SAVE) assert.match(smoke.stdout, /PASS cursor FX/);
      console.log(smoke.stdout.trim());
    } finally { unlinkSync(path); rmdirSync(dir); }
  }
}
console.log('PASS loader: validation, kit identity, checksum, bounds, program fingerprints, template protection, loader CRC, queued and invalid completion, retries');
