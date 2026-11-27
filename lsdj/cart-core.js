// SPDX-License-Identifier: GPL-3.0-only
// Studio › Build's cartridge work, without the page: songs from .sav / .lsdsng / .lsdprj files and LSDj ROMs / .kit files in;
// each song matched to the kits it plays (lsdj-sets.js resolveSongs: the LSDj it was made with, or a project's own
// kits); carts planned (every sample in as many carts as it takes, or one cart with the most-played kits) and built
// (an LSDj holding only the kits and samples the songs play, and a .sav). Pure: runs in a worker (cart-worker.js),
// so the DJ decks never wait for it, and in node (tests/cart.mjs). The user's files are never changed.
import {parseSav, songBytes, readLsdsng, readLsdprj, savBody, SAV_SIZE, SavError} from './lsdj-sav.js';
import {kitSlots, parseKit, isKitBank, BANK} from './lsdj-kit.js';
import {validateRom, findProfile} from './lsdj-rom.js';
import * as S from './lsdj-sets.js';

const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const sha = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');

/* songs: [{id, group, from, name, nameBytes, version, song}]; roms / kitFiles as resolveSongs takes them (library: from
   this browser's LSDj files; files: dropped here); picks: the kit picks a project's own kits make; template: the first
   .sav's bytes (its LSDj settings go into the carts) */
export const newState = () => ({songs: [], libRoms: [], fileRoms: [], kitFiles: [], picks: {}, rules: {}, template: null, built: new Set(), seq: 0, full: new Map(),
  fileKeys: new Map()});   /* the song files added: their hash -> {group, name} */
/* which LSDj files the FM-1 knows fully (lsdj-rom.js profiles 1 and 3: LSDj 9.2.0 to 9.4.2: SYNC, play state and
   rows for the DJ layout, MIDI sync, cues); other versions run, without those. Checked once a file (by id). */
export async function checkRoms(st) {
  for (const r of [...st.libRoms, ...st.fileRoms]) if (!st.full.has(r.id)) st.full.set(r.id, [1, 3].includes((await findProfile(r.rom).catch(() => null))?.profile));
}
const roms = st => { const m = new Map(); for (const r of [...st.libRoms, ...st.fileRoms]) if (!st.built.has(r.id)) m.set(r.id, r); return [...m.values()]; };
const romEntry = (id, name, rom, date = null) => ({id, name, rom, date, slots: kitSlots(rom), version: S.lsdjVersion(rom), format: S.lsdjFormat(rom)});

/* this browser's LSDj and .kit files ([{id, kind, name, bytes}]); built: the ids of carts made here (not sources) */
export function setLibrary(st, files, built = []) {
  st.built = new Set(built);
  st.libRoms = files.filter(f => f.kind === 'rom').map(f => { try { return romEntry(f.id, f.name, f.bytes, f.date ?? null); } catch { return null; } }).filter(r => r?.slots.length);
  st.kitFiles = [...st.kitFiles.filter(k => k.project), ...files.filter(f => f.kind === 'kit' && isKitBank(f.bytes)).map(f => ({id: f.id, name: f.name, bank: f.bytes.subarray(0, BANK)}))];
}

/* files dropped in: [{name, bytes, date (the file's last change, ms)}] -> {songs, roms: [{id, name, bytes, date}] (to keep
   in the library), kits (same), skipped: [{name, why}]}. A song file already here (the same bytes, under any name) is
   skipped. Each song keeps its file's date and a key (its bytes' hash: the same song in another file, dupGroups). */
