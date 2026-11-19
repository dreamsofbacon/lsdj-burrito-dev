// SPDX-License-Identifier: GPL-3.0-only
// Songs & kits › A cartridge per song: off with no save open; with one open, each asks which LSDj goes with the
// songs (choose-lsdj.js; Cancel adds nothing), then Each song to the DJ crate adds a cartridge a song (that LSDj and
// a save holding the song alone, open), and Download makes a .zip of NAME.gb + NAME.sav folders. Synthetic files.
import {openSave} from '../lsdj/songs-ui.js';
import {buildSav, parseSav, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {libraryFiles, removeFromLibrary} from '../lsdj/kit-library.js';
import {KEY, loadItems} from '../lsdj/crate.js';
import {addCartridge} from '../lsdj/cartridges.js';
import {lsdj} from './lsdj-fixtures.mjs';

const $ = id => document.getElementById(id);
const assert = (c, m) => { if (!c) throw Error(m); };
const tick = () => new Promise(r => setTimeout(r, 50));
async function until(f, what) { for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await tick(); } throw Error(`timed out: ${what}`); }
const song = n => { const s = new Uint8Array(0x8000); s.fill(0xff, 0x1290, 0x1290 + 1024); s.fill(0xff, 0x2080, 0x2080 + 2048); s.fill(0xff, 0x7000, 0x7000 + 0xff0); s[0] = n; return s; };

export async function runSplitUiTests() {
  assert(location.hostname === '127.0.0.1' || location.hostname === 'localhost', 'Run only on a local preview');
  const crateWas = localStorage.getItem(KEY);
  const blank = new Uint8Array(SAV_SIZE); blank[0x813e] = 0x6a; blank[0x813f] = 0x6b;
  const sav = buildSav(blank, song(9), [{slot: 2, name: 'ONE', song: song(1)}, {slot: 5, name: 'TWO', song: song(2)}], 2);
  const clicks = [];
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
  try {
    localStorage.setItem(KEY, '[]');
    location.hash = '#songtools';
    const rom = await addCartridge(lsdj('9.3.9', []), 'split-test.gb');
    openSave(sav, 'two-songs.sav');
    assert(!$('st-split').disabled && !$('st-split-crate').disabled, 'on with a save open');
    const dialog = () => document.querySelector('dialog.choose-lsdj');
    const press = text => [...dialog().querySelectorAll('button')].find(b => b.textContent === text).click();
    /* Cancel: nothing added */
    $('st-split-crate').click();
    await until(() => dialog()?.open, 'asked which LSDj');
    press('Cancel');
    await until(() => /Nothing was added/.test($('st-status').textContent), `cancelled: ${$('st-status').textContent}`);
    assert(loadItems(localStorage.getItem(KEY)).length === 0, 'nothing in the crate');
    /* chosen: a cartridge a song */
    $('st-split-crate').click();
    await until(() => dialog()?.querySelector(`input[type=radio]`), 'the LSDj listed');
    [...dialog().querySelectorAll('label')].find(l => /split-test\.gb/.test(l.textContent)).querySelector('input').click();
    press('Use this LSDj');
    const items = await until(() => { const i = loadItems(localStorage.getItem(KEY)); return i.length === 2 && i; }, 'two crate cards');
    assert(items.map(i => i.name).join() === 'ONE,TWO', `a card a song: ${items.map(i => i.name)}`);
    const files = new Map((await libraryFiles()).map(f => [f.id, f]));
    for (const it of items) {
      assert(it.rom === rom.id, `${it.name}: with its LSDj`);
      const one = parseSav(files.get(it.sav).bytes);
      assert(one.songs.length === 1 && one.songs[0].name === it.name && one.active === 0, `${it.name}: alone and open`);
    }
    assert(/2 cartridges in the DJ crate/.test($('st-status').textContent), `said: ${$('st-status').textContent}`);
    $('st-split').click();
    await until(() => dialog()?.open && dialog().querySelector('input[type=radio]'), 'asked again for the .zip');
    press('Use this LSDj');
    await until(() => clicks.some(n => /a cartridge per song\.zip$/.test(n)), 'the .zip downloaded');
    for (const it of items) await removeFromLibrary(it.sav);
    return 'PASS a cartridge per song: asked which LSDj (Cancel: nothing), a crate cartridge a song (its LSDj, the song alone and open), a .zip of .gb + .sav pairs';
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    if (crateWas == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, crateWas);
  }
}
