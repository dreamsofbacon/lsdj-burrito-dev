// SPDX-License-Identifier: GPL-3.0-only
// A DJ deck's effects (lsdj/dj-ui.js puts one beside each deck: a drawer, a column, or its own window). It changes
// that deck's own FM-1 (set) and follows its knobs (refresh). Two views of the same effects:
// - compact (the drawer, the column): the FM-1's effects pages as on its knobs (fx-model.js pagesForFx), one page
//   at a time; an effect for each channel gets four sliders (PU1 PU2 WAV NOI), a shared one a single slider.
// - full (in its own window, popout.js: body.popped): the Effects page without the screen, for a monitor of its
//   own (deck A's effects | the decks | deck B's effects): the wiring (fx-diagram.js), then the Master and the
//   Channels cards with every page shown, the same markup and look as Perform's (app.js buildFx, index.html).
import {CHANNELS, PARAM, pagesForFx, paramGet, valueText, effectActive, isMasterPage, choicesFor} from './fx-model.js';
import {fxDiagram} from './fx-diagram.js';

const PER_CHANNEL = new Set(['ch', 'q', 'flags', 'rvch']);
const perChannel = key => PER_CHANNEL.has(PARAM[key]?.where);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };

/* name: "Deck A"; get() -> the deck's effects ({...unpackFx, reverb}) or null; set(key, c, v); fw() -> the
   firmware's number; mute() -> its channel mutes (the wiring greys them); onFm1() -> the page its knobs are on
   (marked, as Perform marks it), or null; page / onPage: the compact view's page
   (kept by the caller); actions: header buttons */