export async function addFiles(st, files) {
  const out = {songs: 0, roms: [], kits: [], skipped: []};
  for (const {name, bytes, date = null} of files) {
    const ext = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase(), group = `f${st.seq++}`;
    const add = async s => { const key = await sha(s.song); st.songs.push({id: `${group}:${st.songs.length}`, group, from: name, date, key, ...s}); out.songs++; };
    try {
      const isSav = ext !== '.lsdprj' && ext !== '.lsdsng' && (ext === '.sav' || savBody(bytes).length === SAV_SIZE);
      if (ext === '.lsdprj' || ext === '.lsdsng' || isSav) {
        const fileKey = await sha(isSav ? savBody(bytes) : bytes), twin = st.fileKeys.get(fileKey);
        if (twin && st.songs.some(x => x.group === twin.group)) { out.skipped.push({name, why: twin.name === name ? 'added already' : `the same file as ${twin.name}`}); continue; }
        st.fileKeys.set(fileKey, {group, name});
      }
      if (ext === '.lsdprj') {
        const p = readLsdprj(bytes), id = `${group}:${st.songs.length}`;
        await add({name: p.name, nameBytes: p.nameBytes, version: p.version, song: p.song});
        const {map, rule} = S.projectKits(p.song, p.kits);
        p.kits.forEach((bank, i) => st.kitFiles.push({id: `${group}k${i}`, name: `${name} kit ${i + 1}`, bank, project: true}));
        for (const [n, i] of map) st.picks[`${id}:${n}`] = `kit:${group}k${i}`;
        st.rules[id] = rule;
      } else if (ext === '.lsdsng') {
        const x = readLsdsng(bytes); await add({name: x.name, nameBytes: x.nameBytes, version: x.version, song: x.song});
      } else if (isSav) {
        const sav = parseSav(bytes.slice());
        st.template ??= sav.bytes;
        for (const x of sav.songs) {
          try { await add({slot: x.slot, name: x.name, nameBytes: sav.bytes.slice(0x8000 + x.slot * 8, 0x8008 + x.slot * 8), version: x.version, song: songBytes(sav, x.slot)}); }
          catch (e) { if (!(e instanceof SavError)) throw e; out.skipped.push({name: `${name} ${x.name}`, why: e.message}); }
        }
      } else if (ext === '.kit' || (bytes.length === BANK && isKitBank(bytes))) {
        if (!isKitBank(bytes)) throw new SavError('not an LSDj .kit file');
        const id = await sha(bytes.subarray(0, BANK));
        st.kitFiles.push({id, name, bank: bytes.slice(0, BANK)}); out.kits.push({id, name, bytes: bytes.slice(0, BANK), date});
      } else if (['.gb', '.gbc'].includes(ext)) {
        validateRom(bytes);
        const r = romEntry(await sha(bytes), name, bytes, date);
        if (!r.slots.length) throw new SavError('an LSDj with no kit slots');
        st.fileRoms.push(r); out.roms.push({id: r.id, name, bytes, date});
      } else out.skipped.push({name, why: 'not a song, project, save, LSDj or kit'});
    } catch (e) { out.skipped.push({name, why: e.message}); }
  }
  await checkRoms(st);
  return out;
}

/* songs in more than one file: those of one name (copies and other versions of it), and the same bytes under other
   names (a renamed copy). Never linked further (A's bytes are B's, B's name is C's…): that would chain songs that have
   nothing to do with each other (say, a few empty new songs) into one group. A song may be in both kinds. */
function dupSets(st) {
  const by = keyOf => { const m = new Map(); for (const x of st.songs) { const k = keyOf(x); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(x); } } return [...m.values()].filter(g => g.length > 1); };
  const named = by(x => x.name?.trim());
  const renamed = by(x => x.key).filter(g => new Set(g.map(x => x.name?.trim())).size > 1);
  return [...named, ...renamed];
}
/* the songs in more than one file that hold any of ids (null: all) -> [{names, same (every copy the same bytes),
   versions (how many different), unsure, latest, songs: [{id, name, from, slot, date, version, same}]}], each one's
   songs newest first: the higher version (LSDj adds one each time a song is saved), then the later file. same: the id
   of an earlier copy with the same bytes. unsure: the latest file holds another, lower version (latest: its id) */
