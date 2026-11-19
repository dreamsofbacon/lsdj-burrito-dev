// SPDX-License-Identifier: GPL-3.0-only
// Song backups: before songs are sent to an FM-1 (Songs and kits, My FM-1's import, a DJ crate load), the songs it
// holds then are read and kept in this browser's library (kit-library.js, kind 'backup'), the last KEEP per FM-1.
// The FM-1 keeps its old songs only until the new ones are stored; after that, songs that were never saved
// anywhere else were gone (the cartridge plan, phase 1). Songs already kept here (a backup or a crate card with
// the same checksum) are not read again.
import {libraryFiles, addToLibrary, removeFromLibrary} from './kit-library.js';
import {crc32} from './lsdj-rom.js';

export const KEEP = 5;
/* the checksum kept with a file when it was added (a backup, a crate card): never worked out here, where 128 KiB a
   file across a whole crate held the page up during a DJ load (deck B's clock) */
const crcOf = f => f.crc;

/* the backups, newest first: [{id, name, fm1, title, at, bytes}] */
export async function backups() {
  return (await libraryFiles()).filter(f => f.kind === 'backup').sort((a, b) => b.at - a.at);
}
/* only the newest KEEP of that FM-1's backups stay */
export async function prune(fm1) {
  const mine = (await backups()).filter(f => f.fm1 === fm1);
  for (const f of mine.slice(KEEP)) await removeFromLibrary(f.id);
}
/* link: that FM-1's; fm1: its name ("FM-1 2"); quickOnly: only if it reads its songs in seconds (READ_STREAM,
   0.9.98-dev.14: a DJ load is not held up by a slow read). -> the backup made, or null (already kept, or skipped:
   said through log). Throws if the read fails: the caller then sends nothing. */
export async function backupSongs(link, fm1, {quickOnly = false, log = () => {}, progress} = {}) {
  const info = await link.info();
  if (info.importing) return null;
  if (quickOnly && !info.stream) {
    log(`${fm1}: its songs were not backed up first (its firmware reads them slowly: 0.9.98-dev.14 or newer backs them up in seconds).`);
    return null;
  }
  const have = (await libraryFiles()).find(f => (f.kind === 'backup' || f.kind === 'sav') && f.bytes?.length === info.saveSize && crcOf(f) === info.saveCrc);
  if (have) { log(`${fm1}: its songs are already kept in this browser (${have.name}).`); return null; }
  const bytes = await link.exportSave(progress);
  const at = Date.now(), title = (info.title || '').replace(/\0.*$/, '');
  const name = `${fm1} · ${title || 'LSDj'} · ${new Date(at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}`;
  const e = await addToLibrary('backup', name, bytes, {fm1, at, title, crc: crc32(bytes)});
  await prune(fm1);
  log(`${fm1}: its songs backed up before new ones were sent (${name}).`);
  return e;
}
