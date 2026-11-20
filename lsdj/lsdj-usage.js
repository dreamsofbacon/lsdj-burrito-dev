// SPDX-License-Identifier: GPL-3.0-only
// Which kit samples a song plays. Pure: no DOM. A song is LSDj's 0x8000 bytes (lsdj-sav.js).
// The song table (0x1290, row*4 + channel) names chains; a chain (0x2080, 16 steps) names phrases, with a
// transpose each (0x2880); a phrase step has a note (0x0000), an instrument (0x7000; FF = keep the last one
// on the channel). Instruments: 0x3080, 16 bytes; byte 0 = 2 for KIT; KIT1 = byte 2 & 3F, KIT2 = byte 9 & 3F;
// byte 6 bit 5 = table on, bits 0-3 = the table (transposes at 0x3480, 16 steps).
// A kit note plays two samples at once (checked in LSDj 9.3.9's phrase screen): the high digit is KIT1's
// sample + 1, the low digit KIT2's sample + 1, 0 = none (0x43: KIT1 sample 3 with KIT2 sample 2).
// "maybe": a note that a chain transpose or the instrument's table may move to another sample (not
// worked out: the sample the song would play is not certain).
import {parseSav, songBytes} from './lsdj-sav.js';
import {kitSlots} from './lsdj-kit.js';

const SONG = 0x1290, CHAIN_PHRASES = 0x2080, CHAIN_TRANSPOSES = 0x2880, PHRASE_INSTR = 0x7000;
const INSTR = 0x3080, INSTR_NAMES = 0x1e7a, TABLE_TRANSPOSES = 0x3480;
const KIT = 2;
const instrName = (song, i) => String.fromCharCode(...song.subarray(INSTR_NAMES + i * 5, INSTR_NAMES + i * 5 + 5))
  .replace(/\0.*$/, '').replace(/[^\x20-\x7e]/g, '?').trimEnd();

function tableMoves(song, ins) {
  const b6 = song[INSTR + ins * 16 + 6];
  if (!(b6 & 0x20)) return false;
  const t = b6 & 0x0f;
  for (let k = 0; k < 16; k++) if (song[TABLE_TRANSPOSES + t * 16 + k]) return true;
  return false;
}

/* song -> {kits: Map kitNumber -> {samples: Set, maybe: Set, instruments: Set of 'NN NAME'}, kitInstruments: [..]} */
export function kitUsage(song) {
  const kits = new Map();
  const kitOf = n => { if (!kits.has(n)) kits.set(n, {samples: new Set(), maybe: new Set(), instruments: new Set()}); return kits.get(n); };
  const isKit = i => i < 64 && song[INSTR + i * 16] === KIT;
  const label = i => i.toString(16).toUpperCase().padStart(2, '0') + (instrName(song, i) ? ' ' + instrName(song, i) : '');
  const kitInstruments = [];
  for (let i = 0; i < 64; i++) if (song[0x2040 + i] && isKit(i))
    kitInstruments.push({instrument: i, label: label(i), kit1: song[INSTR + i * 16 + 2] & 0x3f, kit2: song[INSTR + i * 16 + 9] & 0x3f});
  for (let ch = 0; ch < 4; ch++) {
    let last = -1;
    for (let row = 0; row < 256; row++) {
      const chain = song[SONG + row * 4 + ch];
      if (chain >= 0x80) continue;
      for (let st = 0; st < 16; st++) {
        const ph = song[CHAIN_PHRASES + chain * 16 + st];
        if (ph === 0xff) continue;
        const transposed = song[CHAIN_TRANSPOSES + chain * 16 + st] !== 0;
        for (let k = 0; k < 16; k++) {
          const at = ph * 16 + k, ins = song[PHRASE_INSTR + at], note = song[at];
          if (ins < 64) last = ins;
          if (!note || last < 0 || !isKit(last)) continue;
          const unsure = transposed || tableMoves(song, last);
          const kit1 = song[INSTR + last * 16 + 2] & 0x3f, kit2 = song[INSTR + last * 16 + 9] & 0x3f;
          for (const [kit, s] of [[kit1, (note >> 4) - 1], [kit2, (note & 15) - 1]]) {
            if (s < 0) continue;
            const u = kitOf(kit);
            u.instruments.add(label(last));
            (unsure ? u.maybe : u.samples).add(s);
          }
        }
      }
    }
  }
  for (const u of kits.values()) for (const s of u.samples) u.maybe.delete(s);
  return {kits, kitInstruments};
}

/* songs [{name, song}] -> Map kitNumber -> Map sample -> {songs: Set, maybe: Set} (a song in maybe only when
   no note certainly plays that sample). */
export function usageAcross(songs) {
  const out = new Map();
  for (const {name, song} of songs) {
    const {kits} = kitUsage(song);
    for (const [kit, u] of kits) {
      if (!out.has(kit)) out.set(kit, new Map());
      const m = out.get(kit);
      const add = (s, sure) => {
        if (!m.has(s)) m.set(s, {songs: new Set(), maybe: new Set()});
        const e = m.get(s);
        if (sure) { e.songs.add(name); e.maybe.delete(name); } else if (!e.songs.has(name)) e.maybe.add(name);
      };
      for (const s of u.samples) add(s, true);
      for (const s of u.maybe) add(s, false);
    }
  }
  return out;
}

/* How well an LSDj's kits (lsdj-kit.js kitSlots) fit what songs play (usageAcross): every sample a song certainly
   plays should be there. -> {missing: [{kit, sample, why: 'no kit' | 'empty' | 'no sample', songs}], played, ok}.
   Songs made with another LSDj (other kits, or kits in another order) show up as missing samples. */