export function dupGroups(st, ids = null) {
  const want = ids && new Set(ids);
  const newer = (a, b) => (b.version ?? 0) - (a.version ?? 0) || (b.date ?? 0) - (a.date ?? 0);
  return dupSets(st).filter(g => !want || g.some(x => want.has(x.id))).map(g => {
    const songs = [...g].sort(newer), top = songs[0];
    const latest = songs.reduce((p, x) => (x.date ?? 0) > (p.date ?? 0) ? x : p);
    const twice = f => songs.filter(x => x.from === f).length > 1;
    return {names: [...new Set(songs.map(x => x.name))], same: new Set(songs.map(x => x.key)).size === 1, versions: new Set(songs.map(x => x.key)).size,
      unsure: latest.key !== top.key && (latest.date ?? 0) > (top.date ?? 0), latest: latest.id,
      songs: songs.map((x, i) => ({id: x.id, name: x.name, from: x.from, slot: twice(x.from) ? x.slot ?? null : null, date: x.date ?? null, version: x.version ?? 0,
        same: songs.slice(0, i).find(y => y.key === x.key)?.id ?? null}))};
  }).sort((a, b) => a.names[0].localeCompare(b.names[0], undefined, {numeric: true}));
}
/* songs taken out (copies not kept): gone from the view and the plans; their files may be added again */
export function forget(st, ids) {
  const gone = new Set(ids);
  st.songs = st.songs.filter(x => !gone.has(x.id));
  for (const id of gone) delete st.rules[id];
  for (const k of Object.keys(st.picks)) if (gone.has(k.slice(0, k.lastIndexOf(':')))) delete st.picks[k];
}

/* what the panel shows. req: {ticked: [ids] | null (all), choices: {madeWith, kitPick}, baseId, plan: 'split' | 'most'}
   -> {songs: [{id, name, from, blocks, made, madeAuto, kits: [{number, name, source, missing}], rule, status}],
       roms: [{id, name, version, kits}], baseId, plans: [{songs, kits, kib, blocks, over, lost}], capacity} */
