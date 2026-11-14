// SPDX-License-Identifier: GPL-3.0-only
import {validateRom, identifyRom, listKits, planRom, romFromSlot, BANK, SLOT_MAX_BANKS} from './lsdj-rom.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {selectFirmware, installing, clearPreparedFirmware, setPreparingFirmware} from './install-ui.js';
import {kitButtons, emptySlotTools} from './kits-ui.js';
import {usageByBank, currentUsage, kitLabel} from './songs-ui.js';
import {kitSlots, putKit} from './lsdj-kit.js';
import {romFit} from './lsdj-usage.js';

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { $('rom-info').textContent = text; $('rom-info').className = cls; };
let rom = null, template = null, metadata = null, versions = [], generation = 0, busy = false;
let loading = false, currentPlan = null;
let downloadUrl = null;
let reading = null, fromDevice = false;
let romName = '', romInfo = null, romChanged = false, romUrl = null;
const selected = () => [...$('rom-kits').querySelectorAll('input:checked')].map(el => Number(el.value));

function clearDownload() {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    say('ROM options changed. Prepare the firmware again.', 'warn');
  }
  downloadUrl = null;
  $('rom-actions').hidden = true;
  $('rom-download').hidden = true;
  $('rom-download').removeAttribute('href');
  $('rom-download').removeAttribute('download');
}
function updatePlan() {
  clearDownload();
  clearPreparedFirmware();
  currentPlan = null;
  if (!rom || !metadata) return updateControls();
  try {
    const p = planRom(rom, selected(), metadata.cartridge_capacity);
    currentPlan = p;
    /* FM-1_991: a kit takes only the part of its bank it uses, so what to free is said in KiB */
    const excess = Math.max(0, Math.ceil((p.needed - p.capacity) / 1024));
    const cannotFit = !p.fits && !planRom(rom, [], metadata.cartridge_capacity).fits;
    $('rom-budget').textContent = `Uses ${Math.ceil(p.needed / 1024)} of ${Math.floor(p.capacity / 1024)} KiB ` +
      `(${p.codeBanks} program banks + ${p.kept} kit banks). ` +
      (p.omitted.length ? `Omitted banks: ${p.omitted.map(k => k.bank.toString(16).toUpperCase().padStart(2, '0')).join(', ')}: songs using these kits lose those samples. ` +
        (fromDevice ? 'Unticked kits are removed from the FM-1; only your original ROM file can bring them back. ' : '') : '') +
      (p.fits ? 'Fits.' :
        cannotFit ? 'The required program/data alone exceeds this template. Removing kits cannot make this ROM fit. Choose a smaller compatible ROM.' :
        `Deselect kits to free at least ${excess} KiB. No kits are removed automatically.`);
    $('rom-budget').className = p.fits ? 'hint' : 'warn';
  } catch (err) { say(err.message, 'bad'); }
  updateControls();
}
$('rom-experimental').onchange = updatePlan;
/* Install's ROM, for Songs and kits (songs-ui.js) */
export const installRom = () => rom ? {rom, name: romName} : null;
const announceRom = () => document.dispatchEvent(new CustomEvent('install-rom', {detail: installRom()}));
/* LSDj 9.2.0 and later rotate kit sample frames (lsdj-kit.js buildKit) */
const rotates = () => { const v = /^(\d+)\.(\d+)\.?(\w)?/.exec(romInfo?.version || ''); return !v || +v[1] > 9 || (+v[1] === 9 && +v[2] >= 2); };
const kitCtx = {rom: () => rom, rotate: rotates, say: (t, c) => say(t, c), replace: (next, message) => replaceRom(next, message)};
/* a kit tool changed the ROM: a new copy (the user's file is untouched), the list drawn again, ticks kept */
function replaceRom(next, message) {
  const ticked = new Set(selected()), had = new Set(listKits(rom).map(k => k.bank));
  rom = next; romChanged = true;
  renderKits(b => ticked.has(b) || !had.has(b));
  updatePlan(); announceRom();
  say(message + ' Changed in this page only: your ROM file is untouched. Download it below to keep it.', 'ok');
}
function renderKits(ticked = () => true) {
  const legend = document.createElement('legend');
  legend.textContent = 'Sample kits';
  $('rom-kits').replaceChildren(legend);
  const kits = listKits(rom), usage = usageByBank(rom, currentUsage());
  for (const kit of kits) {
    const label = document.createElement('label'), input = document.createElement('input'), line = document.createElement('div');
    input.type = 'checkbox'; input.value = String(kit.bank); input.checked = ticked(kit.bank);
    label.append(input, ` Bank ${kit.bank.toString(16).toUpperCase().padStart(2, '0')}: ${kit.name || '(unnamed kit)'}`);
    const u = usage.get(kit.bank), note = document.createElement('span');
    note.className = 'hint kit-use';
    if (u) note.textContent = u.used.length ? ` · played in ${u.used.join(', ')}` + (u.maybe.length ? `, maybe ${u.maybe.join(', ')}` : '') :
      u.maybe.length ? ` · maybe played in ${u.maybe.join(', ')}` : ' · not played by your songs';
    line.className = 'kit-line'; line.append(label, note, kitButtons(kit.bank, kitCtx));
    $('rom-kits').append(line);
  }
  if (!kits.length) {
    const note = document.createElement('p');
    note.textContent = 'No sample-kit banks were recognized. All required program/data banks are preserved.';
    $('rom-kits').append(note);
  }
  $('rom-kits').append(emptySlotTools(kitCtx));
  /* the songs open in Songs and kits play kits this LSDj doesn't have: say so before it's installed */
  const now = currentUsage(), slots = kitSlots(rom), fit = now && romFit(slots, now);
  if (fit && !fit.ok) {
    const w = document.createElement('p'), ks = [...new Set(fit.kits.map(m => m.kit))];
    w.className = 'warn';
    w.textContent = `Your songs (open in Songs and kits) play kits this LSDj doesn't have: ` +
      ks.map(k => `kit ${k.toString(16).toUpperCase().padStart(2, '0')}, ${kitLabel(slots, k)} (${[...new Set(fit.kits.filter(m => m.kit === k).flatMap(m => m.songs))].join(', ')})`).join('; ') +
      '. Those parts play nothing with it. Choose the LSDj they were made with, or put the right kit in that slot.';
    $('rom-kits').append(w);
  }
  if (usage.size) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Tick only the kits my songs play';
    b.title = 'From the songs open in Songs and kits ("maybe" ones stay ticked)';
    b.onclick = () => { for (const i of $('rom-kits').querySelectorAll('input[type=checkbox]')) { const x = usage.get(Number(i.value)); i.checked = !!(x && (x.used.length || x.maybe.length)); } updatePlan(); };
    $('rom-kits').append(b);
  }
  if (romChanged) {
    if (romUrl) URL.revokeObjectURL(romUrl);
    romUrl = URL.createObjectURL(new Blob([rom], {type: 'application/octet-stream'}));
    const a = document.createElement('a');
    a.href = romUrl; a.download = romName.replace(/(\.gbc?)?$/i, '-kits.gb'); a.className = 'button-link';
    a.textContent = 'Download my changed LSDj (.gb)';
    $('rom-kits').append(' ', a);
  }
}
/* Songs and kits opened other songs: say again which kits they play (ticks kept) */
document.addEventListener('songs-usage', () => { if (rom && !loading) { const t = new Set(selected()); renderKits(b => t.has(b)); } });
$('rom-kits').onchange = updatePlan;
function updateControls() {
  const blocked = busy || installing() || !!reading;
  $('rom').disabled = blocked;
  $('rom-device').disabled = blocked;
  $('rom-cancel').hidden = !reading;
  $('rom-experimental').disabled = blocked || loading || !currentPlan;
  $('rom-kits').disabled = blocked || loading || !currentPlan;
  $('rom-build').disabled = blocked || loading || !currentPlan?.fits || !$('rom-experimental').checked;
  $('rom-step').setAttribute('aria-busy', String(loading || busy));
  $('rom-next').textContent = installing() ? 'Wait for the current installation to finish.' :
    reading ? 'Reading LSDj from the FM-1. Nothing is written to it; you can cancel safely.' :
    busy ? 'Preparing and checking the firmware…' :
    loading ? 'Checking your ROM…' :
    !rom ? 'Step 1: choose your LSDj .gb file, or read it from your FM-1.' :
    !currentPlan ? 'Step 1: fix the problem below, then choose the file again.' :
    !currentPlan.fits ? 'Step 2: untick kits until everything fits.' :
    downloadUrl ? 'Step 4: install it, download it, or try it in the virtual FM-1 first.' :
    !$('rom-experimental').checked ? 'Step 3: back up your songs, then tick the box to prepare.' :
    'Step 3: ready to prepare. Nothing is installed yet.';
  // lsdj/ui.js moves through the install steps from this
  document.dispatchEvent(new CustomEvent('rom-state', {detail: {ready: !!currentPlan, fits: !!currentPlan?.fits,
    prepared: !!downloadUrl, working: busy || loading || !!reading}}));
}
document.addEventListener('firmware-install-state', updateControls);
async function chooseRom(file, device = false) {
  const seq = ++generation;
  fromDevice = device;
  rom = template = metadata = null; romChanged = false; romInfo = null;
  loading = !!file;
  const legend = document.createElement('legend');
  legend.textContent = 'Sample kits (all selected initially)';
  $('rom-kits').replaceChildren(legend); $('rom-budget').textContent = '';
  $('rom-experimental').checked = false;
  updatePlan();
  if (!file) return say('');
  try {
    if (file.size > BANK * SLOT_MAX_BANKS) throw Error('ROM is larger than the supported 2 MiB limit.');
    say(device ? 'Reading installed LSDj from the FM-1. No writes or uploads...' : 'Checking ROM and loading the ROM-free template...');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== generation) return;
    if (device && reading.signal.aborted) throw Error('Cartridge read cancelled.');
    validateRom(bytes);
    const response = await fetch('lsdj/versions.json', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`Version catalogue unavailable (${response.status}).`);
    const catalog = await response.json();
    if (!Array.isArray(catalog) || catalog.some(v => !v || typeof v !== 'object'))
      throw Error('Invalid version catalogue. Reload the page or choose the file again to retry.');
    const info = await identifyRom(bytes, catalog);
    if (seq !== generation) return;
    const loaded = await loadTemplate();
    if (seq !== generation) return;
    if (device && reading.signal.aborted) throw Error('Cartridge read cancelled.');
    const kits = listKits(bytes);
    planRom(bytes, kits.map(k => k.bank), loaded.metadata.cartridge_capacity);
    rom = bytes; versions = catalog; ({template, metadata} = loaded); romName = file.name; romInfo = info;
    say(`${file.name} (${info.title}): ${info.tested ? 'a tested LSDj build' :
      info.sameProgram ? 'a tested LSDj program with different samples' : 'an untested LSDj build'}. ` +
      (info.cursorProfile === 1 ? 'LSDj 9.3.9 program (custom palettes and kits are fine): effects follow the cursor; SEQ, tempo, cues and MIDI sync work. ' :
        info.cursorProfile === 2 ? `Known ${info.title} program: effects follow the cursor and the LFO follows the tempo; SEQ live mode, tempo editing, cues and MIDI sync need LSDj 9.3.9. ` :
        'Cursor-following FX unavailable for this program: FX targets ALL channels. ') +
      (device ? 'All installed kits are ticked; untick any you can do without. ' : '') +
      (!info.globalChecksumValid ? 'Its checksum is out of date; the firmware gets a corrected one. ' : ''),
      info.cursorProfile ? 'ok' : 'warn');
    renderKits();
    updatePlan(); announceRom();
  } catch (err) {
    if (seq === generation) {
      rom = template = metadata = currentPlan = null;
      $('rom').value = '';
      say(err.name === 'TimeoutError' ? 'ROM checking timed out. Choose the same file again to retry.' :
        `${err.message}${device ? ' Read again or choose your original ROM to retry.' : ' Choose the file again to retry.'}`, 'bad');
    }
  } finally {
    if (seq === generation) { loading = false; updateControls(); }
  }
}
$('rom').onchange = e => {
  if (busy || installing() || reading) return;
  return chooseRom(e.target.files[0]);
};
/* Songs & kits › a song set (sets-ui.js): its LSDj, as if chosen here (all its kits ticked) */
document.addEventListener('install-this-rom', e => {
  if (busy || installing() || reading) return;
  $('rom').value = '';
  location.hash = '#install';
  chooseRom(new File([e.detail.rom], e.detail.name));
});
/* Songs & kits › Your LSDj files and kits › Load (sets-ui.js): a saved .kit into the first empty kit slot of the
   LSDj chosen here (a new copy, as Add a .kit does) */
