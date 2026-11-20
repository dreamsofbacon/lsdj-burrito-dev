// SPDX-License-Identifier: GPL-3.0-only
// "Which FM-1 gets this firmware?": with more than one FM-1 plugged in, Install asks (Colin: it took whichever
// answered first). Each FM-1 shows its number big on its own screen while this is open (link.js identify,
// 0.9.98-dev.19), the same number as its row here (fm1-numbers.js: FM-1 1, FM-1 2), so the one on the desk is easy
// to tell. Older firmware can't: its row says so, and its title and firmware tell it apart. A <dialog>, never the
// browser's confirm(): that stops the page, a playing deck's MIDI clock with it (crate-ui.js).
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const SHOW_S = 12, AGAIN_MS = 8000;   /* each shows its number 12 s, asked again every 8 s while the dialog is open */

/* fm1s: [{key, no, title, firmware, inUse}]; identify(key, no, seconds) -> true shown, false it can't (older firmware),
   throws when it doesn't answer. -> the key chosen, or null (cancelled). Nothing is picked until one is chosen. */
export function chooseFm1({fm1s, identify = async () => false, product = 'this firmware'}) {
  return new Promise(resolve => {
    const dlg = el('dialog', {className: 'choose-lsdj choose-fm1'});
    const list = el('div', {className: 'choose-list', role: 'radiogroup'});
    const shows = new Map();   /* key -> true / false / null (not answered yet) */
    let picked = null, timer = 0, open = true;
    const ok = el('button', {type: 'button', className: 'primary', textContent: 'Choose an FM-1', disabled: true,
      onclick: () => { if (picked) finish(picked); }});
    const finish = v => {
      open = false; clearInterval(timer);
      for (const f of fm1s) if (shows.get(f.key)) void identify(f.key, f.no, 0).catch(() => {});   /* its number away now */
      dlg.close(); dlg.remove(); resolve(v);
    };
    const note = f => shows.get(f.key) === true ? 'its number is on its screen'
      : shows.get(f.key) === false ? 'can\'t show its number (firmware before 0.9.98-dev.19)' : '';
    const draw = () => {
      list.replaceChildren(...fm1s.map(f => el('label', {className: 'choose-row fm1-row'},
        el('input', {type: 'radio', name: 'choose-fm1', checked: f.key === picked, onchange: () => {
          picked = f.key; ok.disabled = false; ok.textContent = `Install on FM-1 ${f.no}`; }}),
        el('span', {className: 'fm1-no', textContent: String(f.no), 'aria-hidden': 'true'}),
        el('span', {}, el('b', {textContent: `FM-1 ${f.no}`}),
          el('span', {className: 'hint', textContent: ` · ${f.title || 'no LSDj'} · ${f.firmware || 'firmware unknown'}${f.inUse ? ' · in use on this page' : ''}`}),
          note(f) ? el('span', {className: shows.get(f.key) ? 'ok fm1-note' : 'hint fm1-note', textContent: note(f)}) : null))));
    };
    const showAll = () => {
      for (const f of fm1s) {
        if (shows.get(f.key) === false) continue;   /* (older firmware: not asked again) */
        identify(f.key, f.no, SHOW_S).then(v => { if (!open) { if (v) void identify(f.key, f.no, 0).catch(() => {}); return; } if (shows.get(f.key) !== v) { shows.set(f.key, v); draw(); } })
          .catch(() => { /* didn't answer this time: asked again */ });
      }
    };
    dlg.append(
      el('h3', {textContent: 'Which FM-1 gets the firmware?'}),
      el('p', {className: 'hint', textContent: `${fm1s.length} FM-1s are plugged in. Each one shows its number big on its screen: choose the one to install ${product} on. Nothing is written to the others.`}),
      list,
      el('div', {className: 'row'}, ok, el('button', {type: 'button', textContent: 'Cancel', onclick: () => finish(null)})));
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    draw();
    dlg.showModal();
    showAll(); timer = setInterval(showAll, AGAIN_MS);
  });
}