export function view(st, req, capacity) {
  const list = roms(st), choices = {madeWith: req.choices?.madeWith ?? {}, kitPick: {...st.picks, ...(req.choices?.kitPick ?? {})}};
  const resolved = S.resolveSongs(st.songs, list, st.kitFiles, choices);
  const byId = new Map(st.songs.map(x => [x.id, x]));
  for (const r of resolved) { const s = byId.get(r.id); r.blocks = s.blocks ??= S.blocksOf(r.song); }
  /* the LSDj to build with: the one chosen, else one the FM-1 knows fully (LSDj 9.3.9), else the newest */
  const byVersion = [...list].sort((a, b) => S.compareVersions(b.version ?? [0], a.version ?? [0]));
  const best = byVersion.find(r => st.full.get(r.id)) ?? byVersion[0];
  const baseId = list.some(r => r.id === req.baseId) ? req.baseId : best?.id ?? null;
  const dupSize = new Map();
  for (const g of dupSets(st)) for (const x of g) dupSize.set(x.id, Math.max(dupSize.get(x.id) ?? 0, g.length));
  const songs = resolved.map(r => {
    const rule = st.rules[r.id] ?? null, own = byId.get(r.id);
    const silent = n => choices.kitPick[`${r.id}:${n}`] === 'none';   /* (left silent on purpose: not missing) */
    const status = r.missing.some(n => !silent(n)) ? 'missing' : rule === 'guess' ? 'check' : 'ok';
    return {id: r.id, name: r.name, from: own.from, date: own.date ?? null, version: own.version ?? 0, dups: dupSize.get(r.id) ?? 1, blocks: r.blocks, made: r.rom?.id ?? null, madeAuto: r.auto, rule, status,
      kits: r.kits.map(k => ({number: k.number, name: k.name, source: k.source?.label ?? null, missing: !k.bank && !silent(k.number), silent: silent(k.number), samples: k.samples.size}))};
  });
  /* each song's LSDj: the one chosen when it opens the song's format; else one that does (LSDj 9.3.9 first, then the
     oldest new enough); none: the one chosen, the song marked (it won't open right) */
  const base = list.find(r => r.id === baseId);
  const openers = [...list].filter(r => r.format != null).sort((a, b) => (st.full.get(b.id) ? 1 : 0) - (st.full.get(a.id) ? 1 : 0) || a.format - b.format);
  const homeOf = new Map(resolved.map(r => {
    const f = S.songFormat(r.song);
    if (!base || S.opens(base.format, f)) return [r.id, base];
    return [r.id, openers.find(o => S.opens(o.format, f)) ?? base];
  }));
  for (const x of songs) {
    const r = resolved.find(y => y.id === x.id), f = S.songFormat(r.song), home = homeOf.get(x.id);
    x.format = f; x.on = home?.id ?? null;
    x.needs = base && !S.opens(base.format, f) ? (home && S.opens(home.format, f) ? 'moved' : 'none') : null;
  }
  const out = {songs, roms: list.map(r => ({id: r.id, name: r.name, date: r.date ?? null, version: S.versionText(r.version), full: !!st.full.get(r.id), format: r.format, kits: r.slots.filter(s => !s.empty).length,
      slots: r.slots.filter(s => !s.empty).map(s => ({number: s.number, name: s.kit.name}))})),
    kitFiles: st.kitFiles.filter(k => !k.project).map(k => ({id: k.id, name: k.name})), baseId, plans: [], capacity};
  const ticked = req.ticked ? new Set(req.ticked) : null, picked = resolved.filter(r => !ticked || ticked.has(r.id));
  if (!base || !picked.length) return out;
  /* the carts: planned per LSDj (the one chosen first), each built with it */
  const groups = new Map();
  for (const r of picked) { const h = homeOf.get(r.id) ?? base; if (!groups.has(h.id)) groups.set(h.id, {rom: h, songs: []}); groups.get(h.id).songs.push(r); }
  const order = [...groups.values()].sort((a, b) => (b.rom === base) - (a.rom === base));
  const plans = [];
  for (const g of order) {
    const ctx = S.setContext(g.rom.rom, capacity);
    for (const p of req.plan === 'most' ? [S.planMost(g.songs, ctx)] : S.planSplit(g.songs, ctx)) plans.push({...p, ctx, lsdj: g.rom});
  }
  st.last = {plans};
  out.plans = plans.map(p => ({songs: p.entries.map(e => e.name), kits: p.kits.size, kib: Math.ceil(p.bytes / 1024), blocks: p.blocks,
    over: !!p.over, lost: (p.lost ?? []).map(l => `${l.song}: kit ${hex(l.kit)}`), leftOut: (p.leftOut ?? []).map(e => e.name),
    lsdj: {id: p.lsdj.id, name: p.lsdj.name, version: S.versionText(p.lsdj.version), full: !!st.full.get(p.lsdj.id), chosen: p.lsdj === base}}));
  return out;
}

/* songs and the LSDj chosen for them -> cartridges that fit the FM-1: that LSDj holding only the kits and samples the
   songs play, and a .sav (as Studio › Build makes them; the crate never keeps one that can't load). rom: the LSDj;
   savs: [{name, bytes}]; each: a cartridge a song (else as few as it takes); capacity: the FM-1's slot.
   -> [{rom, sav, songs: [names], fits, kib, warnings}] */
export function fitCarts({rom, savs, capacity, each = false}) {
  validateRom(rom);
  const lsdj = romEntry('chosen', 'the LSDj chosen', rom);
  if (!lsdj.slots.length) throw new SavError('This LSDj has no kit slots, so it can\'t be made smaller for its songs.');
  const songs = [];
  let template = null;
  for (const {name: from, bytes} of savs) {
    const sav = parseSav(savBody(bytes).slice());
    template ??= sav.bytes;
    for (const s of sav.songs) {
      try { songs.push({id: `${from}:${s.slot}:${songs.length}`, group: from, from, slot: null, name: s.name, nameBytes: sav.bytes.slice(0x8000 + s.slot * 8, 0x8008 + s.slot * 8), version: s.version, song: songBytes(sav, s.slot)}); }
      catch (e) { if (!(e instanceof SavError)) throw e; }
    }
  }
  if (!songs.length) throw new SavError('No saved songs in it to make the cartridge for.');
  const resolved = S.resolveSongs(songs, [lsdj], [], {madeWith: Object.fromEntries(songs.map(s => [s.id, 'chosen']))});
  for (const r of resolved) r.blocks = S.blocksOf(r.song);
  const ctx = S.setContext(rom, capacity);
  const out = [];
  for (const group of each ? resolved.map(r => [r]) : [resolved])
    for (const p of S.planSplit(group, ctx)) {
      const b = S.buildSet(p, ctx, template);
      out.push({rom: b.rom, sav: b.sav, songs: b.songs.map(s => s.name), fits: b.plan.fits, kib: Math.ceil(b.plan.needed / 1024), warnings: b.warnings});
    }
  return out;
}