export function fxPanel({name, get, set, fw = () => Infinity, fx98 = () => true, mute = () => 0, onFm1 = () => null, page = 1, onPage = () => {}, actions = []}) {
  const tabs = el('div', {className: 'seg dj-fx-pages', role: 'tablist', ariaLabel: `${name} effects pages`});
  const body = el('div', {className: 'dj-fx-body'});
  const note = el('p', {className: 'hint dj-fx-note'});
  const compact = el('div', {className: 'dj-fx-panel'}, tabs, body);
  const wire = el('div', {className: 'fxd-wrap dj-fxw-wire'});
  const cards = el('div', {className: 'dj-fxw-cards'});
  const full = el('div', {className: 'dj-fxw'}, wire, cards);
  const root = el('div', {className: 'dj-fx-wrap'},
    el('div', {className: 'dj-fx-head'}, el('b', {textContent: `${name} · FX`}), ...actions), note, compact, full);
  let holding = false, built = '', svg = '';
  root.addEventListener('pointerdown', () => { holding = true; });
  /* (the pointer may be let go in another window, or over another element) */
  const letGo = () => { holding = false; };
  root.addEventListener('pointerup', letGo); root.addEventListener('pointercancel', letGo);
  root.addEventListener('lostpointercapture', letGo);

  const pages = fx => pagesForFx(fx, fw()).map((p, i) => ({...p, i})).filter(p => !p.rv || fx.reverb);
  const usable = ([where, key]) => PARAM[key] && !PARAM[key].live && (where !== 'rvch' || get()?.reverb?.rvSend);
  const shape = fx => `${fx.v2}${fx.v3}${fx.reverb ? 1 : 0}${fx.reverb?.rvSend ? 1 : 0}${fw()}${fx98() ? 1 : 0}${page}`;
  function build() {
    const fx = get();
    if (!fx) {
      tabs.replaceChildren(); body.replaceChildren(); cards.replaceChildren(); wire.replaceChildren(); svg = '';
      note.textContent = 'Choose an FM-1 for this deck to see and change its effects.'; note.hidden = false;
      built = ''; return;
    }
    note.hidden = true;
    const list = pages(fx);
    if (!list.some(p => p.i === page)) page = list[0]?.i ?? 0;
    tabs.replaceChildren(...list.map(p => el('button', {type: 'button', textContent: p.name, role: 'tab',
      className: p.i === page ? 'on' : '', ariaSelected: String(p.i === page),
      onclick: () => { page = p.i; onPage(page); build(); }})));
    const pg = list.find(p => p.i === page);
    body.replaceChildren(...(pg?.knobs || []).filter(Boolean).filter(usable).map(([, key]) => row(key)));
    buildFull(fx, list);
    built = shape(fx);
    refresh();
  }

  /* ---- compact: one effect a row, its name, then a slider for each channel (or one) with its value ---- */
  function row(key) {
    const p = PARAM[key], chans = perChannel(key) ? CHANNELS.map((_, c) => c) : [0];
    const cells = chans.map(c => {
      const id = `${name}-${key}-${c}`.replace(/\W+/g, '-');
      const label = chans.length > 1 ? CHANNELS[c] : '';
      const input = p.choices
        ? el('select', {id, onchange: () => set(key, c, +input.value)}, ...choicesFor(p, fx98()).map((t, v) => new Option(t, v)))
        : el('input', {id, type: 'range', min: 0, max: 127, oninput: () => { set(key, c, +input.value); show(); }});
      input.setAttribute('aria-label', `${name} ${p.name}${label ? ' ' + label : ''}`);
      const out = el('output', {className: 'mono', htmlFor: id});
      const cell = el('label', {className: 'dj-fx-cell'}, label ? el('span', {className: 'dj-fx-ch', textContent: label}) : null, input, out);
      const show = () => { const fx = get(); if (fx) out.textContent = valueText(fx, key, c); };
      cell.update = fx => {
        const v = paramGet(fx, key, c);
        if (!holding && input.ownerDocument.activeElement !== input && +input.value !== v) input.value = v;
        out.textContent = valueText(fx, key, c);
        cell.classList.toggle('idle', !effectActive(fx, key, c));
      };
      return cell;
    });
    const r = el('div', {className: `dj-fx-row${chans.length > 1 ? ' chans' : ''}`}, el('span', {className: 'dj-fx-name', textContent: p.name}), ...cells);
    r.update = fx => cells.forEach(c => c.update(fx));
    return r;
  }

  /* ---- full: as Perform's Effects (app.js buildFx, control, channelBlocks), for this deck's FM-1 ---- */
  function buildFull(fx, list) {
    const master = el('div', {className: 'fx-pages master'}), chans = el('div', {className: 'fx-pages all'});
    for (const p of list) (isMasterPage(fx, p.i, fw()) ? master : chans).append(fullCard(fx, p));
    cards.replaceChildren(...(master.childElementCount ? [el('h3', {className: 'dj-fxw-head', textContent: 'Master'}), master] : []),
      el('h3', {className: 'dj-fxw-head', textContent: 'Channels'}), chans);
    svg = '';
  }
  function fullCard(fx, p) {
    const masterPage = isMasterPage(fx, p.i, fw()), anyCh = p.knobs.some(s => s && perChannel(s[1])), perCh = anyCh && !masterPage;
    const card = el('div', {className: `fx-card dj-card${perCh ? ' matrix' : ''}`});   /* (dj-card, dj-ctl: app.js's Effects leaves them alone) */
    card.dataset.page = p.i;
    card.append(el('h3', {}, p.name, el('span', {className: 'fx-who', textContent: anyCh ? '' : 'all channels'}), el('span', {className: 'fx-onfm1', textContent: "on the FM-1's knobs"})));
    p.knobs.forEach((slot, k) => {
      if (!slot || !usable(slot)) return;
      const [where, key] = slot, P = PARAM[key];
      const r = el('div', {className: 'fx-row'}, el('span', {className: 'knob', textContent: `K${k + 1}`}),
        el('span', {className: 'fx-name'}, P.name, (where === 'comp' || where === 'echo') && anyCh ? el('small', {textContent: ' (all)'}) : null));
      if (perCh && perChannel(key)) CHANNELS.forEach((_, c) => r.append(ctl(key, c)));
      else if (anyCh && perChannel(key)) CHANNELS.forEach((_, c) => { const w = ctl(key, c); w.classList.add('chan-line'); r.append(w); });
      else { const w = ctl(key, 0); if (perCh) w.classList.add('shared'); r.append(w); }
      card.append(r);
    });
    if (perCh) channelBlocks(card);
    return card;
  }
  /* one control, as Perform's: a toggle (up to 3 choices), a list, or a slider with its value */
  function ctl(key, c) {
    const p = PARAM[key], wrap = el('div', {className: 'fx-ctl dj-ctl'}), out = el('output');
    wrap.dataset.key = key;
    if (perChannel(key)) { wrap.dataset.ch = c; wrap.dataset.chn = CHANNELS[c]; }
    let input, show;
    if (p.choices && p.choices.length <= 3) {
      input = el('div', {className: 'seg', role: 'radiogroup'});
      const btns = p.choices.map((t, v) => el('button', {type: 'button', textContent: t, role: 'radio', onclick: () => set(key, c, v)}));
      input.append(...btns);
      show = v => btns.forEach((b, i) => { b.classList.toggle('on', i === v); b.setAttribute('aria-checked', String(i === v)); });
    } else if (p.choices) {
      input = el('select', {onchange: () => set(key, c, +input.value)}, ...choicesFor(p, fx98()).map((t, v) => new Option(t, v)));
      show = v => { if (input.ownerDocument.activeElement !== input) input.value = v; };
    } else {
      input = el('input', {type: 'range', min: 0, max: 127, oninput: () => { set(key, c, +input.value); const fx = get(); if (fx) out.textContent = valueText(fx, key, c); }});
      show = v => { if (!holding && input.ownerDocument.activeElement !== input && +input.value !== v) input.value = v; };
    }
    input.setAttribute('aria-label', `${name} ${p.name}${perChannel(key) ? ' ' + CHANNELS[c] : ''} (full)`);
    wrap.append(input, out);
    wrap.update = (fx, m) => {
      show(paramGet(fx, key, c));
      out.textContent = valueText(fx, key, c);
      wrap.classList.toggle('idle', !effectActive(fx, key, c));
      wrap.classList.toggle('muted', perChannel(key) && !!((m >> c) & 1));
    };
    return wrap;
  }
  /* (app.js channelBlocks, with the channels' names: every page is shown) */
  function channelBlocks(card) {
    const rows = [...card.querySelectorAll(':scope > .fx-row')];
    const shared = r => !!r.querySelector('.fx-ctl.shared');
    const per = rows.filter(r => !shared(r));
    [...per, ...rows.filter(shared)].forEach((r, i) => { r.style.setProperty('--r', i + 3); card.append(r); });
    card.querySelectorAll('.fx-ctl[data-ch]').forEach(w => w.style.setProperty('--c', +w.dataset.ch + 3));
    const first = card.querySelector(':scope > .fx-row');
    CHANNELS.forEach((n, c) => {
      const b = el('div', {className: 'fx-chbox', ariaHidden: 'true'});
      b.dataset.ch = c; b.style.setProperty('--c', c + 3); b.style.setProperty('--n', per.length + 1);
      card.insertBefore(b, first);
      const l = el('div', {className: 'fx-chname', textContent: n});
      l.dataset.ch = c; l.style.setProperty('--c', c + 3);
      card.insertBefore(l, first);
    });
    card.classList.add('blocks');
  }

  /* the values again (the FM-1's knobs moved, or the deck's filter or a throw): only what changed is redrawn */
  function refresh() {
    const fx = get();
    if (!fx || built !== shape(fx)) { if (!holding) build(); return; }
    body.querySelectorAll('.dj-fx-row').forEach(r => r.update(fx));
    const m = mute() & 15;
    cards.querySelectorAll('.fx-ctl').forEach(w => w.update(fx, m));
    const on = onFm1();
    cards.querySelectorAll('.dj-card').forEach(c => c.classList.toggle('fm1', on != null && +c.dataset.page === on));
    const s = fxDiagram(fx, {mute: m, layout: 'v'});
    if (s !== svg) { svg = s; wire.innerHTML = s; }
  }
  build();
  return {el: root, refresh, rebuild: build};
}
