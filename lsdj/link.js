// SPDX-License-Identifier: GPL-3.0-only
// The page's link to the FM-1's running LSDJ Burrito firmware, over USB-MIDI
// SysEx (firmware/lsdj_link.h). Songs, settings, effects, themes and cartridge export: this
// never writes firmware.
//   request  F0 7D 'G' 'S' op [data] F7
//   reply    F0 7D 'G' 'S' op status [data] F7      data bytes as 7-bit pairs
import {logEvent} from './conn-log.js';

export const OP = {INFO: 0x01, READ: 0x02, BEGIN: 0x03, CHUNK: 0x04, COMMIT: 0x05, ABORT: 0x06,
  SETTINGS_GET: 0x10, SETTINGS_SET: 0x11, FX_GET: 0x12, FX_SET: 0x13, THEME_GET: 0x14, THEME_SET: 0x15,
  STORE: 0x16, MIDI_GET: 0x17, MIDI_SET: 0x18, FEAT_GET: 0x19, FEAT_SET: 0x1A, LIVE: 0x20,
  CART_INFO: 0x22, CART_READ: 0x23, MUTE_SET: 0x24, SCREEN_INFO: 0x25, SCREEN_ROW: 0x26,
  SCREEN_SYNC: 0x27, SCREEN_PIXELS: 0x28, SCREEN_FRAME: 0x29, REVERB_GET: 0x2A, REVERB_SET: 0x2B, PAD_SET: 0x2C,
  REVERB_SENDS_GET: 0x2D, REVERB_SENDS_SET: 0x2E, VOLUME_SET: 0x2F, SEQ_SET: 0x30, SONG_ROWS: 0x31, SYNC_SET: 0x32,
  DJ_DECK: 0x33, DJ_KEY: 0x34,
  PRESET_LIST: 0x35, PRESET_GET: 0x36, PRESET_PUT: 0x37, PRESET_LOAD: 0x38, PRESET_SAVE: 0x39};
export const STATUS = ['ok', 'bad request', 'wrong state', 'checksum mismatch', 'flash error'];
export const CHUNK = 128;
export const SAVE_SIZE = 131072;
export const CART_CHUNK = 120;