/* the carts of the last view: [{rom, sav, report, songs, kits, kib, fits, warnings}] */
export function build(st, titles = []) {
  const {plans} = st.last ?? {};
  if (!plans?.length) throw new SavError('Nothing to build: tick some songs and choose an LSDj to build with.');
  return plans.map((p, i) => {
    const b = S.buildSet(p, p.ctx, st.template), title = titles[i] ?? `Cart ${i + 1}`;
    return {title, rom: b.rom, sav: b.sav, report: S.setReport(b, title, p.ctx), lsdj: S.versionText(p.lsdj.version), songs: b.songs.map(s => s.name), kits: b.kits.length,
      kib: Math.ceil(b.plan.needed / 1024), fits: b.plan.fits, warnings: b.warnings};
  });
}

/* ---- the Studio: carts the user arranges by hand (studio-ui.js) ---- */

/* The LSDj a studio cart is built with: the one chosen, else the one the page builds with (req.baseId) when it opens
   every song of the cart, else one that does (the FM-1's fully known LSDj first, then the oldest new enough); else the
   base, with the songs it can't open marked. -> {rom, auto, opensAll} */
function homeFor(st, list, baseId, cart, formats) {
  const opens = r => formats.every(f => S.opens(r.format, f));
  const chosen = cart.lsdjId && list.find(r => r.id === cart.lsdjId);
  if (chosen) return {rom: chosen, auto: false, opensAll: opens(chosen)};
  const base = list.find(r => r.id === baseId) ?? list[0];
  if (!base) return {rom: null, auto: true, opensAll: false};
  if (opens(base)) return {rom: base, auto: true, opensAll: true};
  const openers = list.filter(r => r.format != null && opens(r)).sort((a, b) => (st.full.get(b.id) ? 1 : 0) - (st.full.get(a.id) ? 1 : 0) || a.format - b.format);
  return openers.length ? {rom: openers[0], auto: true, opensAll: true} : {rom: base, auto: true, opensAll: false};
}

/* an LSDj's planning context (its kit slots emptied and measured), kept per LSDj and capacity: worked out once */
function contextOf(st, rom, capacity) {
  st.ctxs ??= new Map();
  const key = `${rom.id}:${capacity}`;
  if (!st.ctxs.has(key)) st.ctxs.set(key, S.setContext(rom.rom, capacity));
  return st.ctxs.get(key);
}
/* a planned set, as the Studio shows it */
const partOf = p => ({songIds: p.entries.map(e => e.id), songs: p.entries.length, kits: p.kits.size, kitNames: [...p.kits.values()].map(k => k.name || 'kit'),
  kib: Math.ceil(p.bytes / 1024), blocks: p.blocks, lost: p.lost.map(l => `${l.song}: kit ${hex(l.kit)}${l.name ? ` (${l.name})` : ''}`),
  leftOut: p.leftOut.map(e => e.name), fits: !p.lost.length && !p.leftOut.length});

/* What the Studio shows. req: {carts: [{id, lsdjId | null, songIds}], choices: {madeWith, kitPick}, baseId,
   mode: 'split' (a card too full for one cartridge makes several: planSplit, songs that share kits together) |
   'new' (one card, one cartridge: planMost; fit says how many of its songs, in order, fit with every sample, and the
   page moves the rest into a new card)}
   -> view()'s {songs, roms, kitFiles, baseId, capacity}, and carts: [{id, lsdj: {id, name, version, full, auto, opensAll},
   songs: [{id, name, blocks, format, tooNew}], parts: [{songIds, songs, kits, kitNames, kib, blocks, lost: [text],
   leftOut: [names], fits}] (the cartridges it makes), fit, fits}] (one per card) */
