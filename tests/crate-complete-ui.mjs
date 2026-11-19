// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate holds whole cartridges only (Colin): an LSDj and its .sav opened together (the same name) make one
// card; a .sav alone asks which LSDj goes with it (Cancel: no card); a card downloads as NAME.gb + NAME.sav;
// Export cartridges makes a .zip of them all. Synthetic files only; no FM-1.
import {KEY, loadItems} from '../lsdj/crate.js';
import {buildSav, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {lsdj} from './lsdj-fixtures.mjs';
import {hashOf} from '../lsdj/kit-library.js';

const assert = (c, m) => { if (!c) throw Error(m); };
const tick = () => new Promise(r => setTimeout(r, 50));
async function until(f, what) { for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await tick(); } throw Error(`timed out: ${what}`); }
const song = n => { const s = new Uint8Array(0x8000); s.fill(0xff, 0x1290, 0x1290 + 1024); s.fill(0xff, 0x2080, 0x2080 + 2048); s.fill(0xff, 0x7000, 0x7000 + 0xff0); s[0] = n; return s; };
const save = (name, n) => { const b = new Uint8Array(SAV_SIZE); b[0x813e] = 0x6a; b[0x813f] = 0x6b; return buildSav(b, song(n), [{slot: 0, name, song: song(n)}], 0); };

export async function runCrateCompleteUiTests() {
  assert(location.hostname === '127.0.0.1' || location.hostname === 'localhost', 'Run only on a local preview');
  const crate = document.querySelector('.dj-crate'), items = () => loadItems(localStorage.getItem(KEY));
  assert(crate, 'the crate is on the page');
  const pick = files => { const i = crate.querySelector('input[type=file]'), t = new DataTransfer(); for (const [b, n] of files) t.items.add(new File([b], n)); i.files = t.files; return i.onchange(); };
  const dialog = () => document.querySelector('dialog.choose-lsdj');
  const press = (box, text) => [...box.querySelectorAll('button')].find(b => b.textContent === text)?.click();
  const card = name => [...crate.querySelectorAll('.crate-cart')].find(c => c.querySelector('.crate-name')?.value === name);
  const clicks = [], realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
  const before = items().length;
  try {
    /* lsdj.gb and lsdj.sav together: one whole cartridge */
    const rom = lsdj('9.3.9', []);
    await pick([[rom, 'Friday.gb'], [save('HOUSE', 3), 'Friday.sav']]);
    await until(() => items().length === before + 1, 'one card for the pair');
    const fri = items().find(i => i.name === 'Friday');
    assert(fri?.rom === await hashOf(rom) && fri.sav, `Friday: its LSDj and songs: ${JSON.stringify(fri)}`);

    /* a .sav alone: which LSDj? Cancel: no card */
    let done = pick([[save('ACID', 5), 'Alone.sav']]);
    await until(() => dialog()?.open, 'asked which LSDj');
    assert(/Which LSDj goes with Alone\?/.test(dialog().textContent), `the question: ${dialog().textContent}`);
    press(dialog(), 'Cancel'); await done;
    assert(items().length === before + 1 && !items().some(i => i.name === 'Alone'), 'cancelled: no card');
    /* again, the LSDj chosen: a whole cartridge */
    done = pick([[save('ACID', 5), 'Alone.sav']]);
    await until(() => dialog()?.querySelector('input[type=radio]'), 'the LSDj listed');
    press(dialog(), 'Add to the crate'); await done;
    const alone = await until(() => items().find(i => i.name === 'Alone'), 'Alone added');
    assert(alone.rom === fri.rom && alone.sav, 'with the LSDj chosen');
    assert(!items().some(i => !i.rom), 'no card without an LSDj');

    /* a card downloads as NAME.gb + NAME.sav; Export cartridges: all of them */
    await until(() => card('Friday'), 'Friday drawn');
    press(card('Friday'), '⇩');
    await until(() => clicks.includes('Friday.zip'), `Friday.zip: ${clicks}`);
    press(crate, 'Export cartridges');
    await until(() => clicks.includes('lsdj-cartridges.zip'), `the export: ${clicks}`);
    assert(/Exported \d+ cartridges/.test(crate.querySelector('.crate-status').textContent), `said: ${crate.querySelector('.crate-status').textContent}`);
    return 'PASS whole cartridges: an LSDj and .sav of one name make one card, a .sav alone asks for its LSDj (Cancel: none), a card downloads as .gb + .sav, Export cartridges';
  } finally {
    HTMLAnchorElement.prototype.click = realClick;
    dialog()?.remove();
  }
}
