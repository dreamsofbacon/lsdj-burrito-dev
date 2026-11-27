// SPDX-License-Identifier: GPL-3.0-only
// The Cartridge Studio in the browser (lsdj/studio-ui.js and its worker), with made-up files only: run in a fresh local
// preview (rt_check.html?m=studio-ui&s=runStudioUiTests,runStudioFullSaveTests).
// runStudioUiTests: files go in through the picker as a person's would; the songs are sorted into a card named after
// their save, a song dragged into another card, moved back out and in with its menu, reordered, several ticked and
// moved at once, a missing kit left silent, both cards made and added to the crate; then 40 songs in one card: it
// makes two cartridges, or ("Start a new card") its songs past 32 move into a new card.
// runStudioFullSaveTests: Songs & kits, a save that is full: the songs that didn't go in are offered to Build, which
// sorts them all into cartridges.
import {mountStudio, studioState} from '../lsdj/studio-ui.js';
import {loadItems} from '../lsdj/crate.js';
import {buildSav, writeLsdsng} from '../lsdj/lsdj-sav.js';
import {kitOf, lsdj, song, blank} from './lsdj-fixtures.mjs';
import {clearLibrary} from '../lsdj/kit-library.js';

const assert = (v, m) => { if (!v) throw Error(typeof m === 'function' ? m() : m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, m, ms = 8000) { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return; await sleep(50); } throw Error(typeof m === 'function' ? m() : m); }
const KA = kitOf('ALPHA', [4, 5], true, 1), KB = kitOf('BRAVO', [3, 3, 3], true, 7);
const savOf = (prefix, list) => buildSav(blank(), list[0], list.map((s, i) => ({slot: i, name: `${prefix}${i}`, song: s})), 0);
const fresh = async () => {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  await clearLibrary();
  try { for (const k of ['cart-built', 'dj-crate', 'studio-full']) localStorage.removeItem(k); } catch {}
};

