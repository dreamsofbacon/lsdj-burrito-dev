// SPDX-License-Identifier: GPL-3.0-only
// Page layout only: which view, tab and install step shows. The other scripts do the work
// and report their state with events (device-state, rom-state, firmware-selection-state).
import {getFirmwareSelection} from './install-ui.js';

const $ = id => document.getElementById(id);
const TABS = ['live-sec', 'songs-sec', 'theme-sec', 'settings-sec'];
const VIEW_OF = {home: 'home', connect: 'device', install: 'install', 'rom-step': 'install', 'install-sec': 'install', 'emulator-sec': 'try',
  songtools: 'studio', 'songtools-sec': 'studio', carts: 'studio', 'carts-sec': 'studio', studio: 'studio', 'studio-sec': 'studio'};
/* the Studio's sections: which one an address shows (Build is the page's own address) */
const STUDIO_SEC = {studio: 'studio-sec', 'studio-sec': 'studio-sec', carts: 'carts-sec', 'carts-sec': 'carts-sec', songtools: 'songtools-sec', 'songtools-sec': 'songtools-sec'};
TABS.forEach(t => { VIEW_OF[t] = 'device'; });

let connected = false, tab = 'live-sec', step = 1, rom = {ready: false, fits: false, prepared: false};

/* ---------- views and tabs (from the address #hash, so Back works) ---------- */
function route() {
  const id = location.hash.slice(1) || 'home';
  const view = VIEW_OF[id] || 'home';
  if (TABS.includes(id)) tab = id;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.page-nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  if (view === 'studio') {
    const sec = STUDIO_SEC[id] || 'studio-sec';
    document.querySelectorAll('.studio-section').forEach(s => { s.hidden = s.id !== sec; });
    document.querySelectorAll('.studio-tabs a').forEach(a => a.classList.toggle('on', a.dataset.sec === sec));
  }
  TABS.forEach(t => { $(t).hidden = t !== tab; });
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  /* Perform: the live controls as one 16:9 screen, the site's header folded away */
  document.body.classList.toggle('perform', view === 'device' && tab === 'live-sec' && connected);
  if (id !== 'connect' || !connected) window.scrollTo({top: 0});
}
/* Full screen (for the stage); Esc or the button again leaves it */
const fullBtn = $('stage-full');
if (fullBtn) {
  fullBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  document.addEventListener('fullscreenchange', () => {
    fullBtn.setAttribute('aria-pressed', String(!!document.fullscreenElement));
    fullBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });
}
window.addEventListener('hashchange', route);
const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };

/* ---------- connection ---------- */
document.addEventListener('device-state', e => {
  const was = connected;
  connected = e.detail.connected;
  document.body.classList.toggle('connected', connected);
  const chip = $('conn-chip'), m = /Connected over (\S+): (\S+)/.exec($('device').textContent);
  chip.classList.toggle('on', connected);
  chip.textContent = connected ? (m ? `${m[2]} · ${m[1]}` : 'Connected') : 'Not connected';
  chip.href = connected ? `#${tab}` : '#connect';
  $('wiz-backup-text').innerHTML = connected ? 'Save them to this computer:' : 'Connect in <a href="#connect">My FM-1</a> to export them.';
  if (connected && !was && location.hash === '#connect') history.replaceState(null, '', `#${tab}`);
  route();
});
/* Install step 3's "Export songs now" runs the Songs tab's export; its progress and messages
   are copied here, since the Songs tab is out of sight. */
$('wiz-backup').onclick = () => {
  $('wiz-backup-status').hidden = false;
  $('export').click();
};
const mirror = () => {
  const p = $('save-progress'), q = $('wiz-backup-progress'), s = $('save-status'), t = $('wiz-backup-status');
  q.hidden = p.hidden || t.hidden; q.max = p.max; q.value = p.value;
  t.textContent = s.textContent; t.className = s.className;
};
new MutationObserver(mirror).observe($('save-status'), {childList: true, characterData: true, subtree: true, attributes: true});
new MutationObserver(mirror).observe($('save-progress'), {attributes: true});

/* ---------- install steps ---------- */
function showStep(n) {
  step = n;
  document.querySelectorAll('.wstep').forEach(s => { s.hidden = +s.dataset.step !== n; });
  [...$('wiz-steps').children].forEach((li, i) => {
    li.classList.toggle('on', i + 1 === n); li.classList.toggle('done', i + 1 < n);
    if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  wizButtons();
}
function wizButtons() {
  $('rom-step').hidden = step === 4;
  // the guidance line only when it is about the step on screen (or about work in progress)
  const m = /^Step (\d)/.exec($('rom-next').textContent);
  $('rom-next').hidden = !!m && +m[1] !== step;
  document.querySelectorAll('[data-step="1"] [data-next]').forEach(b => { b.disabled = !rom.ready; });
  document.querySelectorAll('[data-step="2"] [data-next]').forEach(b => { b.disabled = !rom.fits; });
}
document.querySelectorAll('[data-next]').forEach(b => { b.onclick = () => showStep(step + 1); });
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = () => showStep(Math.max(1, step - 1)); });
document.querySelectorAll('[data-goto]').forEach(b => {
  b.onclick = () => { showStep(+b.dataset.goto); $('fw-other').open = true; };
});
document.addEventListener('rom-state', e => {
  const was = rom; rom = e.detail;
  if (rom.prepared && !was.prepared) showStep(4);
  else if (rom.ready && !was.ready && step === 1) showStep(2);
  else if (!rom.ready && !rom.working && (step === 2 || step === 3)) showStep(1);
  wizButtons();
});
$('wiz-preview').onclick = () => {
  go('#emulator-sec');
  if (getFirmwareSelection()) $('emu-selected').click();
};

route();
showStep(1);