export function romFit(slots, usage) {
  const missing = [];
  let played = 0;
  for (const [kit, m] of usage) for (const [sample, e] of m) {
    if (!e.songs.size) continue;
    played++;
    const s = slots[kit];
    const why = !s ? 'no kit' : s.empty ? 'empty' : !s.kit.samples.some(x => x.index === sample) ? 'no sample' : null;
    if (why) missing.push({kit, sample, why, songs: [...e.songs]});
  }
  /* kits: a kit the songs play that this LSDj doesn't have (made with another LSDj); empty: notes on a sample slot
     the kit leaves empty (LSDj shows OFF and plays nothing there too: not a sign of another LSDj) */
  const kits = missing.filter(m => m.why !== 'no sample'), empty = missing.filter(m => m.why === 'no sample');
  return {missing, kits, empty, played, ok: !kits.length};
}
/* the best fit of several LSDj ROMs: [{name, slots, ...}] -> {best, fits} (fewest missing kits, then samples) */
export function bestRom(roms, usage) {
  const fits = roms.map(r => ({...r, fit: romFit(r.slots, usage)}))
    .sort((a, b) => a.fit.kits.length - b.fit.kits.length || a.fit.empty.length - b.fit.empty.length);
  return {best: fits[0] ?? null, fits};
}

/* Before songs alone go to an FM-1 (Save › Import a .sav…): a .sav holds no samples, a song names kits by number,
   so each plays whatever kit the FM-1's LSDj has at that number (Colin: imported songs played other samples).
   songs: [{name, song}]; slots: the FM-1's kit slots (lsdj-kit.js kitSlots, the kits not installed as empty);
   others: [{name, slots}] the user's LSDj files. A wrong kit can't always be told (another kit of that number with
   samples enough); what can: a kit the songs play that is empty or missing there, or samples past its last one.
   -> {problems: [{kit, why: 'no kit' | 'empty' | 'short', last, samples, songs}], fits: [names of others with none]} */
const kitProblems = (slots, usage) => {
  const out = [];
  for (const [kit, m] of usage) {
    const sure = [...m].filter(([, e]) => e.songs.size), songs = [...new Set(sure.flatMap(([, e]) => [...e.songs]))];
    if (!sure.length) continue;
    const s = slots[kit], last = s && !s.empty ? Math.max(-1, ...s.kit.samples.map(x => x.index)) : -1;
    const past = sure.filter(([i]) => i > last).map(([i]) => i).sort((a, b) => a - b);
    const why = !s ? 'no kit' : s.empty ? 'empty' : past.length ? 'short' : null;
    if (why) out.push({kit, why, last, samples: past, songs});
  }
  return out.sort((a, b) => a.kit - b.kit);
};
export function savKitCheck(songs, slots, others = []) {
  const usage = usageAcross(songs);
  return {problems: kitProblems(slots, usage), fits: others.filter(o => !kitProblems(o.slots, usage).length).map(o => o.name)};
}
/* the same for a whole .sav (its open song and saved songs) in words. fm1: {name, bytes (its LSDj), kits (the banks
   installed: lsdj-rom.js, the rest read as empty)}; others: [{name, bytes}]. -> {ask: a question before sending, or
   null when every kit is there; note: for the status line} */
export function savKitReport(sav, fm1, others = []) {
  const s = parseSav(sav), songs = [], open = s.songs.find(x => x.slot === s.active);
  songs.push({name: open?.name || 'the open song', song: s.working});
  for (const x of s.songs) if (x !== open) try { songs.push({name: x.name || '(no name)', song: songBytes(s, x.slot)}); } catch { /* unreadable: skipped */ }
  const slots = kitSlots(fm1.bytes).map(k => !k.empty && fm1.kits && !fm1.kits.includes(k.bank) ? {...k, empty: true, kit: null} : k);
  const {problems, fits} = savKitCheck(songs, slots, others.map(o => ({name: o.name, slots: kitSlots(o.bytes)})));
  if (!problems.length) return {ask: null, note: ` Every kit its songs play is on the FM-1 (${fm1.name}).`};
  const hx = n => n.toString(16).toUpperCase().padStart(2, '0');
  const few = n => n.length > 4 ? `${n.slice(0, 4).join(', ')} and ${n.length - 4} more` : n.join(', ');
  const lines = problems.map(p => p.why === 'short'
    ? `• kit ${hx(p.kit)} ${slots[p.kit].kit.name} has ${p.last + 1} sample${p.last ? 's' : ''}; they play more: ${few(p.songs)}`
    : `• kit ${hx(p.kit)} ${p.why === 'empty' ? 'is empty' : "isn't"} on it: ${few(p.songs)}`);
  const fix = fits.length
    ? `${fits[0]} (one of your LSDj files) has every kit they play: in the DJ crate, add the .sav and choose it, then load the card to send the LSDj and songs together.`
    : 'A .sav holds no samples: the songs need the LSDj (with its kits) they were made with. In the DJ crate, add the .sav with that LSDj to send them together.';
  return {ask: `These songs were likely made with other kits than the FM-1's LSDj (${fm1.name}) has, so some notes will play other samples or none:\n${lines.join('\n')}\n\n${fix}\n\nSend the songs anyway?`,
    note: ` Some songs play kits the FM-1's LSDj (${fm1.name}) doesn't have${fits.length ? `; ${fits[0]} has them` : ''}.`};
}