export async function runStudioUiTests() {
  await fresh();
  const box = Object.assign(document.createElement('div'), {id: 'studio'}); document.body.append(box);
  await mountStudio(box);
  await until(() => /Drop everything here/.test(box.textContent) && /Drop your own LSDj ROMs/.test(box.textContent), 'empty: says what to drop');
  const pickFiles = list => {
    const dt = new DataTransfer();
    for (const [name, bytes] of list) dt.items.add(new File([bytes], name));
    const input = box.querySelector('input[type=file]:not([webkitdirectory])');
    input.files = dt.files; input.dispatchEvent(new Event('change'));
  };
  const status = () => box.querySelector('.studio-status').textContent;
  const buttons = t => [...box.querySelectorAll('button')].filter(b => typeof t === 'string' ? b.textContent === t : t.test(b.textContent));
  const cards = () => [...box.querySelectorAll('.studio-cart')];
  const names = card => [...card.querySelectorAll('.studio-slotsong b.mono')].map(b => b.textContent).join();
  const row = n => [...box.querySelectorAll('.studio-song')].find(r => r.querySelector('b.mono')?.textContent === n);
  const cardOf = n => cards().find(c => names(c).split(',').includes(n));
  const select = (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change')); };

  const rom = lsdj('9.3.9', [KA, KB]), rom2 = lsdj('9.2.0', [KA, KB]);
  const sA = song([{ins: 0, k1: 0}], [0x10, 0x20]), sB = song([{ins: 0, k1: 1}], [0x30]), sLost = song([{ins: 0, k1: 6}], [0x10]);
  const sav = buildSav(blank(), sA, [{slot: 0, name: 'ALPHASNG', song: sA}, {slot: 1, name: 'BRAVOSNG', song: sB}, {slot: 2, name: 'LOSTSNG', song: sLost}], 0);
  pickFiles([['v939.gb', rom], ['v920.gb', rom2], ['set.sav', sav], ['readme.txt', new Uint8Array(4)]]);
  await until(() => cards().length === 1 && names(cards()[0]).split(',').length === 3, () => `three songs sorted into a card: ${cards().map(names)}; ${status()}`);
  assert(box.querySelectorAll('.studio-ver').length === 2, 'both LSDj versions in step 1');
  assert(/sorted into 1 cartridge/.test(status()), `said it sorted them: ${status()}`);
  assert(cards()[0].querySelector('.cm-cartname').value === 'SET', `the card is named after its save: ${cards()[0].querySelector('.cm-cartname').value}`);
  assert(/kit missing/.test(row('LOSTSNG').textContent), 'LOSTSNG: its kit is missing');
  assert(/isn't in your LSDj files/.test(cards()[0].textContent), 'the card says LOSTSNG is missing a kit');
  assert(/in SET/.test(box.querySelector('.studio-group').textContent), 'the save\'s group says where its songs are');

  /* a new card; a song dragged into it */
  buttons('New cartridge')[0].click();
  await until(() => cards().length === 2, 'a second card');
  const drag = (el, type, data) => el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: data}));
  const t = new DataTransfer();
  drag(row('BRAVOSNG'), 'dragstart', t); drag(cards()[1], 'dragover', t); drag(cards()[1], 'drop', t);
  await until(() => cardOf('BRAVOSNG') === cards()[1], 'BRAVOSNG dragged into the new card');
  assert(cardOf('ALPHASNG') === cards()[0], 'ALPHASNG stays in the first');

  /* out with its menu, then into card 2, then up */
  select(row('ALPHASNG').querySelector('.studio-move'), '-');
  await until(() => !cardOf('ALPHASNG') && /not in a cartridge/.test(row('ALPHASNG').textContent), 'ALPHASNG back with the loose songs');
  select(row('ALPHASNG').querySelector('.studio-move'), cards()[1].dataset.id);
  await until(() => names(cards()[1]) === 'BRAVOSNG,ALPHASNG', () => `ALPHASNG into card 2: ${names(cards()[1])}`);
  cards()[1].querySelector('button[aria-label="Move ALPHASNG up"]').click();
  await until(() => names(cards()[1]) === 'ALPHASNG,BRAVOSNG', () => `moved up: ${names(cards()[1])}`);

  /* two ticked, moved at once into a new card; the empty one removed */
  row('ALPHASNG').querySelector('input[type=checkbox]').click();
  row('BRAVOSNG').querySelector('input[type=checkbox]').click();
  await until(() => /2 ticked/.test(box.querySelector('.studio-selbar')?.textContent ?? ''), 'two ticked');
  [...box.querySelector('.studio-selbar').querySelectorAll('button')].find(b => b.textContent === 'New cartridge').click();
  await until(() => cards().length === 3 && names(cards()[2]) === 'ALPHASNG,BRAVOSNG', () => `both into card 3: ${cards().map(names)}`);
  cards()[1].querySelector('.studio-x').click();
  await until(() => cards().length === 2, 'the empty card removed');

  /* a missing kit left silent */
  row('LOSTSNG').querySelector('.studio-note').click();
  await until(() => row('LOSTSNG').querySelector('.cm-kitpick'), 'its kits open');
  select(row('LOSTSNG').querySelector('.cm-kitpick'), 'none');
  await until(() => !row('LOSTSNG').querySelector('.studio-note') && !/isn't in your LSDj files/.test(cards()[0].textContent), 'left silent: no longer missing');

  /* what a full card does: this viewer's choice, kept */
  buttons('Start a new card')[0].click();
  await until(() => buttons('Start a new card')[0].getAttribute('aria-checked') === 'true' && localStorage.getItem('studio-full') === 'new', 'Start a new card chosen');
  buttons('It makes more cartridges')[0].click();
  await until(() => localStorage.getItem('studio-full') === 'split', 'back to It makes more cartridges');

  /* made, and into the DJ crate */
  buttons(/^Make all/)[0].click();
  await until(() => buttons('Add to the DJ crate').length === 2, 'both made', 15000);
  assert(buttons('Download .gb + .sav').length === 2 && buttons('Install on the FM-1…').length === 2, 'download and install offered');
  buttons('Install on the FM-1…')[0].click();
  await until(() => box.querySelector('.studio-ask') && buttons('Go to Install').length === 1, 'Install asks first, in the card');
  buttons('Cancel')[0].click();
  await until(() => !box.querySelector('.studio-ask'), 'Cancel: nothing installed');
  buttons('Add them all to the crate')[0].click();
  await until(() => /is in the DJ crate/.test(status()) && [...box.querySelectorAll('.studio-cart .ok')].filter(x => x.textContent === 'In the crate.').length === 2, () => `added: ${status()}`, 15000);
  assert(loadItems(localStorage.getItem('dj-crate')).length === 2, () => 'two cards in the crate: ' + (localStorage.getItem('dj-crate') || '').slice(0, 300));

  /* 40 songs in one card: two cartridges, every sample kept; or, Start a new card: the 8 past 32 in a card of their own */
  buttons('Start again')[0].click();
  await until(() => !box.querySelector('.studio-cart') && /Drop everything here/.test(box.textContent), 'started again');
  const forty = Array.from({length: 40}, (_, i) => song([{ins: 0, k1: i % 2}], [0x10 + (i % 3) * 0x10]));
  pickFiles([['friday.sav', savOf('FRI', forty.slice(0, 32))], ...forty.slice(32).map((s, i) => [`extra${i}.lsdsng`, writeLsdsng({name: `XTRA${i}`, version: 1, song: s})])]);
  await until(() => studioState().carts.reduce((n, c) => n + c.songIds.length, 0) === 40, () => `40 songs sorted: ${status()}`, 15000);
  assert([...box.querySelectorAll('.studio-group-name')].map(g => g.textContent).join() === 'friday.sav,.lsdsng songs', 'a group for the save, one for the .lsdsng songs');
  for (const g of box.querySelectorAll('.studio-group-head input[type=checkbox]')) g.click();
  await until(() => /40 ticked/.test(box.querySelector('.studio-selbar')?.textContent ?? ''), 'all 40 ticked');
  [...box.querySelector('.studio-selbar').querySelectorAll('button')].find(b => b.textContent === 'New cartridge').click();
  await until(() => box.querySelector('.studio-many')?.textContent === 'makes 2 cartridges', () => `one card of 40 makes two: ${box.querySelector('.studio-many')?.textContent}`);
  const big = studioState().carts.find(c => c.songIds.length === 40);
  assert(big, 'one card holds all 40');
  buttons('Start a new card')[0].click();
  await until(() => studioState().carts.filter(c => c.songIds.length).map(c => c.songIds.length).join() === '32,8', () => `split into 32 + 8: ${studioState().carts.map(c => c.songIds.length)}`);
  assert(!box.querySelector('.studio-many'), 'no card makes several now');
  await clearLibrary();
  try { localStorage.removeItem('studio-full'); } catch {}
  return 'PASS studio: LSDj versions and songs dropped (a stray file skipped), sorted into a card named after its save, a song dragged into another card, moved out and back with its menu, reordered, two ticked and moved at once, an empty card removed, a missing kit left silent, the full-card choice kept, both made (Install asks in the card), added to the DJ crate; 40 songs in one card make two cartridges, or split 32 + 8 into two cards';
}

