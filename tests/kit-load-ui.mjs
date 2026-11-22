// Songs & kits › Your LSDj files and kits › Load: a saved .kit goes into an empty kit slot of Install's LSDj.
// Run on a fresh local preview page; synthetic files only, nothing goes to a device.
import {BANK} from '../lsdj/lsdj-rom.js';
import {kitSlots, parseKit} from '../lsdj/lsdj-kit.js';
import {addToLibrary, clearLibrary} from '../lsdj/kit-library.js';
import {installRom} from '../lsdj/lsdj-app.js';

const $ = id => document.getElementById(id);
const assert = (condition, message) => { if (!condition) throw Error(message); };
const tick = () => new Promise(r => setTimeout(r, 50));
async function until(f, what) {
  for (let i = 0; i < 100; i++) { if (f()) return; await tick(); }
  throw Error(`timed out: ${what}`);
}
function synthetic(kits) {
  const rom = new Uint8Array(64 * BANK).fill(255);
  for (let bank = 0; bank < 2; bank++) rom.fill(bank, bank * BANK, (bank + 1) * BANK);
  rom.set(new TextEncoder().encode('LSDj-test'), 0x134);
  rom[0x147] = 0x1b; rom[0x148] = 5; rom[0x149] = 4;
  for (const bank of kits) {
    rom.fill(bank, bank * BANK, (bank + 1) * BANK);
    rom[bank * BANK] = 0x60; rom[bank * BANK + 1] = 0x40;
  }
  let checksum = 0;
  for (let i = 0x134; i < 0x14d; i++) checksum = (checksum - rom[i] - 1) & 255;
  rom[0x14d] = checksum;
  return rom;
}
async function chooseRom(bytes, name) {
  const t = new DataTransfer();
  t.items.add(new File([bytes], name));
  $('rom').files = t.files;
  await $('rom').onchange({target: $('rom')});
}
const loadButton = name => [...document.querySelectorAll('#songtools .sets-lib li')].find(li => li.textContent.startsWith(name))
  ?.querySelector('button');

export async function runKitLoadUiTests() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Run only on a local preview');
  await clearLibrary();
  /* a .kit: one bank with the kit mark and a name */
  const kit = new Uint8Array(BANK).fill(7);
  kit[0] = 0x60; kit[1] = 0x40;
  kit.set(new TextEncoder().encode('MYKIT '), 0x52);
  await addToLibrary('kit', 'mykit.kit', kit);
  await until(() => loadButton('mykit.kit'), 'the saved kit listed');
  const load = loadButton('mykit.kit');
  assert(load.textContent === 'Load', `the first button is Load: ${load.textContent}`);

  /* no LSDj in Install yet */
  load.click();
  assert(/Choose your LSDj here first/.test($('rom-info').textContent), `no LSDj: ${$('rom-info').textContent}`);
  assert(location.hash === '#install', 'Load goes to Install');

  /* an LSDj with one kit and empty slots: the kit goes into the first empty one */
  await chooseRom(synthetic([40]), 'base.gb');
  await until(() => installRom(), 'the LSDj chosen');
  const before = kitSlots(installRom().rom), empty = before.find(s => s.empty);
  assert(empty, 'the synthetic LSDj has an empty kit slot');
  loadButton('mykit.kit').click();
  assert(/Added mykit\.kit in bank/.test($('rom-info').textContent), `loaded: ${$('rom-info').textContent}`);
  const after = kitSlots(installRom().rom).find(s => s.bank === empty.bank);
  assert(!after.empty && parseKit(installRom().rom.subarray(empty.bank * BANK, (empty.bank + 1) * BANK)).name.trim() === 'MYKIT',
    'the kit is in that slot');
  assert([...$('rom-kits').querySelectorAll('input[type=checkbox]')].some(i => +i.value === empty.bank && i.checked),
    'the new kit is listed in Install, ticked');

  /* no empty slot left */
  await chooseRom(synthetic(Array.from({length: 62}, (_, i) => i + 2)), 'full.gb');
  await until(() => installRom()?.name === 'full.gb', 'the full LSDj chosen');
  if (!kitSlots(installRom().rom).some(s => s.empty)) {
    loadButton('mykit.kit').click();
    assert(/No empty kit slot/.test($('rom-info').textContent), `full: ${$('rom-info').textContent}`);
  }
  await clearLibrary();
  return 'PASS kit Load: no LSDj -> asks for one; into the first empty slot, listed and ticked; a full LSDj -> says so';
}
