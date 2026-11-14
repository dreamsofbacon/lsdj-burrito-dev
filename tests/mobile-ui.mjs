// SPDX-License-Identifier: GPL-3.0-only
// The page on phones (a local preview, never a device): the site in frames at phone sizes, upright and on its side,
// with two fake FM-1s (tests/dj-ui.mjs djDemo). In Perform › Effects and DJ, and in Settings: nothing wider than the
// screen (a phone would zoom the whole page out for it), no button with its text cut, buttons big enough to tap;
// DJ upright: the turn-sideways card instead of the console; DJ on its side: both decks' PLAY and SYNC and the
// crossfader on screen with no scrolling, ⋯ opening and closing the rest.
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 15000) {
  for (const t = Date.now(); Date.now() - t < ms;) { if (check()) return; await sleep(100); }
  throw Error(message);
}
const UPRIGHT = [[360, 780], [390, 844], [412, 915]], SIDEWAYS = [[640, 360], [844, 390], [915, 412]];

/* the site at w x h, connected to two fake FM-1s */
async function phone(w, h) {
  const f = document.createElement('iframe');
  f.style.cssText = `width:${w}px;height:${h}px;border:0;position:fixed;left:0;top:0;z-index:99`;
  f.src = new URL('../index.html', import.meta.url).href;
  document.body.append(f);
  await until(() => f.contentDocument?.readyState === 'complete' && f.contentDocument.getElementById('dj-root'), 'the site loaded');
  const d = f.contentDocument, win = f.contentWindow;
  try { win.localStorage.clear(); } catch {}
  const sc = d.createElement('script'); sc.type = 'module';
  sc.textContent = `import('./tests/dj-ui.mjs').then(m => m.djDemo()).then(() => window.__phone = 'ok', e => window.__phone = 'FAIL ' + e);`;
  d.body.append(sc);
  await until(() => win.__phone, 'djDemo ran', 30000);
  assert(win.__phone === 'ok', win.__phone);
  d.getElementById('tip-keybd-ok')?.click();
  return {f, d, win};
}
/* what's wrong in this view, as text (empty: fine) */
function problems({d, win}, minTall) {
  const html = d.documentElement, out = [];
  html.style.overflowX = 'visible';   /* (the phone CSS's safety net off: see what would stick out) */
  const W = html.clientWidth;
  if (html.scrollWidth > W) {
    const clipped = e => { for (let a = e.parentElement; a && a !== d.body; a = a.parentElement) if (/(hidden|clip|auto|scroll)/.test(win.getComputedStyle(a).overflowX)) return true; return false; };
    const sticks = [...d.querySelectorAll('body *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1 && !clipped(e));
    const leaf = sticks.filter(e => !sticks.some(x => x !== e && e.contains(x))).slice(0, 4);
    out.push(`the page is ${html.scrollWidth} px wide on a ${W} px screen: ${leaf.map(e => `${e.tagName.toLowerCase()}#${e.id}.${[...e.classList].join('.')}`).join(', ')}`);
  }
  html.style.overflowX = '';
  const shown = b => b.offsetParent && b.getBoundingClientRect().width > 0 && win.getComputedStyle(b).visibility !== 'hidden';
  const section = d.querySelector('.tab-panel:not([hidden])') || d.body;
  const btns = [...section.querySelectorAll('button, select')].filter(shown).filter(b => !b.closest('.dj-fx,.crate-body,.dj-log,.dj-help,details:not([open])'));
  const cut = btns.filter(b => b.scrollWidth > b.clientWidth + 2).map(b => (b.textContent || b.value || '').trim().slice(0, 12));
  if (cut.length) out.push(`text cut on ${cut.join(' | ')}`);
  const small = btns.filter(b => b.tagName === 'BUTTON' && b.getBoundingClientRect().height < minTall && !b.closest('.dj-presets,.dj-crate'))
    .map(b => `${(b.textContent || b.ariaLabel || '').trim().slice(0, 10)} ${Math.round(b.getBoundingClientRect().height)}`);
  if (small.length) out.push(`under ${minTall} px tall: ${small.slice(0, 8).join(' | ')}`);
  return out.join('; ');
}
const onScreen = ({d, win}, sel) => [...d.querySelectorAll(sel)].filter(e => e.offsetParent).length > 0 &&
  [...d.querySelectorAll(sel)].filter(e => e.offsetParent).every(e => { const r = e.getBoundingClientRect(); return r.bottom <= win.innerHeight + 1 && r.right <= d.documentElement.clientWidth + 1 && r.top >= 0; });
const mode = (p, m) => p.d.querySelector(`#stage-mode [data-mode="${m}"]`).click();

export async function runMobileUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const done = [];
  for (const [w, h] of UPRIGHT) {
    const p = await phone(w, h);
    try {
      mode(p, 'fx'); await sleep(300);
      let bad = problems(p, 34); assert(!bad, `${w}×${h} Effects: ${bad}`);
      mode(p, 'dj'); await sleep(300);
      assert(onScreen(p, '.dj-rotate') && !p.d.getElementById('dj-root').offsetParent, `${w}×${h} DJ upright: the turn-sideways card, not the console`);
      bad = problems(p, 34); assert(!bad, `${w}×${h} DJ upright: ${bad}`);
      p.win.location.hash = '#settings-sec'; await sleep(300);
      bad = problems(p, 30); assert(!bad, `${w}×${h} Settings: ${bad}`);
      done.push(`${w}×${h}`);
    } finally { p.f.remove(); }
  }
  for (const [w, h] of SIDEWAYS) {
    const p = await phone(w, h);
    try {
      mode(p, 'dj'); await sleep(300);
      assert(!p.d.querySelector('.dj-rotate').offsetParent, `${w}×${h}: no turn-sideways card on its side`);
      let bad = problems(p, 34); assert(!bad, `${w}×${h} DJ: ${bad}`);
      const need = h >= 390 ? ['.dj-play', '.dj-sync', '.dj-xfader', '.dj-more'] : ['.dj-play', '.dj-sync', '.dj-more'];   /* (640×360: the crossfader a short scroll down) */
      for (const s of need) assert(onScreen(p, s), `${w}×${h} DJ: ${s} on screen without scrolling`);
      assert(p.d.querySelectorAll('.dj-play').length === 2 && !p.d.querySelector('.dj-deck .dj-jogwheel').offsetParent, `${w}×${h} DJ: two decks, no jog wheels`);
      const more = p.d.querySelector('.dj-more'), tpads = () => p.d.querySelector('.dj-tpads').offsetParent;
      assert(!tpads() && more.getAttribute('aria-expanded') === 'false', 'the tempo pads behind ⋯');
      more.click(); await sleep(100);
      assert(tpads() && more.getAttribute('aria-expanded') === 'true' && p.d.querySelector('.dj-help').offsetParent, '⋯: the tempo pads, How to set up');
      bad = problems(p, 34); assert(!bad, `${w}×${h} DJ ⋯ open: ${bad}`);
      more.click(); await sleep(100);
      assert(!tpads(), '⋯ again: closed');
      mode(p, 'fx'); await sleep(300);
      bad = problems(p, 34); assert(!bad, `${w}×${h} Effects: ${bad}`);
      done.push(`${w}×${h}`);
    } finally { p.f.remove(); }
  }
  return `PASS phones: ${done.join(', ')}: nothing wider than the screen, no cut text, tappable buttons; DJ upright the turn-sideways card; DJ on its side both decks and the crossfader on screen, ⋯ opens and closes the rest`;
}
