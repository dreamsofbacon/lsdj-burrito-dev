// SPDX-License-Identifier: GPL-3.0-only
// The Cartridge Studio in the browser (lsdj/studio-ui.js and its worker), with made-up files only: run in a fresh local
// preview (rt_check.html?m=studio-ui&s=runStudioUiTests). Files go in through the picker as a person's would; songs are
// sorted into a cartridge, dragged into another, moved back out, a missing kit left silent, the carts made and added.
import {mountStudio, studioState} from '../lsdj/studio-ui.js';
import {loadItems} from '../lsdj/crate.js';
import {buildSav} from '../lsdj/lsdj-sav.js';
import {kitOf, lsdj, song, blank} from './lsdj-fixtures.mjs';
import {clearLibrary} from '../lsdj/kit-library.js';

const assert = (v, m) => { if (!v) throw Error(typeof m === 'function' ? m() : m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, m, ms = 8000) { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return; await sleep(50); } throw Error(typeof m === 'function' ? m() : m); }

export async function runStudioUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  await clearLibrary();
  try { localStorage.removeItem('cart-built'); localStorage.removeItem('dj-crate'); } catch {}
  const box = Object.assign(document.createElement('div'), {id: 'studio'}); document.body.append(box);
  await mountStudio(box);
  await until(() => /Drop your own LSDj ROMs/.test(box.textContent), 'empty: says to drop an LSDj');

  const KA = kitOf('ALPHA', [4, 5], true, 1), KB = kitOf('BRAVO', [3, 3, 3], true, 7);
  const rom = lsdj('9.3.9', [KA, KB]), rom2 = lsdj('9.2.0', [KA, KB]);
  const sA = song([{ins: 0, k1: 0}], [0x10, 0x20]), sB = song([{ins: 0, k1: 1}], [0x30]), sLost = song([{ins: 0, k1: 6}], [0x10]);
  const sav = buildSav(blank(), sA, [{slot: 0, name: 'ALPHASNG', song: sA}, {slot: 1, name: 'BRAVOSNG', song: sB}, {slot: 2, name: 'LOSTSNG', song: sLost}], 0);
  const dt = new DataTransfer();
  for (const [name, bytes] of [['v939.gb', rom], ['v920.gb', rom2], ['set.sav', sav], ['readme.txt', new Uint8Array(4)]]) dt.items.add(new File([bytes], name));
  const input = box.querySelector('input[type=file]:not([webkitdirectory])');
  input.files = dt.files; input.dispatchEvent(new Event('change'));
  await until(() => box.querySelectorAll('.studio-cart .studio-song').length === 3, () => `three songs sorted into carts: ${box.querySelectorAll('.studio-cart .studio-song').length}; ${box.querySelector('.studio-status')?.textContent}`);
  assert(box.querySelectorAll('.studio-tile').length === 2, 'both LSDj versions on the shelf');
  assert(/sorted into 1 cartridge/.test(box.querySelector('.studio-status').textContent), `said it sorted them: ${box.querySelector('.studio-status').textContent}`);
  const song_ = n => [...box.querySelectorAll('.studio-song')].find(r => r.querySelector('b.mono')?.textContent === n);
  const cartOf = n => song_(n)?.closest('.studio-cart');
  assert(/kit missing/.test(song_('LOSTSNG').textContent), 'LOSTSNG: its kit is missing');

  /* a new cartridge; a song dragged into it */
  [...box.querySelectorAll('button')].find(b => b.textContent === 'New cartridge').click();
  await until(() => box.querySelectorAll('.studio-cart').length === 2, 'a second cartridge');
  const drag = (el, type, data) => el.dispatchEvent(Object.assign(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: data}), {}));
  const t = new DataTransfer();
  drag(song_('BRAVOSNG'), 'dragstart', t);
  drag(box.querySelectorAll('.studio-cart')[1], 'dragover', t);
  drag(box.querySelectorAll('.studio-cart')[1], 'drop', t);
  await until(() => cartOf('BRAVOSNG') === box.querySelectorAll('.studio-cart')[1], 'BRAVOSNG dragged into the new cartridge');
  assert(cartOf('ALPHASNG') === box.querySelectorAll('.studio-cart')[0], 'ALPHASNG stays in the first');

  /* moved back out with the keyboard way (the select) */
  const mv = song_('ALPHASNG').querySelector('.studio-move'); mv.value = '-'; mv.dispatchEvent(new Event('change'));
  await until(() => song_('ALPHASNG') && !cartOf('ALPHASNG') && /ALPHASNG/.test(box.querySelector('.studio-pool').textContent), 'ALPHASNG back in the loose songs');

  /* reorder inside a cartridge: a second song into cartridge 2, then moved up */
  const mv2 = song_('ALPHASNG').querySelector('.studio-move'); mv2.value = box.querySelectorAll('.studio-cart')[1].dataset.id; mv2.dispatchEvent(new Event('change'));
  await until(() => cartOf('ALPHASNG') === box.querySelectorAll('.studio-cart')[1], 'ALPHASNG into cartridge 2');
  const order = () => [...box.querySelectorAll('.studio-cart')[1].querySelectorAll('b.mono')].map(b => b.textContent).join();
  assert(order() === 'BRAVOSNG,ALPHASNG', `order: ${order()}`);
  song_('ALPHASNG').querySelector('button[aria-label^="Move ALPHASNG up"]').click();
  await until(() => order() === 'ALPHASNG,BRAVOSNG', () => `moved up: ${order()}`);
  assert(/slot 1/.test(song_('ALPHASNG').textContent), 'its slot number follows');

  /* a missing kit left silent */
  const pick = song_('LOSTSNG').querySelector('.cm-kitpick'); assert(pick, 'the missing kit offers a pick');
  pick.value = 'none'; pick.dispatchEvent(new Event('change'));
  await until(() => /kits found/.test(song_('LOSTSNG').textContent), 'left silent: no longer missing');

  /* made, and into the DJ crate */
  [...box.querySelectorAll('button')].find(b => /^Make all/.test(b.textContent)).click();
  await until(() => [...box.querySelectorAll('button')].filter(b => b.textContent === 'Add to the DJ crate').length === 2, 'both made', 15000);
  assert([...box.querySelectorAll('button')].some(b => b.textContent === 'Download .gb + .sav'), 'download offered');
  [...box.querySelectorAll('button')].find(b => b.textContent === 'Add them all to the crate').click();
  await until(() => /is in the DJ crate/.test(box.querySelector('.studio-status').textContent) && [...box.querySelectorAll('.studio-cart .ok')].filter(x => x.textContent === 'In the crate.').length === 2, () => `added: ${box.querySelector('.studio-status').textContent}`, 15000);
  assert(studioState().carts.length === 2, 'two carts');
  assert(loadItems(localStorage.getItem('dj-crate')).length === 2, () => 'two cards in the crate: ' + (localStorage.getItem('dj-crate') || '').slice(0, 300));
  await clearLibrary();
  return 'PASS studio: LSDj versions and songs dropped (a stray file skipped), sorted into a cartridge, a cartridge added and a song dragged into it, moved back out with the select, reordered, a missing kit left silent, both carts made and added to the DJ crate';
}
