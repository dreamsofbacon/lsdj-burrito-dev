// SPDX-License-Identifier: GPL-3.0-only
// Presets in the page (0.9.98-dev.6), against a fake FM-1 that has them (a local preview, never a device):
// Perform › Master's row (the current one lit; a click loads, and the settings it brings are read again; a slot
// loaded on the FM-1 itself shows), Manage… (keep the current state with a name, rename, clear, a refusal, export
// all and import that file back), Settings › Preset glide.
import {OP, le32} from '../lsdj/link.js';
import {toSlot, fromSlot, readPresetFile} from '../lsdj/presets.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 4000) {
  for (const t = Date.now(); Date.now() - t < ms;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
const fxWords = () => { const b = new Uint8Array(76); b[36] = 5; b[37] = 2; b[42] = 0xf2; b[30] = 40; b[68] = 20;
  return Array.from({length: 19}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0); };
const preset = name => ({name, fx: fxWords(), settings: 0x5A000000, midi: 0x4D000000, feat: 0x460001CE, theme: Array(8).fill(0)});

export async function runPresetsUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const realConfirm = window.confirm, realClick = HTMLAnchorElement.prototype.click, downloads = [];
  const input = {name: 'FM-1 test'}, fx = Array(68).fill(0); fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[38] = 1;
  const slots = Array.from({length: 8}, (_, i) => toSlot(i === 0 ? preset('DUB') : i === 2 ? preset('LOFI') : null));
  const dev = {cur: 0, loads: [], puts: [], saves: [], settingsReads: 0};
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; [...'FM-1_998'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); info[34] = 1 | 8; return send(info); }   /* (no tagged requests here) */
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.SETTINGS_GET) { dev.settingsReads++; return send(le32(0x5a000000)); }
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.MIDI_GET) return send(le32(0x4D000000));
    if (op === OP.FEAT_GET) return send(le32(0x460001CE));
    if (op === OP.REVERB_GET) return send(le32(0x00404000));
    if (op === OP.REVERB_SENDS_GET) return send(le32(0));
    if (op === OP.LIVE) return send([1, 0, 120, 0, 0, 0, 0, ...fx, 0x82, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 127]);
    if (op === OP.PRESET_LIST) return send([dev.cur ?? 0xff, ...slots.flatMap(s => s[0] === 0x50 ? [1, ...s.slice(2, 14)] : Array(13).fill(0))]);
    if (op === OP.PRESET_GET) return send([...slots[args[0]]]);
    if (op === OP.PRESET_PUT) { const b = Uint8Array.from(args.slice(1)); dev.puts.push([args[0], b]);
      if (b[0] === 0x50 && fromSlot(b).name === 'BAD') return send([], 1);   /* (a value the firmware refuses) */
      slots[args[0]] = b; return send(); }
    if (op === OP.PRESET_LOAD) { if (slots[args[0]][0] !== 0x50) return send([], 2); dev.loads.push(args[0]); dev.cur = args[0]; return send(); }
    if (op === OP.PRESET_SAVE) { const name = args.length > 1 ? String.fromCharCode(...args.slice(1)).trim() : null; dev.saves.push([args[0], name]);
      slots[args[0]] = toSlot(preset(name || fromSlot(slots[args[0]])?.name || `PRESET ${args[0] + 1}`)); dev.cur = args[0]; return send(); }
    if ([OP.STORE, OP.THEME_SET, OP.SETTINGS_SET, OP.FX_SET, OP.MUTE_SET, OP.FEAT_SET].includes(op)) return send();
    return send([], 1);   /* (the screen and the rest: not here) */
  }};
  const row = () => [...$('preset-slots').children];
  const status = () => $('preset-dlg-status').textContent;
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    window.confirm = () => true;
    HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({name: this.download, url: this.href}); else realClick.call(this); };
    await $('connect-btn').onclick();
    assert($('device').textContent.includes('Connected'), $('device').textContent);

    // 1. the row: 8 slots, DUB lit, empty ones dimmed
    await until(() => !$('preset-row').hidden && row().length === 8 && row()[0].classList.contains('on'), `the presets row: ${$('preset-slots').innerHTML}`);
    assert(/DUB/.test(row()[0].textContent) && row()[1].classList.contains('empty') && /LOFI/.test(row()[2].textContent), 'names and empty slots');
    assert(/EDIT, press E4/.test(row()[2].title), `the FM-1's key in the title: ${row()[2].title}`);

    // 2. a click loads it; what it brings is read again
    const reads0 = dev.settingsReads;
    row()[2].click();
    await until(() => dev.loads.at(-1) === 2 && row()[2].classList.contains('on') && !row()[0].classList.contains('on'), `slot 3 loaded: ${dev.loads}`);
    assert(dev.settingsReads > reads0 && /Loaded LOFI/.test($('preset-note').textContent), `settings read again, said so: ${$('preset-note').textContent}`);
    row()[1].click(); await sleep(100);
    assert(dev.loads.length === 1 && /empty/.test($('preset-note').textContent), 'an empty slot: nothing sent');

    // 3. EDIT + C4 on the FM-1: the row follows (the live poll reads the list every 2 s), settings read again
    const reads1 = dev.settingsReads; dev.cur = 0;
    await until(() => row()[0].classList.contains('on'), 'the slot loaded on the FM-1 lit', 5000);
    await until(() => dev.settingsReads > reads1, 'and what it brought read again', 3000);

    // 4. Manage…: 8 rows; keep the current state in slot 2 as NEW; rename DUB; a refusal; clear LAST
    $('preset-manage').click();
    const rows = () => [...$('preset-table').children];
    await until(() => $('preset-dlg').open && rows().length === 8 && rows()[0].querySelector('input').value === 'DUB' && !rows()[0].querySelector('input').disabled,
      'Manage: the slots read');
    assert(/echo, reverb/.test(rows()[0].children[2].textContent), `the summary: ${rows()[0].children[2].textContent}`);
    const acts = r => Object.fromEntries([...rows()[r].querySelectorAll('button')].map(b => [b.textContent, b]));
    rows()[1].querySelector('input').value = 'new';
    acts(1)['Keep current here'].click();
    await until(() => dev.saves.length && rows()[1].querySelector('input').value === 'NEW', `kept as NEW: ${JSON.stringify(dev.saves)}`);
    assert(dev.saves[0][0] === 1 && dev.saves[0][1] === 'NEW' && /Kept/.test(status()), `PRESET_SAVE slot 2 NEW: ${status()}`);
    const name0 = rows()[0].querySelector('input'); name0.value = 'dub two'; name0.onchange();
    await until(() => slots[0][0] === 0x50 && fromSlot(slots[0]).name === 'DUB TWO', 'renamed (PRESET_PUT)');
    assert(dev.puts.at(-1)[0] === 0 && fromSlot(dev.puts.at(-1)[1]).fx.join() === fxWords().join(), 'the rest of it unchanged');
    const name2 = rows()[2].querySelector('input'); name2.value = 'bad'; name2.onchange();
    await until(() => /refused/.test(status()), `a refusal said: ${status()}`);
    assert(fromSlot(slots[2]).name === 'LOFI', 'refused: the slot as it was');
    slots[7] = toSlot(preset('LAST')); $('preset-dlg').close(); $('preset-manage').click();
    await until(() => rows()[7].querySelector('input').value === 'LAST' && !acts(7).Clear.disabled, 'LAST shown');
    acts(7).Clear.click();
    await until(() => slots[7].every(b => b === 0) && rows()[7].querySelector('input').placeholder === 'empty', 'cleared (zeros)');

    // 5. Export all, then that file imported back (every slot replaced)
    $('preset-export-all').click();
    await until(() => downloads.some(d => /^lsdj-burrito-presets-.*\.json$/.test(d.name)), `exported: ${JSON.stringify(downloads)}`);
    const text = await (await fetch(downloads.at(-1).url)).text(), bank = readPresetFile(text);
    assert(bank.kind === 'bank' && bank.presets.map(p => p?.name ?? null).join() === 'DUB TWO,NEW,LOFI,,,,,', `the bank: ${bank.presets.map(p => p?.name)}`);
    const puts0 = dev.puts.length;
    slots[1] = toSlot(null);
    $('preset-import').onchange({target: {files: [new File([text], 'bank.json')], value: ''}});
    await until(() => dev.puts.length === puts0 + 8 && fromSlot(slots[1])?.name === 'NEW', `imported all 8: ${dev.puts.length - puts0}`);
    $('preset-dlg').close();

    // 6. Settings › FX and lights: Preset glide (this firmware has presets)
    assert($('feat-form').querySelector('select[data-key="presetGlide"]'), 'Preset glide in Settings');
    return 'PASS presets UI: row (lit, load, empty, follows the FM-1), Manage (keep with a name, rename, refusal, clear), export all and import back, Preset glide';
  } finally {
    window.confirm = realConfirm; HTMLAnchorElement.prototype.click = realClick;
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess;
  }
}
