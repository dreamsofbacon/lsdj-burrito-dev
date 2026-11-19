// SPDX-License-Identifier: GPL-3.0-only
// Songs & kits › One song per save: off with no save open; with one open, Each song to the DJ crate adds a card a
// song (each a save holding that song alone, open), and the .zip button makes a .zip. Synthetic songs only.
import {openSave} from '../lsdj/songs-ui.js';
import {buildSav, parseSav, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {libraryFiles, removeFromLibrary} from '../lsdj/kit-library.js';
import {KEY, loadItems} from '../lsdj/crate.js';

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
    openSave(sav, 'two-songs.sav');
    assert(!$('st-split').disabled && !$('st-split-crate').disabled, 'on with a save open');
    $('st-split-crate').click();
    const items = await until(() => { const i = loadItems(localStorage.getItem(KEY)); return i.length === 2 && i; }, 'two crate cards');
    assert(items.map(i => i.name).join() === 'ONE,TWO', `a card a song: ${items.map(i => i.name)}`);
    const files = new Map((await libraryFiles()).map(f => [f.id, f]));
    for (const it of items) {
      const one = parseSav(files.get(it.sav).bytes);
      assert(one.songs.length === 1 && one.songs[0].name === it.name && one.active === 0, `${it.name}: alone and open`);
    }
    assert(/2 cards in the DJ crate/.test($('st-status').textContent), `said: ${$('st-status').textContent}`);
    $('st-split').click();
    await until(() => clicks.some(n => /one song per save\.zip$/.test(n)), 'the .zip downloaded');
    for (const it of items) await removeFromLibrary(it.sav);
    return 'PASS one song per save: a crate card a song (alone, open) and a .zip of one-song saves';
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    if (crateWas == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, crateWas);
  }
}
