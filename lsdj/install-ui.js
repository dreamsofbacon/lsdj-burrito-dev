// SPDX-License-Identifier: GPL-3.0-only
// The page's Install section (lsdj/install.js does the work). Safeguards:
// the file is checked whole before anything is sent; the install only starts
// with this tab in front, keeps the screen awake, warns if the tab is hidden
// or closed meanwhile. Recovery after an interrupted write is not guaranteed.
import {checkPackage, install, installOn, InstallError, REPLUG} from './install.js';
import {chooseFm1} from './choose-fm1.js';

const $ = (id) => document.getElementById(id);
const say = (text, cls = 'hint') => { const el = $('fw-status'); el.textContent = text; el.className = cls; };
const log = (text) => { const el = $('fw-log'); el.textContent += `${new Date().toLocaleTimeString()}  ${text}\n`; };
let pkg = null, fileName = '', busy = false, wake = null;
let selection = 0, generated = false, preparing = false;
let firmwareBytes = null;
let swapSlot = null, swapBuild = null;   /* a prepared firmware's LSDj slot and build ID: the fast swap when the FM-1 runs this very build */
export const getFirmwareSelection = () => pkg && !preparing ? {name: fileName, product: pkg.product} : null;
export function usbMidiUnavailable() {
  if (!globalThis.isSecureContext) return 'USB MIDI requires HTTPS or localhost.';
  if (typeof navigator.requestMIDIAccess !== 'function')
    return 'This browser can\'t reach the FM-1: it has no Web MIDI (on iPhone and iPad, no browser does). Use Chrome on Android, or Chrome or Edge on a computer. Songs & kits, preparing a firmware file and the virtual FM-1 work here.';
  return '';
}
function updateControls() {
  const unavailable = usbMidiUnavailable();
  $('fw-file').disabled = busy || preparing;
  $('fw-install').disabled = busy || target !== null || preparing || !pkg || !!unavailable;
  $('fw-support').textContent = unavailable ? `${unavailable} You can still prepare and download firmware for M-UPGRADE.` :
    'Installing asks for MIDI access and needs the FM-1 plugged in by USB.';
  $('fw-support').className = unavailable ? 'warn' : 'hint';
  document.dispatchEvent(new Event('firmware-selection-state'));
}
export function getSelectedFirmware() {
  if (!firmwareBytes || preparing) throw new InstallError('Prepare firmware or select a .fwsc file in the installer first.');
  return {bytes: firmwareBytes.slice(), name: fileName};
}
/* the DJ crate's install on one FM-1 (crate-ui.js; its key, as app.js portKey): Install waits for it too */
let target = null;
export const installTarget = () => target;
export function setInstallTarget(key) {
  target = key ?? null;
  if (document.getElementById('fw-install')) updateControls();
  document.dispatchEvent(new Event('firmware-install-state'));
}
export const installing = () => busy || target !== null;
export let beforeInstall = async () => {};   // the page closes its own link to the FM-1 first (app.js sets it)
export function setBeforeInstall(f) { beforeInstall = f; }
/* the FM-1s plugged in (app.js): list() -> [{key, no, title, firmware, inUse}]; identify(key, no, s); use(key): the page
   connects to that one (Install's LSDj copy reads the FM-1 in use); ports(key) / otherPorts(key) as the DJ crate's */
let fm1Hooks = null;
export function setInstallFm1s(h) { fm1Hooks = h; }

function clearFirmware() {
  ++selection; pkg = null; generated = false; firmwareBytes = null; fileName = ''; swapSlot = null; swapBuild = null;
  $('fw-install').disabled = true; $('fw-info').textContent = '';
  $('fw-progress').hidden = true;
  updateControls();
}
export function clearPreparedFirmware() {
  if (!busy && generated) {
    clearFirmware();
    say('ROM options changed. Prepare the firmware again before installing.');
  }
}
export function setPreparingFirmware(value) {
  preparing = value;
  updateControls();
}
export function selectFirmware(bytes, name, fromRom = false, slot = null, build = null) {
  if (busy) throw new InstallError('An installation is already running.');
  const checked = checkPackage(bytes);
  clearFirmware();
  pkg = checked; fileName = name; generated = fromRom; firmwareBytes = bytes.slice(); swapSlot = slot?.slice() ?? null; swapBuild = build;
  $('fw-file').value = '';
  $('fw-info').textContent = `Firmware: ${name} (${pkg.product}), checks passed.`;
  $('fw-info').className = 'hint';
  updateControls();
  say('Ready to install. Nothing has been sent to the FM-1 yet.');
}
$('fw-file').onchange = async (e) => {
  if (busy || preparing) return;
  clearFirmware();
  const seq = selection, f = e.target.files[0];
  if (!f) return say('Choose a .fwsc file, or prepare firmware from your ROM above.');
  say(`Checking ${f.name}... Nothing has been sent to the FM-1.`);
  try {
    if (f.size > 2 * 1024 * 1024) throw new InstallError('Firmware file is too large.');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (seq !== selection) return;
    selectFirmware(bytes, f.name);
  } catch (err) {
    if (seq === selection) {
      $('fw-file').value = '';
      say(err.message, 'bad');
    }
  }
};

