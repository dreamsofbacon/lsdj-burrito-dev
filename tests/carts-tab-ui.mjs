// SPDX-License-Identifier: GPL-3.0-only
// The Cartridges tab (lsdj/carts-ui.js) on the page: an LSDj added there is listed; Install… opens it in Install;
// the kits unticked there are kept with it and ticked the same when it's chosen again (Install's own picker);
// a name of its own; kit edits kept as linked copies, the in-between ones cleaned up; one a crate card plays can't
// be forgotten; Songs and kits' picker lists it. Run on a fresh local preview page; synthetic files only.
import {BANK} from '../lsdj/lsdj-rom.js';
import {clearLibrary, libraryFiles} from '../lsdj/kit-library.js';
import {installRom} from '../lsdj/lsdj-app.js';
import {cartridges, renameCartridge} from '../lsdj/cartridges.js';

const $ = id => document.getElementById(id);
const assert = (condition, message) => { if (!condition) throw Error(message); };
const tick = () => new Promise(r => setTimeout(r, 50));
async function until(f, what) {
  for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await tick(); }
  throw Error(`timed out: ${what}`);
}
function synthetic(kits, mark = 0) {
  const rom = new Uint8Array(64 * BANK).fill(255);
  for (let bank = 0; bank < 2; bank++) rom.fill(bank, bank * BANK, (bank + 1) * BANK);
  rom[0x3000] = mark;
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
const files = (input, list) => { const t = new DataTransfer(); for (const [b, n] of list) t.items.add(new File([b], n)); input.files = t.files; input.onchange(); };
const cardOf = name => [...document.querySelectorAll('#carts .cart-card')].find(c => c.querySelector('b')?.textContent === name);
const button = (box, text) => [...box.querySelectorAll('button')].find(b => b.textContent === text);
const ticks = () => new Map([...$('rom-kits').querySelectorAll('input[type=checkbox]')].map(i => [+i.value, i.checked]));
const pick = async (sel, id) => { await until(() => [...sel.options].some(o => o.value === id), 'the cartridge in the picker'); sel.value = id; sel.onchange(); };

export async function runCartsTabUiTests() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Run only on a local preview');
  const confirmWas = window.confirm;
  window.confirm = () => true;
  try {
    await clearLibrary();
    localStorage.removeItem('burrito-install-cart'); localStorage.removeItem('dj-crate');
    location.hash = '#carts';

    /* added in the tab: listed, with its kits */
    files($('carts').querySelector('input[type=file]'), [[synthetic([40, 41]), 'base.gb'], [new Uint8Array(500), 'notes.gb']]);
    const card = await until(() => cardOf('base.gb'), 'base.gb listed');
    assert(/2 kits/.test(card.textContent), `its kits: ${card.textContent}`);
    assert(/Not added: notes\.gb/.test($('carts-status').textContent), `a bad file said: ${$('carts-status').textContent}`);
    const base = (await cartridges()).find(c => c.name === 'base.gb');

    /* Install… : opened in Install, every kit ticked */
    button(card, 'Install…').click();
    await until(() => installRom()?.name === 'base.gb' && ticks().size === 2, 'base.gb in Install');
    assert(location.hash === '#install', 'Install shown');
    assert([...ticks().values()].every(Boolean), 'all ticked the first time');

    /* a kit unticked: kept with the cartridge */
    $('rom-kits').querySelector('input[value="40"]').checked = false;
    $('rom-kits').onchange();
    await until(async () => (await cartridges()).find(c => c.id === base.id)?.kits?.join() === '41', 'the kit choice kept');

    /* another LSDj, then this one again from Install's picker: unticked as left */
    const t = new DataTransfer(); t.items.add(new File([synthetic([42], 1)], 'other.gb')); $('rom').files = t.files;
    await $('rom').onchange({target: $('rom')});
    await until(() => installRom()?.name === 'other.gb', 'other.gb chosen');
    await pick($('rom-cart'), base.id);
    await until(() => installRom()?.name === 'base.gb' && ticks().size === 2, 'base.gb again');
    assert(ticks().get(40) === false && ticks().get(41) === true, `the ticks as left: ${[...ticks()]}`);
    assert(/the ones you chose last time/.test($('rom-info').textContent), `said: ${$('rom-info').textContent}`);
    assert(localStorage.getItem('burrito-install-cart') === base.id, "Install's cartridge remembered");

    /* a name of its own */
    await renameCartridge(base.id, 'My live LSDj');
    location.hash = '#carts';
    await until(() => cardOf('My live LSDj'), 'renamed');
    assert(cardOf('My live LSDj').querySelector('.badge')?.textContent === "Install's", "marked as Install's");

    /* two kit edits in Install: two linked copies; the first one is in between and cleaned up */
    const kit = new Uint8Array(BANK).fill(7); kit[0] = 0x60; kit[1] = 0x40;
    location.hash = '#install';
    document.dispatchEvent(new CustomEvent('install-this-kit', {detail: {bytes: kit, name: 'a.kit'}}));
    await until(async () => (await cartridges()).length === 3, 'the first edit kept');
    const kit2 = kit.slice(); kit2[9] = 1;
    document.dispatchEvent(new CustomEvent('install-this-kit', {detail: {bytes: kit2, name: 'b.kit'}}));
    await until(async () => (await cartridges()).length === 4, 'the second edit kept');
    const edits = (await cartridges()).filter(c => c.from === 'edited');
    const first = edits.find(c => c.parent === base.id), second = edits.find(c => c.parent === first?.id);
    assert(first && second, 'each edit linked to the one it came from');
    assert(localStorage.getItem('burrito-install-cart') === second.id, 'Install now opens the newest edit');
    location.hash = '#carts';
    const clean = await until(() => button($('carts'), 'Clean up 1 copy'), 'the clean-up offered');
    clean.click();
    await until(async () => !(await cartridges()).some(c => c.id === first.id), 'the in-between copy gone');
    assert((await cartridges()).find(c => c.id === second.id).parent === base.id, 'the newest now points at the first');

    /* a crate card plays it: Forget is off */
    localStorage.setItem('dj-crate', JSON.stringify([{id: 'c1', name: 'Card', rom: base.id, sav: null, added: 1}]));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await until(() => button(cardOf('My live LSDj'), 'Forget')?.disabled, 'Forget off for a crate card');
    localStorage.removeItem('dj-crate');

    /* Songs and kits' picker lists the cartridges, and uses one */
    await pick($('st-cart'), base.id);
    await until(() => /Kit names from My live LSDj/.test($('st-status').textContent), `Songs uses it: ${$('st-status').textContent}`);
    assert(!(await libraryFiles()).some(f => f.name === 'notes.gb'), 'the bad file not kept');

    /* no FM-1 here: the tab says to connect one; before an install, the copy check says it couldn't tell and goes on */
    location.hash = '#carts';
    await until(() => /Connect an FM-1/.test($('carts-fm1').textContent), `no FM-1: ${$('carts-fm1').textContent}`);
    const said = [], {keepBeforeInstall} = await import('../lsdj/carts-ui.js');
    assert(await keepBeforeInstall(t => said.push(t)) === true, 'no FM-1: the install isn\'t stopped');
    assert(/Couldn't tell which LSDj the FM-1 has/.test(said.join(' ')), `said: ${said}`);
    return 'PASS Cartridges tab: added and listed (a bad file said), Install… opens it, kit ticks kept and restored from the picker, renamed, kit edits linked and the in-between copy cleaned up, a crate card protects it, Songs & kits picks it';
  } finally {
    window.confirm = confirmWas;
    await clearLibrary();
    localStorage.removeItem('burrito-install-cart'); localStorage.removeItem('dj-crate');
  }
}
