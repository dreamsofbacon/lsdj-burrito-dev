// Run on a fresh local preview page; uses synthetic files and never installs firmware.
import {BANK, buildSlot} from '../lsdj/lsdj-rom.js';
import {OP, le32, rd32, CART_CHUNK} from '../lsdj/link.js';
import {getSelectedFirmware, selectFirmware, setPreparingFirmware, beforeInstall} from '../lsdj/install-ui.js';

const $ = id => document.getElementById(id);
const assert = (condition, message) => { if (!condition) throw Error(message); };
const text = (id, pattern) => assert(pattern.test($(id).textContent), `${id}: ${$(id).textContent}`);
function synthetic(required = 2, kits = [40, 41, 42]) {
  const rom = new Uint8Array(64 * BANK).fill(255);
  for (let bank = 0; bank < required; bank++) rom.fill(bank, bank * BANK, (bank + 1) * BANK);
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
async function choose(id, bytes, name) {
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], name));
  $(id).files = transfer.files;
  await $(id).onchange({target: $(id)});
}
function noFirmware() {
  let rejected = false;
  try { getSelectedFirmware(); } catch { rejected = true; }
  assert(rejected && $('fw-install').disabled && $('emu-selected').disabled,
    'Stale firmware must not remain installable or available for preview');
}