export function crc32(bytes) {
  let crc = ~0 >>> 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
export const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
export const rd32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
export const rd16 = (b, i) => b[i] | b[i + 1] << 8;

/* Bytes -> the SysEx request (pairs). tag (0.9.98-dev.3, INFO flags bit 1): op + 0x40 and the tag before the data. */
export const TAGGED = 0x40;
export function frame(op, bytes = [], tag = null) {
  const out = tag == null ? [0xF0, 0x7D, 0x47, 0x53, op] : [0xF0, 0x7D, 0x47, 0x53, op | TAGGED, tag & 127];
  for (const b of bytes) out.push(b & 127, b >> 7);
  out.push(0xF7);
  return out;
}
/* A reply -> {op, status, data, tag (tagged replies only)} or null if it is not one of ours. */
export function parse(msg) {
  if (msg.length < 7 || msg[0] !== 0xF0 || msg[1] !== 0x7D || msg[2] !== 0x47 || msg[3] !== 0x53 || msg[msg.length - 1] !== 0xF7) return null;
  const tagged = (msg[4] & TAGGED) !== 0;
  if (tagged && msg.length < 8) return null;
  const pairs = msg.slice(tagged ? 7 : 6, msg.length - 1);
  if (pairs.length % 2) return null;
  const data = new Uint8Array(pairs.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = pairs[2 * i] | (pairs[2 * i + 1] & 1) << 7;
  return tagged ? {op: msg[4] & ~TAGGED, status: msg[5], tag: msg[6], data} : {op: msg[4], status: msg[5], data};
}
/* the FM-1s (by their MIDI output) that said in INFO they take tagged requests; every Link to one tags */
const tagsOn = new WeakMap();

export class LinkError extends Error {}
const LIVE_DRAIN_MS = 1000;   /* after a LIVE timed out: how long the next LIVE waits for the late reply */
const owners = new WeakMap();   /* an input -> the Link listening on it */
/* sets heard while playing (a kill, a knob, the crossfader): sent before reads already waiting, never mid-request */
const URGENT = new Set([OP.FX_SET, OP.REVERB_SET, OP.REVERB_SENDS_SET, OP.MUTE_SET, OP.VOLUME_SET, OP.SEQ_SET, OP.PAD_SET]);

export class Link {
  /* input / output: Web MIDI ports (or anything with onmidimessage / send). */
  constructor(input, output) {
    this.input = input; this.output = output; this.waiting = null; this.jobs = []; this.running = false; this.tag = 0;
    this.onPixels = null;   // FM-1_985: rows the FM-1 sends by itself after SCREEN_SYNC (lsdj/screen.js); FM-1_990: and SCREEN_FRAME
    /* when the FM-1 last sent anything on this link (a reply, screen rows): one reply missed is not a lost FM-1
       while it is still talking (app.js: lost only after HEARD_MS of silence) */
    this.heard = Date.now();
    /* A LIVE timed out (liveLate: when): the protocol has no request numbers, so its reply coming late was taken as
       the answer to the next LIVE, with what was true before. On a busy link the DJ deck then read an old mute
       mask, and a press on top of it muted channels unmuted since (Colin's flaky mutes). Now the next LIVE first
       waits up to LIVE_DRAIN_MS for that late reply, which is dropped. (Only LIVE: a lost request is far more
       common than a late reply, and the reads that are sent again have their own checks: accept.) */
    this.liveLate = 0;
    /* one Link an input: a second one takes the replies from the first, which then times out ("did not answer").
       Said in the connection Log, to find where (the first should be closed before) */
    const owner = owners.get(input);
    if (owner && !owner.closed) {
      const text = `Two links on one FM-1 input (${input.id ?? input.name ?? '?'}): the older one stops hearing replies.`;
      console.warn(text, new Error().stack); logEvent(text);
    }
    owners.set(input, this);
    input.onmidimessage = this.handler = e => {
      const m = e.data;
      if (m[0] === 0xF0 && m[1] === 0x7D && m[2] === 0x47 && m[3] === 0x53) this.heard = Date.now();
      if (m.length > 7 && (m[4] === OP.SCREEN_PIXELS || m[4] === OP.SCREEN_FRAME) && m[0] === 0xF0 && m[1] === 0x7D && m[2] === 0x47 && m[3] === 0x53) {
        this.onPixels?.(m); return;
      }
      /* 0.9.98-dev.4: OP4 / OP5 pressed on the FM-1 while the DJ layout has it on a deck (sent never asked) */
      if (m.length === 9 && m[4] === OP.DJ_KEY && m[0] === 0xF0 && m[1] === 0x7D && m[2] === 0x47 && m[3] === 0x53) {
        this.onDjKey?.(m[6] === 0 ? 'play' : 'stop'); return;
      }
      const r = parse(Array.from(m));
      if (r && r.op === OP.LIVE && r.tag === undefined && this.liveLate && this.waiting?.op !== OP.LIVE) { this.liveLate = 0; return; }   /* the late one */
      if (r && this.waiting && r.op === this.waiting.op && r.tag === this.waiting.tag && (r.status || this.waiting.accept(r))) {
        const w = this.waiting; w.resolve(r);
      }
    };
  }
  /* A request sent at once, past the queue, its reply not waited for: only for a setting that is safe to lose and
     is sent again anyway (the DJ crossfader's VOLUME_SET while it moves: the last one is then confirmed through
     req). Its reply is ignored, or taken by a waiting request of the same op (the same answer). */
  post(op, bytes = []) {
    if (this.closed) return false;
    try { this.output.send(frame(op, bytes)); return true; } catch { return false; }
  }
  close() {
    this.closed = true;
    this.waiting?.reject(new LinkError('Disconnected from the FM-1.'));
    /* (only its own: a newer Link on this input keeps hearing) */
    if (this.input.onmidimessage === this.handler) this.input.onmidimessage = null;
    if (owners.get(this.input) === this) owners.delete(this.input);
  }

  /* One request at a time; resolves {status, data, tries}; rejects on a timeout or bad status.
     The USB link drops about one message in a hundred or more (measured on alpha 55: a request or
     its reply never arrives; a late reply was never seen), so a request that is safe to repeat is
     sent again after a timeout: retries more times. */
  /* this FM-1 takes tagged requests (0.9.98-dev.3): a late reply then carries an old tag and is never taken */
  get tagged() { return tagsOn.get(this.output) === true; }
  req(op, bytes = [], {timeout = 1500, allow = [0], retries = 0, signal, accept = () => true} = {}) {
    const once = () => new Promise((resolve, reject) => {
      if (this.closed) return reject(new LinkError('Disconnected from the FM-1.'));
      if (signal?.aborted) return reject(new LinkError('Cartridge read cancelled.'));
      const tag = this.tagged ? (this.tag = (this.tag + 1) & 127) : undefined;
      const cleanup = () => { clearTimeout(t); this.waiting = null; signal?.removeEventListener('abort', abort); };
      const fail = e => { cleanup(); reject(e); };
      const abort = () => fail(new LinkError('Cartridge read cancelled.'));
      const t = setTimeout(() => { if (op === OP.LIVE && tag === undefined) this.liveLate = Date.now(); fail(new LinkError('The FM-1 did not answer. Is LSDJ Burrito running and the cable connected?', {cause: 'timeout'})); }, timeout);
      this.waiting = {op, tag, accept, reject: fail, resolve: r => {
        cleanup();
        if (!allow.includes(r.status)) reject(new LinkError(`FM-1: ${STATUS[r.status] || 'error ' + r.status}`));
        else resolve(r);
      }};
      signal?.addEventListener('abort', abort, {once: true});
      try { this.output.send(frame(op, bytes, tag ?? null)); } catch (e) { fail(e); }
    });
    const run = async () => {
      if (op === OP.LIVE && !this.tagged && this.liveLate && Date.now() - this.heard < 3000) {   /* the last LIVE's late reply first (dropped when it comes), or give up on it; not when the FM-1 has gone quiet (its loss is noticed as soon as before) */
        while (this.liveLate && Date.now() - this.liveLate < LIVE_DRAIN_MS && !this.closed) await new Promise(r => setTimeout(r, 20));
        this.liveLate = 0;
      }
      for (let tries = 1; ; tries++) {
        try { const r = await once(); r.tries = tries; return r; }
        catch (e) { if (e.cause !== 'timeout' || tries > retries) throw e; this.retried = (this.retried || 0) + 1; }
      }
    };
    return new Promise((resolve, reject) => {
      const job = {run, resolve, reject, urgent: URGENT.has(op)};
      const at = job.urgent ? this.jobs.findIndex(j => !j.urgent) : -1;
      if (at < 0) this.jobs.push(job); else this.jobs.splice(at, 0, job);
      this.pump();
    });
  }
  pump() {
    if (this.running || !this.jobs.length) return;
    const job = this.jobs.shift();
    this.running = true;
    job.run().then(job.resolve, job.reject).finally(() => { this.running = false; this.pump(); });
  }

  async info() {
    const i = infoFrom((await this.req(OP.INFO, [], {retries: 2})).data);
    tagsOn.set(this.output, i.tags);
    return i;
  }
  async cartridgeInfo(signal) {
    const r = await this.req(OP.CART_INFO, [], {retries: 2, allow: [0, 1], signal});
    if (r.status === 1) throw new LinkError('This firmware cannot read back its cartridge. Install FM-1_974 or newer once using your original LSDj ROM, then reconnect. Nothing was prepared.');
    if (r.data.length !== 12) throw new LinkError('Invalid cartridge information from the FM-1.');
    const size = rd32(r.data, 0);
    if (size < 256 + 8 + 1 || size > 256 + 128 * (8 + 16384))   // slot v1: whole banks; v2 (FM-1_991): trimmed, any size
      throw new LinkError('Invalid installed cartridge size.');
    return {size, headerCrc: rd32(r.data, 4), dataCrc: rd32(r.data, 8)};
  }
  async exportCartridge(progress = () => {}, signal) {
    const before = await this.cartridgeInfo(signal), out = new Uint8Array(before.size);
    for (let off = 0; off < out.length; off += CART_CHUNK) {
      const count = Math.min(CART_CHUNK, out.length - off);
      const {data} = await this.req(OP.CART_READ, le32(off), {retries: 4, signal,
        accept: r => r.data.length < 4 || rd32(r.data, 0) === off});
      if (data.length !== 4 + count || rd32(data, 0) !== off) throw new LinkError('Invalid cartridge chunk. Nothing was prepared.');
      out.set(data.subarray(4), off);
      progress(off + count, out.length);
    }
    const after = await this.cartridgeInfo(signal);
    if (before.size !== after.size || before.headerCrc !== after.headerCrc || before.dataCrc !== after.dataCrc ||
        rd32(out, 252) !== before.headerCrc || crc32(out.subarray(0, 252)) !== before.headerCrc ||
        rd32(out, 16) !== before.dataCrc || crc32(out.subarray(256)) !== before.dataCrc)
      throw new LinkError('Installed cartridge changed or failed its transfer checksum. Nothing was prepared.');
    return out;
  }
  /* CHUNK bytes of the save as the FM-1 holds it now, from off (a multiple of CHUNK): a copy, LSDj keeps playing */
  async saveRead(off) { return (await this.req(OP.READ, le32(off), {retries: 2})).data.slice(0, CHUNK); }
  async exportSave(progress = () => {}) {
    const out = new Uint8Array(SAVE_SIZE);
    for (let off = 0; off < SAVE_SIZE; off += CHUNK) {
      const {data} = await this.req(OP.READ, le32(off), {retries: 4});
      out.set(data.slice(0, CHUNK), off);
      progress(off + CHUNK, SAVE_SIZE);
    }
    return out;
  }
  async importSave(bytes, progress = () => {}) {
    if (bytes.length !== SAVE_SIZE) throw new LinkError(`An LSDj save is ${SAVE_SIZE} bytes; this file is ${bytes.length}.`);
    const crc = crc32(bytes);
    await this.req(OP.ABORT, [], {retries: 2});   // an import a closed page left behind: gone first
    // BEGIN stores the current songs first (seconds). Sent again only if nothing came back; then
    // "wrong state" means the first one arrived and the import is open.
    const b = await this.req(OP.BEGIN, [...le32(SAVE_SIZE), ...le32(crc)], {timeout: 20000, retries: 1, allow: [0, 2]});
    if (b.status === 2 && b.tries === 1) throw new LinkError('FM-1: wrong state (an import is already running)');
    try {
      for (let off = 0; off < SAVE_SIZE; off += CHUNK) {   // a chunk sent again is fine (the firmware takes the last one twice)
        await this.req(OP.CHUNK, [...le32(off), ...bytes.slice(off, off + CHUNK)], {retries: 4});
        progress(off + CHUNK, SAVE_SIZE);
      }
      // COMMIT: within the firmware's 5 s import timeout, so a lost one is sent again while the
      // import still waits. "Wrong state" on a resend: the first arrived; INFO's checksum says
      // whether the FM-1 now holds this file (stored) or restored its songs (not stored).
      const c = await this.req(OP.COMMIT, [], {timeout: 4500, retries: 1, allow: [0, 2]});
      if (c.status === 2) {
        if (c.tries === 1) throw new LinkError('FM-1: wrong state (the import was given up)');
        const info = await this.info();
        if (info.importing || info.saveCrc !== crc) throw new LinkError('The import may not have been stored. Export the songs to check what the FM-1 holds.');
      }
    } catch (e) {
      await this.req(OP.ABORT, [], {retries: 2}).catch(() => {});
      throw e;
    }
  }
  // (gets and sets are safe to send again: a set writes the same value twice)
  async settingsGet() { return rd32((await this.req(OP.SETTINGS_GET, [], {retries: 2})).data, 0); }
  async settingsSet(v) { await this.req(OP.SETTINGS_SET, le32(v), {retries: 2}); }
  /* 17 words (alpha 66 and later) or 11 */
  async fxGet() { const {data} = await this.req(OP.FX_GET, [], {retries: 2}); return Array.from({length: data.length >> 2}, (_, i) => rd32(data, 4 * i)); }
  async fxSet(words) { await this.req(OP.FX_SET, words.flatMap(le32), {retries: 2}); }
  async themeGet() { const {data} = await this.req(OP.THEME_GET, [], {retries: 2}); return Array.from({length: 8}, (_, i) => rd16(data, 2 * i)); }
  async themeSet(colors) { await this.req(OP.THEME_SET, colors.flatMap(c => [c & 255, c >> 8]), {retries: 2}); }
  /* the MIDI options word, or null for firmware before alpha 57 */
  async midiGet() { const r = await this.req(OP.MIDI_GET, [], {retries: 2, allow: [0, 1]}); return r.status ? null : rd32(r.data, 0); }
  async midiSet(v) { await this.req(OP.MIDI_SET, le32(v), {retries: 2}); }
  /* the feature switches word (SETTINGS / FX+LIGHTS), or null for firmware before FM-1_979 */
  async featGet() { const r = await this.req(OP.FEAT_GET, [], {retries: 2, allow: [0, 1]}); return r.status ? null : rd32(r.data, 0); }
  async featSet(v) { await this.req(OP.FEAT_SET, le32(v), {retries: 2}); }
  /* 0.9.97 and newer: the reverb word (lsdj/fx-model.js unpackReverb), or null before */
  async reverbGet() { const r = await this.req(OP.REVERB_GET, [], {retries: 2, allow: [0, 1]}); return r.status ? null : rd32(r.data, 0); }
  async reverbSet(v) { await this.req(OP.REVERB_SET, le32(v), {retries: 2}); }
  /* 0.9.97-dev.7 and newer: the reverb sends word (a byte per channel), or null before */
  async reverbSendsGet() { const r = await this.req(OP.REVERB_SENDS_GET, [], {retries: 2, allow: [0, 1]}); return r.status ? null : rd32(r.data, 0); }
  async reverbSendsSet(v) { await this.req(OP.REVERB_SENDS_SET, le32(v), {retries: 2}); }
  /* 0.9.97 and newer: the Game Boy buttons a controller on this page holds (lsdj/gamepad.js); no retries: held
     buttons are sent again anyway */
  async padSet(mask) { await this.req(OP.PAD_SET, [mask & 255], {timeout: 400, retries: 0}); }
  async store() { await this.req(OP.STORE, [], {timeout: 10000, retries: 1}); }
  /* FM-1_977 and newer: the channel mutes (bit per channel) and the echo freeze; live only, never saved */
  async muteSet(mute, freeze) { await this.req(OP.MUTE_SET, [mute & 15, freeze ? 1 : 0], {retries: 2}); }
  /* FM-1_983 and newer: the screen (lsdj/screen.js). {shown, hashes: 18 bands}, or null before */
  async screenInfo() {
    const r = await this.req(OP.SCREEN_INFO, [], {timeout: 800, retries: 1, allow: [0, 1]});
    if (r.status || r.data.length !== 40) return null;
    return {shown: rd32(r.data, 0), hashes: Array.from({length: 18}, (_, b) => rd16(r.data, 4 + 2 * b))};
  }
  /* FM-1_985 and newer, USB: the hashes the page holds (null: unknown) -> {shown, hashes, bands (bit per
     band)}; the FM-1 then sends those bands' rows by itself (onPixels), tagged with round (0..127).
     null: not here (older firmware). push (FM-1_990): and each new picture after it, by
     itself (SCREEN_FRAME, then its rows) for 3 s */
  async screenSync(known, round, push = false) {
    const force = (known.reduce((m, h, b) => h == null ? m | 1 << b : m, 0) | (push ? 1 << 31 : 0)) >>> 0;
    const r = await this.req(OP.SCREEN_SYNC, [...le32(force), ...known.flatMap(h => [(h ?? 0) & 255, (h ?? 0) >> 8]), round & 127],
      {timeout: 800, retries: 1, allow: [0, 1]});
    if (r.status || r.data.length !== 44) return null;
    return {shown: rd32(r.data, 0), hashes: Array.from({length: 18}, (_, b) => rd16(r.data, 4 + 2 * b)), bands: rd32(r.data, 40)};
  }
  /* one row's data (lsdj/screen.js decodeRow), or null if it has more than 16 colours */
  async screenRow(y) {
    const r = await this.req(OP.SCREEN_ROW, [y], {timeout: 800, retries: 1, allow: [0, 2], accept: r => r.data[0] === y});
    return r.status ? null : r.data;
  }
  async live() {
    const {data: d} = await this.req(OP.LIVE, [], {timeout: 1500});   /* (a busy DJ link answers late: a timeout drops its late reply) */
    const words = d.length >= 7 + 4 * 17 ? 17 : 11;   // 11 before alpha 66; FM-1_979: a battery byte after them
    const l = {page: d[0], cursor: d[1], bpm: rd16(d, 2), mute: d[4], freeze: d[5], playing: d[6],
               fx: Array.from({length: words}, (_, i) => rd32(d, 7 + 4 * i)), battery: battery(d[7 + 4 * words])};
    return Object.assign(l, liveDj(d.slice(8 + 4 * words)));
  }
  /* 0.9.98 (the DJ layout): false before (status 1), or when this FM-1 doesn't know LSDj's addresses */
  async volumeSet(level) {   /* 0..127, times the MASTER knob; not saved */
    return !(await this.req(OP.VOLUME_SET, [Math.max(0, Math.min(127, Math.round(level)))], {retries: 1, allow: [0, 1]})).status;
  }
  async seqSet(live) { return !(await this.req(OP.SEQ_SET, [live ? 1 : 0], {retries: 2, allow: [0, 1]})).status; }
  /* 0.9.98-dev.2: LSDj's PROJECT › SYNC set to 'keybd' or 'midi' (kept in the song). 'ok'; 'playing' (LSDj plays:
     only while stopped); 'no' (older firmware, or an LSDj whose addresses this FM-1 doesn't know) */
  async syncSet(sync) {
    const v = {keybd: 5, midi: 3}[sync];
    if (v == null) throw Error(`SYNC ${sync}: KEYBD or MIDI only`);
    const s = (await this.req(OP.SYNC_SET, [v], {retries: 2, allow: [0, 1, 2]})).status;
    return s === 0 ? 'ok' : s === 2 ? 'playing' : 'no';
  }
  /* 0.9.98-dev.4: this FM-1's deck for its OP4 (Play) / OP5 (Stop) keys and their lights: 'stopped', 'waiting' (for the
     bar), 'playing', or 'detach'. Sent every poll; the FM-1 lets go 3 s after the last one. false before (status 1).
     The keys come back through onDjKey('play' | 'stop'). */
  async djDeck(state) {
    const v = {detach: 0, stopped: 1, waiting: 2, playing: 3}[state];
    if (v == null) throw Error(`DJ deck ${state}?`);
    return !(await this.req(OP.DJ_DECK, [v], {timeout: 400, retries: 0, allow: [0, 1]})).status;
  }
  /* the same, not waited for (the page closing: no time for a reply) */
  djDetach() { return this.post(OP.DJ_DECK, [0]); }
  /* 0.9.98-dev.6, the presets (firmware/lsdj_presets.h, lsdj/presets.js); INFO's presets says the FM-1 has them.
     The list: {current (0..7, null none), names: [8, null = empty]} */
  async presetList() {
    const d = (await this.req(OP.PRESET_LIST, [], {retries: 2})).data;
    if (d.length !== 1 + 8 * 13) throw new LinkError('Invalid presets list from the FM-1.');
    return {current: d[0] < 8 ? d[0] : null,
      names: Array.from({length: 8}, (_, i) => d[1 + 13 * i] ? String.fromCharCode(...d.slice(2 + 13 * i, 14 + 13 * i)).replace(/\0.*$/, '').trim() : null)};
  }
  /* a slot's 128 bytes */
  async presetGet(i) {
    const d = (await this.req(OP.PRESET_GET, [i], {retries: 2, accept: r => r.status || r.data.length === 128})).data;
    if (d.length !== 128) throw new LinkError('Invalid preset from the FM-1.');
    return Uint8Array.from(d);
  }
  /* 128 bytes into slot i (zeros: empty it); false if the FM-1 refuses them (a value out of range) */
  async presetPut(i, bytes) { return !(await this.req(OP.PRESET_PUT, [i, ...bytes], {timeout: 2500, retries: 1, allow: [0, 1]})).status; }
  /* load slot i as EDIT + its key does: 'ok', or 'empty' */
  async presetLoad(i) { return (await this.req(OP.PRESET_LOAD, [i], {retries: 1, allow: [0, 2]})).status ? 'empty' : 'ok'; }
  /* everything now into slot i, with this name (12 characters; none: keep the slot's) */
  async presetSave(i, name) {
    const n = name == null ? [] : [...String(name).padEnd(12, ' ').slice(0, 12)].map(c => c.charCodeAt(0) & 127);
    await this.req(OP.PRESET_SAVE, [i, ...n], {timeout: 2500, retries: 1});
  }
  /* 16 song rows from row (each: 4 chains, null empty), or null */
  async songRows(row) {
    const r = await this.req(OP.SONG_ROWS, [row & 255], {retries: 2, allow: [0, 1], accept: r => r.status || r.data[0] === (row & 255)});
    if (r.status || r.data.length !== 65) return null;
    return Array.from({length: 16}, (_, i) => [...r.data.slice(1 + 4 * i, 5 + 4 * i)].map(c => c === 0xFF ? null : c));
  }
}

/* LIVE's 0.9.98 bytes after the battery (none before): {rows, songRows (per channel), sync ('off' | 'lsdj' |
   'midi' | 'keybd'), live (SEQ live mode), level (page volume)}; unknown: null */
const SYNCS = {0: 'off', 1: 'lsdj', 3: 'midi', 5: 'keybd'};
export function liveDj(e) {
  if (e.length < 11) return {rows: null, songRows: null, sync: null, live: null, level: null};
  const k = b => b === 0xFF ? null : b;
  return {rows: [...e.slice(0, 4)].map(k), songRows: [...e.slice(4, 8)].map(k), sync: SYNCS[e[8]] ?? null,
          live: e[9] === 0xFF ? null : !!e[9], level: k(e[10])};
}

/* LIVE's battery byte: 0..3 bars of 3, +0x80 on USB power; 0xFF (or none: before FM-1_979) unknown */
export function battery(b) {
  if (b === undefined || b === 0xFF || (b & 0x7F) > 3) return null;
  return {bars: b & 3, usb: !!(b & 0x80)};
}

/* INFO's reply -> {protocol, firmware, title, ...} */
export function infoFrom(d) {
  const str = (a, b) => String.fromCharCode(...d.slice(a, b)).replace(/\0.*$/, '');
  return {protocol: d[0], firmware: str(1, 9), title: str(9, 25), saveSize: rd32(d, 25), saveCrc: rd32(d, 29), importing: d[33], liveKnown: !!(d[34] & 1), tags: !!(d[34] & 2),
    presets: !!(d[34] & 8)};   /* 0.9.98-dev.6: PRESET_* */
}

/* An FM-1 known again on new ports (Windows numbers them again when it comes back, and its port name can change:
   "Felucca", "3 - Felucca"): among these candidates, the one whose INFO (infoOf(x) -> {title, firmware, saveCrc})
   says what `info` said, the songs' checksum deciding between two of the same; else null (the user chooses). */
export function sameFm1(list, info, infoOf = x => x) {
  if (!info) return null;
  const same = list.filter(x => infoOf(x)?.title === info.title && infoOf(x)?.firmware === info.firmware);
  if (same.length <= 1) return same[0] || null;
  const crc = same.filter(x => infoOf(x).saveCrc === info.saveCrc);
  return crc.length === 1 ? crc[0] : null;
}

/* Web MIDI: the FM-1's ports (its USB name is Felucca), or every port to choose from. */
const isFm1Port = p => p.state !== 'disconnected' && /felucca|fm-?1|h.gelton/i.test(`${p.name} ${p.manufacturer}`);
export async function midiPorts() {
  if (!navigator.requestMIDIAccess) throw new LinkError('This browser has no Web MIDI. Use Chrome or Edge.');
  const access = await navigator.requestMIDIAccess({sysex: true});
  const ins = [...access.inputs.values()], outs = [...access.outputs.values()];
  return {access, ins, outs, input: ins.find(isFm1Port), output: outs.find(isFm1Port)};
}
/* Every FM-1 plugged in with LSDJ Burrito running: [{input, output, name, info}]. Two FM-1s may have the same
   port name, so each output is asked INFO in turn and the input that answers is its pair. known: FM-1s already
   connected ({input, output, name, info}): listed as they are, never asked (their link owns their input). */
export async function findFm1s(access, {known = [], wait = 500} = {}) {
  const ins = [...access.inputs.values()].filter(isFm1Port), outs = [...access.outputs.values()].filter(isFm1Port);
  const found = known.filter(k => ins.includes(k.input) && outs.includes(k.output));
  const used = new Set(found.flatMap(k => [k.input, k.output]));
  for (const output of outs) {
    if (used.has(output)) continue;
    const free = ins.filter(i => !used.has(i));
    if (!free.length) break;
    let hit = null;
    const before = free.map(i => i.onmidimessage);
    const ours = free.map(input => input.onmidimessage = e => {
      const r = parse(Array.from(e.data));
      if (!hit && r && r.op === OP.INFO && r.status === 0 && r.data.length >= 35) hit = {input, info: infoFrom(r.data)};
    });
    try {
      for (let tries = 0; tries < 2 && !hit; tries++) {   /* (the link drops a message now and then: ask twice) */
        try { output.send(frame(OP.INFO)); } catch { break; }
        for (const end = Date.now() + wait / 2; !hit && Date.now() < end;) await new Promise(r => setTimeout(r, 15));
      }
    /* (put back only where nothing took the input meanwhile: a Link made during the probe keeps its own) */
    } finally { free.forEach((i, n) => { if (i.onmidimessage === ours[n]) i.onmidimessage = before[n]; }); }
    if (hit?.info.protocol === 1) { tagsOn.set(output, hit.info.tags); found.push({input: hit.input, output, name: output.name, info: hit.info}); used.add(hit.input); used.add(output); }
  }
  return found;
}