export async function runStudioFullSaveTests() {
  await fresh();
  const {openSave, addLsdsng, useRom} = await import('../lsdj/songs-ui.js');
  const studio = document.getElementById('studio'), tools = document.getElementById('songtools');
  location.hash = '#songtools';
  const songs = Array.from({length: 35}, (_, i) => song([{ins: 0, k1: i % 2}], [0x10 + (i % 3) * 0x10]));
  openSave(savOf('FULL', songs.slice(0, 32)), 'gig.sav');
  useRom(lsdj('9.3.9', [KA, KB]), 'v939.gb');
  await addLsdsng(songs.slice(32).map((s, i) => new File([writeLsdsng({name: `MORE${i}`, version: 1, song: s})], `more${i}.lsdsng`)));
  const note = () => tools.querySelector('.st-full');
  await until(() => note() && /This save is full: 32 of 32 songs/.test(note().textContent) && /MORE0, MORE1, MORE2/.test(note().textContent), () => `the full note: ${note()?.textContent}`);
  [...note().querySelectorAll('button')].find(b => b.textContent === 'Make cartridges from all 35 in Build →').click();
  await until(() => location.hash === '#studio', () => `Build opens: ${location.hash}; Songs & kits says: ${document.getElementById('st-status')?.textContent}; note: ${!!note()}`);
  await until(() => studioState().carts.reduce((n, c) => n + c.songIds.length, 0) === 35, () => `all 35 in cartridges: ${studio.querySelector('.studio-status')?.textContent}`, 15000);
  assert(!note(), 'the note is gone');
  await until(() => studio.querySelectorAll('.studio-cart').length === 2 && /sorted into 2 cartridges/.test(studio.querySelector('.studio-status').textContent),
    () => `two cartridges (32 + 3): ${studio.querySelectorAll('.studio-cart').length}; ${studio.querySelector('.studio-status').textContent}`);
  assert(studioState().carts.map(c => c.songIds.length).join() === '32,3', () => `32 + 3: ${studioState().carts.map(c => c.songIds.length)}`);
  await clearLibrary();
  return 'PASS Songs & kits, a full save: the 3 songs that did not fit offered to Build, which puts all 35 into two cartridges';
}