export async function runLoaderUiTests() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Run only on a local preview');
  const fetchOriginal = globalThis.fetch;
  const metadata = await (await fetchOriginal('lsdj/template.json')).json();
  const template = new Uint8Array(await (await fetchOriginal('lsdj/fm1-lsdj-template.fwsc')).arrayBuffer());
  let requests = 0, mode = '', releaseOld, startedOld;
  const oldStarted = new Promise(resolve => { startedOld = resolve; });
  globalThis.fetch = async (path, options) => {
    if (!String(path).startsWith('lsdj/')) return fetchOriginal(path, options);
    requests++;
    if (mode === 'offline') return new Response('', {status: 503});
    if (mode === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    if (String(path).endsWith('versions.json')) return Response.json(mode === 'bad-catalogue' ? {} : []);
    if (String(path).endsWith('template.json')) {
      if (mode === 'hold-template') {
        mode = '';
        await new Promise(resolve => { releaseOld = resolve; startedOld(); });
      }
      return Response.json(mode === 'bad-capacity' ? {...metadata, cartridge_capacity: 7} : metadata);
    }
    const bytes = template.slice();
    if (mode === 'bad-template') bytes[1000] ^= 1;
    return new Response(bytes);
  };
  const errors = [];
  const onError = event => errors.push(event.message);
  window.addEventListener('error', onError);
  try {
    assert($('rom-build').disabled && $('rom-experimental').disabled, 'Initial preparation controls disabled');
    assert($('rom-actions').hidden && $('emu-selected').disabled, 'Package actions unavailable before selection');
    for (const link of document.querySelectorAll('.page-nav a')) {
      assert($(link.hash.slice(1)), `Navigation target exists: ${link.hash}`);
    }
    await choose('fw-file', new Uint8Array(20), 'invalid.fwsc');
    text('fw-status', /not a valid FM-1 firmware/);
    assert($('fw-file').value === '', 'Invalid firmware can be selected again');
    noFirmware();
    await choose('fw-file', template, 'valid.fwsc');
    assert(getSelectedFirmware().name === 'valid.fwsc', 'Valid retry selects firmware');
    assert(!$('emu-selected').disabled, 'Valid installer package is available for preview');
    text('emu-selection', /valid\.fwsc/);
    await choose('fw-file', new Uint8Array(20), 'invalid.fwsc');
    text('fw-status', /not a valid FM-1 firmware/);
    noFirmware();

    let finishRead;
    const oldRead = $('fw-file').onchange({target: {files: [{
      name: 'old.fwsc', size: 20,
      arrayBuffer: () => new Promise(resolve => { finishRead = resolve; })
    }]}});
    await choose('fw-file', template, 'new.fwsc');
    finishRead(new ArrayBuffer(20));
    await oldRead;
    assert(getSelectedFirmware().name === 'new.fwsc', 'Late file read cannot replace the newer selection');
    text('fw-status', /Ready/);

    requests = 0;
    await choose('rom', new Uint8Array(20), 'invalid.gb');
    text('rom-info', /not an LSDj ROM/);
    assert(requests === 0, 'Invalid ROM is rejected before network requests');
    assert(getSelectedFirmware().name === 'new.fwsc', 'ROM errors preserve independently selected firmware');

    const rom = synthetic();
    for (const [failure, error] of [['offline', /503/], ['timeout', /timed out/], ['bad-catalogue', /Invalid version catalogue/],
      ['bad-capacity', /Invalid firmware slot capacity/]]) {
      mode = failure;
      await choose('rom', rom, 'retry.gb');
      text('rom-info', error);
      assert($('rom').value === '' && $('rom-build').disabled, `${failure}: retry enabled, preparation blocked`);
      document.dispatchEvent(new Event('firmware-install-state'));
      assert(errors.length === 0, 'Invalid metadata must not throw during control updates');
      mode = '';
      await choose('rom', rom, 'retry.gb');
      text('rom-next', /Step 3/);
    }

    mode = 'bad-template';
    await choose('rom', rom, 'damaged-template.gb');
    $('rom-experimental').checked = true;
    $('rom-experimental').onchange();
    await $('rom-build').onclick();
    text('rom-info', /template integrity check failed/);
    assert($('rom-download').hidden && !$('rom').disabled && !$('fw-file').disabled,
      'Failed preparation has no download and unlocks retry controls');
    assert(getSelectedFirmware().name === 'new.fwsc', 'Failed preparation preserves an independent package');

    mode = 'hold-template';
    const oldRom = choose('rom', rom, 'old.gb');
    await oldStarted;
    await choose('rom', synthetic(2, []), 'new.gb');
    releaseOld();
    await oldRom;
    text('rom-info', /new\.gb/);
    text('rom-kits', /No sample-kit banks/);
    assert(!$('rom-experimental').disabled, 'Late load cannot disable the newer ROM');

    await choose('rom', synthetic(32, [40]), 'too-large.gb');
    text('rom-budget', /Removing kits cannot make this ROM fit/);
    assert($('rom-build').disabled, 'Oversized required data cannot be prepared');
    await choose('rom', synthetic(27), 'kit-budget.gb');   /* 27 + 3 kits: 30 banks, over the slot (487424 from 0.9.98-dev.6); 27 + 2 fit */
    text('rom-budget', /Deselect kits to free at least \d+ KiB/);
    const kits = [...$('rom-kits').querySelectorAll('input')];
    assert(kits.length === 3 && kits.every(k => k.checked), 'All kits selected initially');
    kits[0].checked = false;
    $('rom-kits').onchange();
    text('rom-budget', /Omitted banks: 28/);
    text('rom-next', /Step 3/);
    assert($('rom-build').disabled, 'Consent still required when ROM fits');
    $('rom-experimental').checked = true;
    $('rom-experimental').onchange();
    assert(!$('rom-build').disabled, 'Fitting ROM plus consent enables preparation');
    const preparing = $('rom-build').onclick();
    assert($('rom').disabled && $('fw-file').disabled, 'Preparation locks conflicting file inputs');
    assert($('emu-selected').disabled, 'Preparation blocks preview of the previous installer selection');
    await preparing;
    text('rom-info', /Prepared FM-1_537000998 \(LSDJ Burrito 0\.9\.98(-dev\.\d+)?\)/);   // (the template's release: any test build)
    text('rom-info', /Cursor-following FX unavailable: FX targets ALL channels/);
    text('rom-next', /Step 4/);
    assert(!$('rom-download').hidden && !$('fw-install').disabled, 'Prepared package available for download and explicit install');
    assert(!$('rom-actions').hidden && !$('emu-selected').disabled, 'Completed package exposes download/preview/install navigation');
    assert(getSelectedFirmware().name.includes('experimental'), 'Generated installer selection identified');
    const url = $('rom-download').href;
    assert((await fetchOriginal(url)).ok, 'Private download exists');
    $('rom-experimental').checked = false;
    $('rom-experimental').onchange();
    assert($('rom-download').hidden && !$('rom-download').hasAttribute('href'), 'Changed options remove stale download');
    assert($('rom-actions').hidden, 'Changed options hide completed-package actions');
    noFirmware();

    selectFirmware(template, 'independent.fwsc');
    kits[1].checked = false;
    $('rom-kits').onchange();
    assert(getSelectedFirmware().name === 'independent.fwsc', 'Kit changes preserve independently selected package');
    text('emu-selection', /independent\.fwsc/);
    setPreparingFirmware(true);
    assert($('emu-selected').disabled, 'Preparation state immediately updates preview availability');
    setPreparingFirmware(false);
    assert(!$('emu-selected').disabled, 'Ending preparation restores independent preview selection');
    assert(errors.length === 0, 'No uncaught UI errors');
    return 'PASS loader UI: invalid-file errors/retry, file races, local validation, network/catalogue/metadata failures, kit budget, consent, preparation and stale-selection invalidation';
  } finally {
    releaseOld?.();
    globalThis.fetch = fetchOriginal;
    window.removeEventListener('error', onError);
  }
}