const onHidden = () => {
  if (!busy) return;
  if (document.hidden) { document.title = 'Installing - keep this tab open'; log('The tab went to the background (the install keeps going; bring it back to watch).'); }
  else document.title = "Dreamy_bacon's LSDJ Burrito";
};
document.addEventListener('visibilitychange', onHidden);
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

$('fw-install').onclick = async () => {
  if (!pkg || busy || target !== null || preparing) return;
  const unavailable = usbMidiUnavailable();
  if (unavailable) return say(unavailable + ' Nothing was installed.', 'warn');
  if (document.hidden) return say('Bring this tab to the front first.', 'warn');
  if (!pkg.burrito && !confirm(`${fileName} is ${pkg.product}, not an LSDJ Burrito build. Install it anyway?`)) return;
  /* more than one FM-1 plugged in: which one, each showing its number on its screen (Colin: Install took whichever
     answered first). The page then uses that one, so the LSDj copy below is read from it; nothing goes to the others. */
  let chosen = null, which = 'the FM-1';
  const fm1s = fm1Hooks ? await fm1Hooks.list().catch(() => []) : [];
  if (fm1s.length > 1) {
    chosen = await chooseFm1({fm1s, identify: fm1Hooks.identify, product: pkg.product});
    if (!chosen) return say('Nothing was installed.');
    const f = fm1s.find(x => x.key === chosen);
    which = `FM-1 ${f.no}`;
    log(`Installing on ${which} (${f.title || 'no LSDj'}, ${f.firmware}): chosen of ${fm1s.length}.`);
    if (!f.inUse) {
      say(`Connecting to ${which}…`);
      try { await fm1Hooks.use(chosen); } catch (e) { return say(`${which}: ${e.message} Nothing was installed.`, 'bad'); }
    }
  }
  /* the LSDj the FM-1 has now: kept in Cartridges first if it isn't (its kits may exist nowhere else) */
  if (!(await (await import('./carts-ui.js')).keepBeforeInstall(log))) return say('Nothing was installed: the copy of the FM-1\'s LSDj could not be read. Try again, or install without a copy.', 'bad');
  if (!confirm(`Install ${pkg.product} on ${which}?\n\nBack up songs first. Keep stable power, the USB cable in and this tab open until it says done. An interrupted write can leave the device unable to boot; recovery is not guaranteed. Proceed?`)) return;
  busy = true; updateControls();
  document.dispatchEvent(new Event('firmware-install-state'));
  const bar = $('fw-progress'); bar.hidden = false; bar.value = 0; bar.max = 1;
  try { wake = await navigator.wakeLock?.request('screen'); } catch (_) { wake = null; }
  try {
    await beforeInstall();
    let access;
    try { access = await navigator.requestMIDIAccess({sysex: true}); }
    catch (_) { throw new InstallError('MIDI access was blocked. Allow it (with SysEx) for this page, then press Install again. Nothing was installed.'); }
    const names = {found: 'Found the FM-1', stage: 'Preparing the update (nothing is changed yet)', loader: 'The FM-1 is restarting into update mode',
                   write: 'Writing the firmware: keep the cable in', restart: 'Written. The FM-1 is restarting', done: 'Done',
                   replug: REPLUG.update, 'replug-back': REPLUG.back,
                   swap: 'The FM-1 already runs this firmware: changing only its LSDj (songs saved first). Keep the cable in'};
    let swapped = false;
    const options = {
      log, slot: swapSlot, build: swapBuild,
      onStep: (s, d) => {
        if (s === 'swap') swapped = true;
        log(names[s] + (d ? `: ${d}` : ''));
        if (s !== 'done') say(names[s] + (s.startsWith('replug') ? '' : '…'), s === 'write' || s === 'swap' || s.startsWith('replug') ? 'warn' : 'hint');
      },
      onProgress: (b, t) => { bar.max = t; bar.value = b; }
    };
    /* the one chosen: the DJ crate's install (install.js installOn), every other FM-1's ports kept out */
    const target = chosen && fm1Hooks.ports(chosen);
    if (chosen && !target) throw new InstallError(`${which} went away. Nothing was installed.`);
    const id = chosen ? (await installOn(access, pkg, {...options, target, avoid: fm1Hooks.otherPorts(chosen)})).id
      : await install(access, pkg, options);
    bar.value = bar.max;
    say(swapped ? `Done: LSDj changed, ${which} runs ${id}.` : `Installed: ${which} now runs ${id}.`, 'ok');
    document.dispatchEvent(new CustomEvent('firmware-installed', {detail: {id}}));   /* songs-ui.js: a set's songs follow */
  } catch (err) {
    log('Stopped: ' + err.message);
    say(err.message, err.resumable ? 'warn' : 'bad');
  } finally {
    busy = false; updateControls();
    document.dispatchEvent(new Event('firmware-install-state'));
    document.title = "Dreamy_bacon's LSDJ Burrito";
    try { await wake?.release(); } catch (_) {}
    wake = null;
  }
};
updateControls();
