// SPDX-License-Identifier: GPL-3.0-only
// The cartridge work (cart-core.js) off the page's thread, asked by cart-work.js: reading hundreds of songs and
// planning carts can take seconds, and the DJ decks' clocks must not wait for it. Messages: {id, type, ...} in,
// {id, ok, result | error} out.
import {newState, setLibrary, checkRoms, addFiles, dupGroups, forget, fitCarts, studioView, autoSort, buildStudio} from './cart-core.js';

const st = newState();
self.onmessage = async ({data: {id, type, ...m}}) => {
  try {
    let result = null, transfer = [];
    if (type === 'library') { setLibrary(st, m.files, m.built); await checkRoms(st); }
    else if (type === 'add') result = await addFiles(st, m.files);
    else if (type === 'dups') result = dupGroups(st, m.ids);
    else if (type === 'forget') forget(st, m.ids);
    else if (type === 'studio') result = studioView(st, m.req, m.capacity);
    else if (type === 'autosort') result = autoSort(st, m.req, m.capacity);
    else if (type === 'buildstudio') { result = buildStudio(st, m.ids, m.titles); transfer = result.flatMap(c => [c.rom.buffer, c.sav.buffer]); }
    else if (type === 'fit') { result = fitCarts(m); transfer = result.flatMap(c => [c.rom.buffer, c.sav.buffer]); }
    else if (type === 'clear') Object.assign(st, newState(), {libRoms: st.libRoms, kitFiles: st.kitFiles.filter(k => !k.project), built: st.built, full: st.full});
    self.postMessage({id, ok: true, result}, transfer);
  } catch (e) { self.postMessage({id, ok: false, error: String(e?.message ?? e)}); }
};