export async function runUnsupportedMidiUiTests() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Run only on a local preview');
  assert(typeof navigator.requestMIDIAccess !== 'function', 'Use a browser/test context without Web MIDI');
  assert($('connect-btn').disabled && $('fw-install').disabled, 'Unsupported USB controls are disabled');
  text('device', /does not provide Web MIDI/);
  text('fw-support', /M-UPGRADE/);
  const template = new Uint8Array(await (await fetch('lsdj/fm1-lsdj-template.fwsc')).arrayBuffer());
  selectFirmware(template, 'preview-only.fwsc');
  assert($('fw-install').disabled && !$('emu-selected').disabled, 'No Web MIDI blocks install, not local preview');
  const confirmOriginal = globalThis.confirm;
  globalThis.confirm = () => { throw Error('Unsupported USB must be rejected before any install confirmation'); };
  try {
    await $('fw-install').onclick();
    text('fw-status', /Nothing was installed/);
    await $('connect-btn').onclick();
    text('device', /does not provide Web MIDI/);
    await choose('rom', synthetic(), 'download-only.gb');
    $('rom-experimental').checked = true;
    $('rom-experimental').onchange();
    await $('rom-build').onclick();
    text('rom-info', /Prepared FM-1_537000998 \(LSDJ Burrito 0\.9\.98(-dev\.\d+)?\)/);   // (the template's release: any test build)
    assert(!$('rom-download').hidden && $('fw-install').disabled && !$('emu-selected').disabled,
      'Unsupported USB still allows preparing, downloading and selecting local previews');
    return 'PASS unsupported Web MIDI: no device access/confirmation, USB disabled, local preparation/download/preview preserved';
  } finally {
    globalThis.confirm = confirmOriginal;
  }
}

