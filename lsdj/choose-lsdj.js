// SPDX-License-Identifier: GPL-3.0-only
// "Which LSDj goes with these songs?": a cartridge is an LSDj and its songs together (a .sav holds no samples: the
// songs' kits are in the LSDj), so songs never go in the DJ crate, or out as a cartridge, without one. Your
// cartridges (cartridges.js) are listed best fit first (the kits the songs play: lsdj-usage.js), the best one
// picked; another LSDj file can be added here. An LSDj too old to open the songs (their format: lsdj-sets.js) goes
// last, marked with what they need (the dev.18 page). A <dialog>, never the browser's confirm(): that stops the page, a
// playing deck's MIDI clock with it (crate-ui.js).
import {cartridges, cartName, addCartridge} from './cartridges.js';
import {parseSav, savBody, songsOf, nameText} from './lsdj-sav.js';
import {kitSlots} from './lsdj-kit.js';
import {usageAcross, bestRom} from './lsdj-usage.js';
import {lsdjLabel, lsdjFormat, songFormat, opens, needsText} from './lsdj-sets.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* the songs of one or more saves, for the fit */
function songsIn(savs) {
  const out = [];
  for (const b of savs) { try { for (const s of songsOf(parseSav(savBody(b)))) out.push({name: nameText(s.nameBytes), song: s.song}); } catch { /* unreadable: no fit from it */ } }
  return out;
}
/* the newest song format among the saves' songs (null: none known) */
export function savsFormat(savs) {
  const f = Math.max(-1, ...songsIn(savs).map(s => songFormat(s.song) ?? -1));
  return f < 0 ? null : f;
}
/* the cartridges, the ones that open the songs first, then best fit -> [{c, fit, opens}] (fit null: no songs to go by) */
export async function rankCartridges(savs) {
  const list = (await cartridges()).filter(c => c.from !== 'made'), songs = songsIn(savs);   /* (not the crate's cut-down ones) */
  const need = savsFormat(savs), canOpen = c => opens(lsdjFormat(c.bytes), need);
  if (!songs.length) return list.map(c => ({c, fit: null, opens: true}));
  const usage = usageAcross(songs);
  const {fits} = bestRom(list.map(c => ({c, slots: kitSlots(c.bytes)})), usage);
  const ranked = fits.map(f => ({c: f.c, fit: f.fit, opens: canOpen(f.c)}));
  return [...ranked.filter(r => r.opens), ...ranked.filter(r => !r.opens)];
}
const fitText = fit => !fit ? '' : fit.ok ? ' · has every kit the songs play' :
  ` · ${plural(new Set(fit.kits.map(m => m.kit)).size, 'kit')} the songs play missing`;

/* -> {id, name, bytes} of the LSDj chosen, or null (cancelled: nothing made). title: what it's for; savs: the
   songs' saves (for the fit); prefer: a cartridge id to pick first (the FM-1's, the one chosen in Songs and kits) */
export function chooseLsdj({title, savs = [], prefer = null, action = 'Use this LSDj'}) {
  return new Promise(resolve => {
    const dlg = el('dialog', {className: 'choose-lsdj'});
    const list = el('div', {className: 'choose-list', role: 'radiogroup'}), msg = el('p', {className: 'hint', role: 'status'});
    let picked = null, ranked = [];
    const need = needsText(savsFormat(savs)), needEl = need ? el('p', {className: 'hint', textContent: `These songs need ${need}.`}) : null;
    const finish = v => { dlg.close(); dlg.remove(); resolve(v); };
    const ok = el('button', {type: 'button', className: 'primary', textContent: action, disabled: true,
      onclick: () => { const r = ranked.find(x => x.c.id === picked); if (r) finish({id: r.c.id, name: cartName(r.c), bytes: r.c.bytes}); }});
    const draw = async () => {
      ranked = await rankCartridges(savs);
      /* prefer: picked first if it opens the songs (else the first that does) */
      if (!ranked.some(r => r.c.id === picked)) picked = ranked.some(r => r.c.id === prefer && r.opens) ? prefer : ranked[0]?.c.id ?? null;
      const none = ranked.length && !ranked.some(r => r.opens);
      list.replaceChildren(...(none ? [el('p', {className: 'warn', textContent: `None of your LSDj files opens these songs: add ${need || 'the one they were made with'}.`})] : []),
        ...(ranked.length ? ranked.map(({c, fit, opens: ok}, i) => el('label', {className: 'choose-row' + ((fit && !fit.ok) || !ok ? ' misfit' : '')},
        el('input', {type: 'radio', name: 'choose-lsdj', checked: c.id === picked, onchange: () => { picked = c.id; }}),
        el('span', {}, el('b', {textContent: cartName(c)}),
          el('span', {className: (fit && !fit.ok) || !ok ? 'warn' : 'hint', textContent: ` · LSDj ${lsdjLabel(c.bytes)}${ok ? '' : ` · too old for these songs (they need ${need})`}${fitText(fit)}${i === 0 && ok && fit?.ok ? ' (best fit)' : ''}`}))))
        : [el('p', {className: 'warn', textContent: 'No LSDj kept in this browser yet: add the one these songs were made with.'})]));
      ok.disabled = !picked;
    };
    const input = el('input', {type: 'file', accept: '.gb,.gbc', hidden: true, onchange: async () => {
      const f = input.files[0]; input.value = '';
      if (!f) return;
      try { const c = await addCartridge(new Uint8Array(await f.arrayBuffer()), f.name, {from: 'file'}); picked = c.id; msg.textContent = `Added ${f.name}.`; msg.className = 'ok'; await draw(); }
      catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
    }});
    dlg.append(
      el('h3', {textContent: `Which LSDj goes with ${title}?`}),
      el('p', {className: 'hint', textContent: 'A cartridge is an LSDj and its songs together: the songs\' kit samples are in the LSDj, not in the .sav. Choose the one they were made with.'}),
      needEl,
      list,
      el('div', {className: 'row'}, el('button', {type: 'button', textContent: 'Add an LSDj file…', onclick: () => input.click()}), input),
      msg,
      el('div', {className: 'row'}, ok, el('button', {type: 'button', textContent: 'Cancel', onclick: () => finish(null)})));
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    void draw();
  });
}
