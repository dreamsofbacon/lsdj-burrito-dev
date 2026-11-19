// SPDX-License-Identifier: GPL-3.0-only
// The user's LSDj files (.gb) and .kit files, remembered in this browser (IndexedDB) so song sets can use their
// kits without picking the files again. On this computer only: never uploaded, never in the offline copy
// (sw.js). Each file is kept once (by SHA-256). Without storage (a private window), it lasts for the visit.
// Changes are announced with a 'kit-library' event.
// Storage that isn't kept (a private window, storage refused, a write that failed, the disk full) is said: the
// page used to swallow those errors, and a library that lasted only for the visit looked like a kept one
// (storageState, a 'kit-library-trouble' event). The browser is asked once to keep the storage (persist).
const DB = 'burrito-kits', STORE = 'files';
let memory = new Map(), db = null, ready = null, trouble = '', persisted = null;
function troubled(text) {
  trouble = text;
  document.dispatchEvent(new CustomEvent('kit-library-trouble', {detail: {text}}));
}

function open() {
  if (ready) return ready;
  ready = new Promise(resolve => {
    /* storage that never answers (blocked, or a test browser) leaves the library in memory for this visit */
    const late = setTimeout(() => { troubled('This browser\'s storage did not answer: your LSDj files, songs and backups last only until this page closes.'); resolve(); }, 5000);
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'id'});
      req.onsuccess = () => { clearTimeout(late); db = req.result; resolve(); };
      req.onerror = () => { clearTimeout(late); troubled('This browser keeps no files for this page (a private window, or storage turned off): your LSDj files, songs and backups last only until this page closes.'); resolve(); };
    } catch { clearTimeout(late); troubled('This browser keeps no files for this page: your LSDj files, songs and backups last only until this page closes.'); resolve(); }
  }).then(async () => {
    if (!db) return;
    const all = await tx('readonly', s => s.getAll()).catch(() => []);
    for (const f of all) memory.set(f.id, f);
  });
  return ready;
}
function tx(mode, f) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), r = f(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
const announce = () => document.dispatchEvent(new CustomEvent('kit-library'));
const hashOf = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

/* a write that failed: said (the file stays in memory for this visit only) */
const kept = (p, name) => p.catch(e => {
  troubled(`${name} could not be kept in this browser (${e?.name === 'QuotaExceededError' ? 'its storage is full' : e?.message || e?.name || 'a storage error'}): it lasts only until this page closes.`);
});
/* asks the browser once to keep this page's storage (not cleared when space runs low); null: can't tell */
async function persist() {
  if (persisted !== null) return persisted;
  try { persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; }
  catch { persisted = false; }
  return persisted;
}
/* the library's storage now: {kept: storage works, persisted: the browser keeps it, used, quota (bytes, or null),
   trouble: what went wrong ('' if nothing)} */
export async function storageState() {
  await open();
  let used = null, quota = null;
  try { const e = await navigator.storage?.estimate?.(); used = e?.usage ?? null; quota = e?.quota ?? null; } catch { /* unknown */ }
  return {kept: !!db, persisted: await persist(), used, quota, trouble};
}

/* [{id, kind: 'rom' | 'kit' | 'sav' | 'img' | 'backup', name, bytes, added, ...meta}], oldest first */
export async function libraryFiles() {
  await open();
  return [...memory.values()].sort((a, b) => a.added - b.added);
}
/* adds a file (kept once) -> its entry. meta: more fields kept with it (a backup's FM-1 and time) */
export async function addToLibrary(kind, name, bytes, meta = {}) {
  await open();
  const id = await hashOf(bytes);
  if (memory.has(id)) return memory.get(id);
  const entry = {...meta, id, kind, name, bytes: bytes.slice(), added: Date.now()};
  memory.set(id, entry);
  if (db) { void persist(); await kept(tx('readwrite', s => s.put(entry)), name); }
  announce();
  return entry;
}
export async function removeFromLibrary(id) {
  await open();
  memory.delete(id);
  if (db) await kept(tx('readwrite', s => s.delete(id)), 'A removal');
  announce();
}
export async function clearLibrary() {
  await open();
  memory = new Map();
  if (db) await tx('readwrite', s => s.clear()).catch(() => {});
  announce();
}
export {hashOf};