export async function runDeviceUpdateUiTests() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Run only on a local preview');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const {slot} = await buildSlot(synthetic(2, [40, 41]), [40, 41], 256 + 4 * (8 + BANK));   /* four full banks, slot v2 */
  const input = {name: 'FM-1 test'}, ops = [], fx = Array(68).fill(0);
  fx[42] = 0xf2;
  let mode = 'old', held, started;
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    ops.push(op);
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]
    }));
    if (op === OP.INFO) {
      const data = Array(35).fill(0); data[0] = 1;
      [...'FM-1_974'].forEach((c, i) => data[i + 1] = c.charCodeAt(0));
      [...'LSDj-test'].forEach((c, i) => data[i + 9] = c.charCodeAt(0));
      return send(data);
    }
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.MIDI_GET) return send([], 1);
    if (op === OP.LIVE) return send([0, 0, 120, 0, 0, 0, 0, ...fx]);
    if (op === OP.CART_INFO) return mode === 'old' ? send([], 1) :
      send([...le32(slot.length), ...le32(rd32(slot, 252)), ...le32(rd32(slot, 16))]);
    if (op === OP.CART_READ) {
      const off = rd32(args, 0), data = [...slot.slice(off, off + CART_CHUNK)];
      if (mode === 'corrupt' && off === 240) data[20] ^= 1;
      if (mode === 'hold') { held = () => send([...le32(off), ...data]); started?.(); return; }
      return send([...le32(off), ...data]);
    }
    if (op === OP.SCREEN_INFO || op === OP.SCREEN_SYNC) return send([], 1);   // FM-1_974: no screen
    throw Error(`Unexpected write/device operation ${op}`);
  }};
  const originalFetch = globalThis.fetch;
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => ({inputs: new Map(), outputs: new Map()})});
    await $('rom-device').onclick();
    text('rom-info', /No FM-1 found over USB.*connect to the running FM-1 in My FM-1/);
    noFirmware();
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    await $('rom-device').onclick();   // not connected: Read from my FM-1 connects over USB by itself
    text('device', /Connected over USB/);
    text('rom-info', /Install FM-1_974 or newer once/);
    noFirmware();

    mode = 'hold';
    const ready = new Promise(resolve => { started = resolve; });
    const pending = $('rom-device').onclick();
    await ready;
    assert($('rom').disabled && $('fw-file').disabled && $('fw-install').disabled && $('connect-btn').disabled,
      'Reading locks competing file/install/connection actions');
    assert(!$('rom-cancel').hidden, 'Cancellation available');
    $('rom-cancel').onclick();
    await pending;
    text('rom-info', /cancelled/); noFirmware();
    held(); held = null;
    assert(!$('rom').disabled && !$('connect-btn').disabled, 'Controls restored after cancellation');

    mode = 'corrupt';
    await $('rom-device').onclick();
    text('rom-info', /checksum/); noFirmware();

    mode = 'ok';
    await $('rom-device').onclick();
    text('rom-info', /All installed kits are ticked/);
    assert(!$('rom-kits').disabled && $('rom-kits').querySelectorAll('input:checked').length === 2, 'Installed kits ticked and adjustable');
    assert(!$('rom-experimental').checked && $('rom-build').disabled, 'Read does not grant install/preparation consent');
    noFirmware();
    $('rom-experimental').checked = true; $('rom-experimental').onchange();
    await $('rom-build').onclick();
    text('rom-info', /Prepared FM-1_537000998 \(LSDJ Burrito 0\.9\.98(-dev\.\d+)?\)/);   // (the template's release: any test build)
    assert(!$('rom-download').hidden, 'Device-based package available for explicit download/install');

    globalThis.fetch = async (path, options) => {
      const response = await originalFetch(path, options);
      if (String(path).endsWith('template.json')) return Response.json({...await response.json(), cartridge_capacity: 256 + 3 * (8 + BANK)});   /* three full banks in a version 2 slot */
      return response;
    };
    await $('rom-device').onclick();
    text('rom-budget', /Deselect kits to free at least \d+ KiB/);
    assert(!$('rom-kits').disabled && $('rom-build').disabled, 'Smaller update waits for the user to untick a kit');
    assert($('rom-kits').querySelectorAll('input:checked').length === 2, 'No installed kit is unticked automatically');
    $('rom-kits').querySelector('input:checked').checked = false; $('rom-kits').onchange();
    text('rom-budget', /Fits\./); text('rom-budget', /only your original ROM file can bring them back/);
    $('rom-experimental').checked = true; $('rom-experimental').onchange();
    assert(!$('rom-build').disabled, 'Unticking a kit lets the smaller update be prepared');
    noFirmware();
    assert(ops.every(op => [OP.INFO, OP.FX_GET, OP.SETTINGS_GET, OP.MIDI_GET, OP.THEME_GET,
      OP.LIVE, OP.CART_INFO, OP.CART_READ, OP.SCREEN_INFO, OP.SCREEN_SYNC].includes(op)), 'Only read-only device requests');
    return 'PASS device update UI: connect/bootstrap guidance, cancellation, competing-action locks, corrupt transfer, adjustable kits, explicit preparation, untick to fit, no device writes';
  } finally {
    globalThis.fetch = originalFetch;
    await beforeInstall();
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
}
}