document.addEventListener('install-this-kit', e => {
  location.hash = '#install';
  if (busy || installing() || reading) return say('Busy: try again when the LSDj has finished loading.', 'bad');
  if (!rom) return say(`Choose your LSDj here first, then Load ${e.detail.name} again.`, 'bad');
  const slot = kitSlots(rom).find(s => s.empty);
  if (!slot) return say(`No empty kit slot for ${e.detail.name}: clear or replace a kit below.`, 'bad');
  try { replaceRom(putKit(rom, slot.bank, e.detail.bytes), `Added ${e.detail.name} in bank ${slot.bank.toString(16).toUpperCase().padStart(2, '0')}.`); }
  catch (err) { say(err.message, 'bad'); }
});
$('rom-cancel').onclick = () => reading?.abort();
$('rom-device').onclick = async () => {
  if (busy || installing() || reading) return;
  reading = new AbortController();
  const signal = reading.signal, progress = $('rom-read-progress');
  progress.hidden = false; progress.max = 1; progress.value = 0;
  $('rom').value = '';
  setPreparingFirmware(true);
  try {
    await chooseRom({name: 'Installed LSDj', size: 0, arrayBuffer: async () => {
      const {readInstalledCartridge} = await import('./app.js');
      const slot = await readInstalledCartridge((n, total) => {
        progress.max = total; progress.value = n;
        say(`Reading installed LSDj: ${n.toLocaleString()} / ${total.toLocaleString()} bytes. No device writes.`);
      }, signal);
      if (signal.aborted) throw Error('Cartridge read cancelled.');
      return romFromSlot(slot).buffer;
    }}, true);
  } finally {
    reading = null; progress.hidden = true;
    setPreparingFirmware(false); updateControls();
  }
};
updateControls();
$('rom-build').onclick = async () => {
  if (!rom || !template || busy || loading || reading || installing()) return;
  const seq = generation, keep = selected();
  busy = true; updatePlan();
  setPreparingFirmware(true); updateControls();
  try {
    const result = await prepareLsdjFirmware(rom, keep, template, metadata,
      {versions, experimental: $('rom-experimental').checked});
    if (seq !== generation) return;
    const name = `lsdj-burrito-${metadata?.release || result.product}-experimental.fwsc`;
    selectFirmware(result.bytes, name, true, result.slot);
    downloadUrl = URL.createObjectURL(new Blob([result.bytes], {type: 'application/octet-stream'}));
    $('rom-download').href = downloadUrl; $('rom-download').download = name; $('rom-download').hidden = false;
    $('rom-actions').hidden = false;
    say(`Prepared ${result.product}${metadata?.version ? ` (LSDJ Burrito ${metadata.release || metadata.version})` : ''}; checks passed. ` +
      (result.info.cursorProfile ? '' : 'Cursor-following FX unavailable: FX targets ALL channels. ') +
      `The file contains your LSDj: keep it private. SHA-256 ${result.sha256}`, 'ok');
  } catch (err) { say(err.message, 'bad'); }
  finally {
    busy = false;
    setPreparingFirmware(false); updateControls();
  }
};