export function studioView(st, req, capacity) {
  const out = view(st, {ticked: [], choices: req.choices, baseId: req.baseId, plan: 'split'}, capacity);
  const list = roms(st), choices = {madeWith: req.choices?.madeWith ?? {}, kitPick: {...st.picks, ...(req.choices?.kitPick ?? {})}};
  const resolved = S.resolveSongs(st.songs, list, st.kitFiles, choices), byId = new Map(resolved.map(r => [r.id, r]));
  const blocks = new Map(st.songs.map(s => [s.id, s]));
  for (const r of resolved) r.blocks = blocks.get(r.id).blocks ??= S.blocksOf(r.song);
  const split = req.mode !== 'new';
  st.studio = new Map();
  out.carts = (req.carts ?? []).map(c => {
    const entries = (c.songIds ?? []).map(id => byId.get(id)).filter(Boolean);
    const home = homeFor(st, list, out.baseId, c, entries.map(e => S.songFormat(e.song)));
    const lsdj = home.rom && {id: home.rom.id, name: home.rom.name, version: S.versionText(home.rom.version), full: !!st.full.get(home.rom.id), auto: home.auto, opensAll: home.opensAll};
    const songs = entries.map(e => ({id: e.id, name: e.name, blocks: e.blocks, format: S.songFormat(e.song), tooNew: !!home.rom && !S.opens(home.rom.format, S.songFormat(e.song))}));
    if (!home.rom || !entries.length) return {id: c.id, lsdj, songs, parts: [], fit: entries.length, fits: true};
    const ctx = contextOf(st, home.rom, capacity), plans = split ? S.planSplit(entries, ctx) : [S.planMost(entries, ctx)];
    st.studio.set(c.id, {plans, ctx, lsdj: home.rom});
    const parts = plans.map(partOf);
    return {id: c.id, lsdj, songs, parts, fit: split ? entries.length : S.fitCount(entries, ctx), fits: parts.every(p => p.fits) && !songs.some(s => s.tooNew)};
  });
  return out;
}

/* "Sort them for me": the songs (ids) planned into as few carts as it takes, per LSDj: -> [{lsdjId, songIds, from}]
   (from: the file all of a cart's songs came from, for its name; null when they came from several) */
export function autoSort(st, req, capacity) {
  const v = view(st, {ticked: req.songIds, choices: req.choices, baseId: req.baseId, plan: 'split'}, capacity);
  const fromOf = new Map(st.songs.map(s => [s.id, s.from]));
  return (st.last?.plans ?? []).map(p => {
    const files = new Set(p.entries.map(e => fromOf.get(e.id)));
    return {lsdjId: p.lsdj.id, songIds: p.entries.map(e => e.id), from: files.size === 1 ? [...files][0] : null};
  }).filter(c => c.songIds.length && v.plans.length);
}

/* the cards of the last studioView, built: ids: which ones; titles: their names. A card that makes several cartridges
   gives each one, numbered ("FRIDAY 1", "FRIDAY 2").
   -> [{id, part, parts, title, rom, sav, lsdj, songs, kits, kib, fits, warnings}] */
export function buildStudio(st, ids, titles = {}) {
  const out = [];
  for (const id of ids) {
    const p = st.studio?.get(id);
    if (!p) continue;
    const name = titles[id] || 'Cart';
    p.plans.forEach((plan, part) => {
      const b = S.buildSet(plan, p.ctx, st.template);
      out.push({id, part, parts: p.plans.length, title: p.plans.length > 1 ? `${name} ${part + 1}` : name, rom: b.rom, sav: b.sav,
        lsdj: S.versionText(p.lsdj.version), songs: b.songs.map(s => s.name), kits: b.kits.length, kib: Math.ceil(b.plan.needed / 1024), fits: b.plan.fits, warnings: b.warnings});
    });
  }
  if (!out.length) throw new SavError('Nothing to build: put some songs in a cartridge, with an LSDj to build it with.');
  return out;
}
