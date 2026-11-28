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
  PRESET_LIST: 0x35, PRESET_GET: 0x36, PRESET_PUT: 0x37, PRESET_LOAD: 0x38, PRESET_SAVE: 0x39,
  READ_STREAM: 0x3A, STREAM_DATA: 0x3B, IDENTIFY: 0x3C, RESTART: 0x3D, LAST_RESTART: 0x3F};
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
      /* 0.9.98-dev.14: the songs or the LSDj slot streamed after READ_STREAM (readStream) */
      if (m.length > 16 && m[4] === OP.STREAM_DATA && m[0] === 0xF0 && m[1] === 0x7D && m[2] === 0x47 && m[3] === 0x53) {
        this.onStream?.(m); return;
      }
      /* 0.9.98-dev.4: OP4 / OP5 pressed on the FM-1 while the DJ layout has it on a deck (sent never asked) */
      if (m.length === 9 && m[4] === OP.DJ_KEY && m[0] === 0xF0 && m[1] === 0x7D && m[2] === 0x47 && m[3] === 0x53) {
        this.onDjKey?.(m[6] === 0 ? 'play' : 'stop'); return;
      }
      const r = parse(Array.from(m));
      if (r && r.op === OP.CHUNK && r.tag !== undefined && this.chunkAck) { this.chunkAck(r); return; }   /* sendChunks */
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
    const before = await this.cartridgeInfo(signal);
    const streamed = (await this.info().catch(() => null))?.stream ? await this.readStream(1, before.size, progress, signal) : null;
    const out = streamed || new Uint8Array(before.size);
    for (let off = 0; !streamed && off < out.length; off += CART_CHUNK) {
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
  /* READ_STREAM (0.9.98-dev.14, INFO stream): what (0 the songs, 1 the LSDj slot) whole, total bytes, sent by the FM-1
     by itself as STREAM_DATA messages (firmware/lsdj_stream.h): 112 bytes each, 8 sent for 7, from its USB interrupt.
     A grab read 128 bytes a request before (~1m45s for songs and LSDj). Missing parts are asked for again (a few
     rounds); null if some still are (the caller reads the old way). */
  async readStream(what, total, progress = () => {}, signal) {
    const N = 112, out = new Uint8Array(total), have = new Uint8Array(Math.ceil(total / N));
    let got = 0, last = Date.now();
    this.onStream = m => {
      if (m[5] !== 0 || m[6] !== what) return;
      let off = 0;
      for (let b = 0; b < 4; b++) off += (m[7 + 2 * b] | m[8 + 2 * b] << 7) * 2 ** (8 * b);
      if (off % N || off >= total) return;
      let k = 15, at = off;
      while (k < m.length - 1 && at < total) {
        const h = m[k++];
        for (let i = 0; i < 7 && k < m.length - 1 && at < total; i++) out[at++] = m[k++] | ((h >> i) & 1) << 7;
      }
      const c = off / N;
      if (!have[c] && at === Math.min(total, off + N)) { have[c] = 1; got += at - off; progress(got, total); }
      last = Date.now();
    };
    const missing = () => {
      const r = [];
      for (let c = 0; c < have.length; c++) if (!have[c]) {
        const a = c * N, b = Math.min(total, a + N);
        if (r.length && r[r.length - 1][1] === a) r[r.length - 1][1] = b; else r.push([a, b]);
      }
      return r;
    };
    try {
      for (let round = 0; round < 4 && got < total; round++) {
        for (const [a, b] of missing().slice(0, 16)) {
          if (signal?.aborted) throw new LinkError('Stopped.');
          last = Date.now();
          await this.req(OP.READ_STREAM, [what, ...le32(a), ...le32(b - a)], {retries: 2, signal});
          const done = () => { for (let c = a / N; c * N < b; c++) if (!have[c]) return false; return true; };
          while (!done() && Date.now() - last < 1000) await new Promise(r => setTimeout(r, 20));
        }
      }
    } finally {
      this.onStream = null;
      if (got < total) await this.req(OP.READ_STREAM, [what, 0, 0, 0, 0, 0, 0, 0, 0], {retries: 1}).catch(() => {});   /* (stopped) */
    }
    return got === total ? out : null;
  }
  /* CHUNK bytes of the save as the FM-1 holds it now, from off (a multiple of CHUNK): a copy, LSDj keeps playing */
  async saveRead(off) { return (await this.req(OP.READ, le32(off), {retries: 2})).data.slice(0, CHUNK); }
  async exportSave(progress = () => {}) {
    /* 0.9.98-dev.14: streamed, and kept only if it is what the FM-1 holds (INFO's checksum: LSDj may change its
       working song meanwhile; then read as before) */
    if ((await this.info().catch(() => null))?.stream) {
      const s = await this.readStream(0, SAVE_SIZE, progress);
      if (s && crc32(s) === (await this.info()).saveCrc) return s;
    }
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
      if (this.tagged && this.output) await this.sendChunks(bytes, progress);
      else for (let off = 0; off < SAVE_SIZE; off += CHUNK) {   // a chunk sent again is fine (the firmware takes the last one twice)
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
  /* A save's 1024 CHUNKs, several on the way at once (Colin, 2026-11-27: "why does sending a sav take so long?";
     one at a time, each waited for its reply, the time was all round trips through Web MIDI and Windows' USB MIDI).
     Tagged firmware only (each reply says which request it answers). The FM-1 holds one incoming SysEx at a time
     (felucca usb.c sx_frame): one that comes in before the last is handled is dropped. That is safe: the firmware
     takes CHUNKs in order only (BAD for any other offset, nothing changed), and the last one again is fine. So the
     window grows while every reply is OK, halves at a loss, and the send goes back to the first chunk not yet
     answered (go-back-N). BAD replies to chunks sent before that go-back are old news, ignored. One job on the queue:
     nothing else goes to this FM-1 meanwhile. The connection Log says how long it took and the chunks sent again. */
  sendChunks(bytes, progress = () => {}) {
    const run = () => new Promise((resolve, reject) => {
      const t0 = Date.now(), tags = new Map();   /* tag -> {off, epoch}: every chunk sent and not yet answered */
      let base = 0, at = 0, win = 4, epoch = 0, out = 0, sent = 0, losses = 0, last = Date.now(), moved = last, timer = null, rtt = 100, cap = 64, over = false;
      const done = e => {
        if (over) return; over = true; clearInterval(timer); this.chunkAck = null;
        if (e) return reject(e);
        logEvent(`Songs sent in ${((Date.now() - t0) / 1000).toFixed(1)} s (${sent - SAVE_SIZE / CHUNK} pieces sent again, ${losses} losses, window up to ${Math.floor(this.chunkWinMax)}).`);
        resolve();
      };
      /* back to the first chunk not answered. Chunks sent before stay in tags: an OK from one still moves base on */
      const rewind = () => {
        epoch++; out = 0; at = base; win = Math.max(1, win / 2); last = Date.now();
        if (losses >= 16 && losses * 4 > base / CHUNK) cap = win = 1;   /* lost too often: one at a time, as before */
        if (++losses > 4000) done(new LinkError('Too many pieces lost on the way to the FM-1.'));
      };
      const fill = () => {
        if (over) return;
        if (this.closed) return done(new LinkError('Disconnected from the FM-1.'));
        while (at < SAVE_SIZE && out < Math.floor(win)) {
          const tag = this.tag = (this.tag + 1) & 127, off = at;
          tags.set(tag, {off, epoch, t: Date.now()});
          at += CHUNK; sent++; out++;   /* (before the send: a simulated FM-1 may answer inside it) */
          try { this.output.send(frame(OP.CHUNK, [...le32(off), ...bytes.subarray(off, off + CHUNK)], tag)); }
          catch (e) { return done(e); }
        }
      };
      this.chunkWinMax = win;
      this.chunkAck = r => {
        const q = tags.get(r.tag);
        if (!q) return;
        tags.delete(r.tag);
        if (q.epoch === epoch) out--;
        if (r.status === 0) {
          if (q.off + CHUNK > base) {
            base = q.off + CHUNK; last = moved = Date.now(); rtt += (last - q.t - rtt) / 8;
            win = Math.min(cap, win + 1 / win); this.chunkWinMax = Math.max(this.chunkWinMax, win);
            progress(base, SAVE_SIZE);
          }
          if (base >= SAVE_SIZE) return done();
          if (at < base) { at = base; epoch++; out = 0; }   /* (an OK from before a go-back: ahead of it) */
        } else if (r.status === 1) {
          /* BAD for base itself: the FM-1 is past base + 1 chunk (it takes base, or base's last chunk again), so base
             was stored and its OK lost; step on. Any other BAD: a chunk lost before it, go back (once per go-back) */
          if (q.off === base) { base += CHUNK; moved = Date.now(); progress(base, SAVE_SIZE); rewind(); }
          else if (q.epoch === epoch) rewind();
        } else return done(new LinkError(`FM-1: ${STATUS[r.status] || 'error ' + r.status}`));
        fill();
      };
      /* nothing back for a while (4 round trips, 60..400 ms): a request or its reply lost (the last ones have no later
         chunk to show it). Too soon is harmless: the chunks again, BAD for those the FM-1 has. No progress for 4 s: given
         up (the FM-1 gives up an import after 5 s of nothing) */
      timer = setInterval(() => {
        if (Date.now() - last < Math.min(400, Math.max(60, 4 * rtt + 20))) return;
        if (Date.now() - moved > 4000) return done(new LinkError('The FM-1 did not answer. Is LSDJ Burrito running and the cable connected?', {cause: 'timeout'}));
        rewind(); fill();
      }, 20);
      fill();
    });
    return new Promise((resolve, reject) => {
      this.jobs.push({run, resolve, reject, urgent: false});
      this.pump();
    });
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
  /* 0.9.98-dev.19: this FM-1's number (1..99) big over its whole screen for seconds (1..60; 0 takes it away), so the
     one on the desk can be told from the others (Install asks which). false before (status 1). */
  async identify(number, seconds) {
    if (!Number.isInteger(number) || number < 1 || number > 99 || !Number.isInteger(seconds) || seconds < 0 || seconds > 60)
      throw Error(`IDENTIFY ${number} for ${seconds} s?`);
    return !(await this.req(OP.IDENTIFY, [number, seconds], {timeout: 600, retries: 1, allow: [0, 1]})).status;
  }
  /* 0.9.98-dev.19: why this FM-1's last run ended -> {why: 'crash' | 'watchdog' | null (power on, an install, a
     planned restart), crash: {count, vec, pc, rets, emu, dbg, sp, uptimeMs, early} or null, p3, rst}; null before
     (status 1). Read only. (Colin's FM-1 restarted during DJ use and came back on CPU0, R0, with nothing saying why.) */
  /* 0.9.98-dev.22: the last unplanned restart, kept in the FM-1's save store so it outlasts a power-off (RESTART's
     record is in RAM and goes with it): {kind 'crash' | 'watchdog' | 'hang', count, p33, pc, rets, uptimeMs, vec, p3,
     passes, build}, or null (none kept; older firmware). Read only. (Colin's FM-1 crashed on dev.21 on stage and was
     switched off and on: nothing was left to say where.) */
  async lastRestart() {
    const r = await this.req(OP.LAST_RESTART, [], {timeout: 600, retries: 1, allow: [0, 1]});
    if (r.status) return null;
    if (r.data.length !== 24) throw new LinkError('Invalid kept restart from the FM-1.');
    const w = Array.from({length: 6}, (_, i) => rd32(r.data, 4 * i));
    const v = w[0] >>> 24;
    if (v !== 0x52 && v !== 0x53) return null;
    const o = {kind: [null, 'crash', 'watchdog', 'hang'][w[0] >> 16 & 255] ?? null, count: w[0] & 255, p33: w[0] >> 8 & 255,
      pc: w[1], rets: w[2], uptimeMs: w[3], vec: w[4] & 255, p3: w[4] >> 8 & 255, passes: w[4] >>> 16, build: w[5], load: null};
    /* (0.9.98-dev.23, a hang: 0x53, its load packed in words 2 and 3; the uptime in whole seconds) */
    if (v === 0x53) {
      o.rets = w[2] & 0xFFF; o.uptimeMs = (w[3] & 0x3FFFF) * 1000;
      o.load = {share: (w[2] >>> 12 & 1023) / 10, ring: w[2] >>> 22 & 127, rxPend: !!(w[2] >>> 29 & 1), overflow: !!(w[2] >>> 30 & 1),
        moves: w[3] >>> 18 & 63, scanUs: (w[3] >>> 24) * 20, audUs: null, irqs: null, sx: null};
    }
    return o;
  }
  async restartInfo() {
    const r = await this.req(OP.RESTART, [], {timeout: 600, retries: 1, allow: [0, 1]});
    if (r.status) return null;
    /* (0.9.98-dev.21: a 12th word, CPU1 now -> cpu1 {running, reason (the CPU meter's R), tries, guard}; null before) */
    /* (0.9.98-dev.23: words 13-17, the record's psr and ETM trace; a hang's load figures in them) */
    /* (0.9.98-dev.24: words 18-25, a hang's last 8 seconds of load and speed test, oldest first -> load.history) */
    if (![11, 12, 17, 25].some(n => r.data.length === 1 + 4 * n)) throw new LinkError('Invalid restart information from the FM-1.');
    const w = Array.from({length: (r.data.length - 1) / 4}, (_, i) => rd32(r.data, 1 + 4 * i));
    const [count, vec, pc, rets, emu, dbg, sp, uptimeMs, early, p3, rst, c1, psr, e0, e1, e2, e3] = w;
    const load = vec === 254 && psr != null ? {share: psr / 10, scanUs: Math.round((e0 & 0xFFFF) / 24), audUs: Math.round((e0 >>> 16) / 24),
      ring: e1 & 255, rxPend: !!(e1 >> 8 & 1), overflow: !!(e1 >> 9 & 1), usb: !!(e1 >> 10 & 1), sx: e1 >>> 16 & 255, moves: e2, irqs: e3,
      history: w.length >= 25 ? w.slice(17, 25).map(speedFrom).filter(Boolean) : null} : null;
    const cpu1 = c1 == null ? null : {running: !!(c1 & 1), reason: c1 >> 8 & 255, tries: c1 >> 16 & 255, guard: !!(c1 >> 24 & 1), p33: c1 >>> 25};   /* (p33: P33 timeouts since boot, at most 127) */
    /* (0.9.98-dev.20: 3 a hang, the hang recorder's: CPU0 stuck about 6 s; the record's vector 254, rets the link op) */
    return {why: [null, 'crash', 'watchdog', 'hang'][r.data[0]] ?? null, crash: count ? {count, vec, pc, rets, emu, dbg, sp, uptimeMs, early, load} : null, p3, rst, cpu1};
  }
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
   'midi' | 'keybd'), live (SEQ live mode), level (page volume), chainPos, chainLen (0.9.98-dev.12, per channel: the
   phrase of its chain it plays, 0..15, and the chain's phrases, 1..16; null before)}; unknown: null */
const SYNCS = {0: 'off', 1: 'lsdj', 3: 'midi', 5: 'keybd'};
export function liveDj(e) {
  if (e.length < 11) return {rows: null, songRows: null, sync: null, live: null, level: null, chainPos: null, chainLen: null, speed: null, rescue: null, stop: null};
  const k = b => b === 0xFF ? null : b;
  return {rows: [...e.slice(0, 4)].map(k), songRows: [...e.slice(4, 8)].map(k), sync: SYNCS[e[8]] ?? null,
          live: e[9] === 0xFF ? null : !!e[9], level: k(e[10]),
          chainPos: e.length >= 19 ? [...e.slice(11, 15)].map(k) : null, chainLen: e.length >= 19 ? [...e.slice(15, 19)].map(k) : null,
          speed: e.length >= 23 ? speedFrom(rd32(e, 19)) : null,
          rescue: e.length >= 33 ? rescueFrom(rd32(e, 23), rd32(e, 27), rd16(e, 31)) : null,
          stop: e.length >= 42 ? stopFrom(e[33], rd32(e, 34), rd16(e, 38), rd16(e, 40)) : null};
}

/* 0.9.98-dev.28, why LSDj last stopped (firmware lsdj_stopwhy.h; LIVE after the stall rescue) -> {why: 'quiet' (the MIDI
   clock went quiet 3 s), 'midi-stop', 'button' (one on the FM-1), 'lsdj' (none of those: LSDj itself), agoMs (since),
   gapMs (from the last clock tick to the stop; null: no clock), gapMaxMs (the longest gap between ticks while it
   played; null: 65 s or more, or no clock)}, or null (not stopped since power on, older firmware) */
const STOP_WHY = {1: 'quiet', 2: 'midi-stop', 3: 'button', 4: 'lsdj'};
export function stopFrom(why, ago, gap, gapMax) {
  if (!STOP_WHY[why] || ago === 0xFFFFFFFF) return null;
  return {why: STOP_WHY[why], agoMs: ago >>> 0, gapMs: gap === 0xFFFF ? null : gap, gapMaxMs: gapMax === 0xFFFF ? null : gapMax};
}

/* 0.9.98-dev.26, the stall rescue's counts since power-on (firmware board.c rescue_word; LIVE after the speed test):
   when CPU0's main code sat on one instruction for 30 ms, the FM-1 first read the stuck code from an interrupt, then
   held CPU1 between frames (LSDj stays on CPU1) until CPU0 moved -> {hold (freed once CPU1 was held), touch (freed by
   the read), self (moved before CPU1 had stopped), fail (not freed in 25 ms), total, pc (the last one's), ms (how long
   the last freed one lasted, 0 for one not freed)} */
export function rescueFrom(w, pc, ms) {
  const hold = w & 1023, touch = w >>> 10 & 1023, self = w >>> 20 & 63, fail = w >>> 26 & 63;
  return {hold, touch, self, fail, total: hold + touch + self + fail, pc: pc >>> 0, ms};
}

/* 0.9.98-dev.24, one second of the FM-1's speed test (firmware board.c hw_speed_second; LIVE's last word, RESTART's
   words 18-25 for a hang) -> {share (the interrupts' % of CPU0), audUs (the longest sound interrupt), spinUs (a loop
   run from RAM), sramUs (64 screen-buffer reads), flashUs (32 flash reads)}, or null (none yet). Each was kept as a
   quarter-octave code: within about 12 %. */
export function speedFrom(w) {
  if (!(w >>> 31)) return null;
  const v = c => c ? (4 + ((c - 1) & 3)) * 2 ** ((c - 1) >> 2) / 4 : 0;
  const us = t => Math.round(t / 2.4) / 10;   /* 24 MHz ticks -> us, 0.1 */
  return {share: w & 127, audUs: v(w >>> 7 & 63), spinUs: us(v(w >>> 13 & 63)), sramUs: us(v(w >>> 19 & 63)), flashUs: us(v(w >>> 25 & 63))};
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
    presets: !!(d[34] & 8),   /* 0.9.98-dev.6: PRESET_* */
    fx98: !!(d[34] & 16),     /* 0.9.98-dev.10: the new filters, distortions and gates (fx-model.js choicesFor) */
    stream: !!(d[34] & 32),   /* 0.9.98-dev.14: READ_STREAM (Link readStream) */
    usbVol: !!(d[34] & 64),   /* 0.9.98-dev.15: USB audio and its level switch (FEAT usbAudio) */
    build: d.length >= 39 ? rd32(d, 35) : null};   /* 0.9.98-dev.9: the build ID (template.json build_id); null before */
}

/* The reset cause restartInfo() carries (P3_RST_SRC p3, RST_SRC rst, as the FM-1 read them at boot) in words:
   {kind, causes, text}. kind: 'crash' / 'watchdog' (from why), 'power' (its supply dipped: VDDIO or 1.2 V low, VCM),
   'restart' (the firmware restarted itself with no crash record: P33 soft reset), 'planned' (a core reset: an
   install, an LSDj swap), 'button' (long press), 'on' (a plain power-on), 'unknown'. Colin's FM-1s restarted
   on their own while idle (2026-11-21) and came back with CPU1 off (R1): this names what reset them. */
const P3_BITS = ['power-on', 'VDDIO low', 'watchdog', 'VCM', 'long press', '1.2 V low', 'soft reset (P33)'];
export function resetCause(r) {
  if (!r) return null;
  const p3 = r.p3 & 0x7F, causes = P3_BITS.filter((_, i) => (p3 >> i) & 1);
  if ((r.rst >> 5) & 1) causes.push('core reset');
  /* (P3_RST_SRC is set only by a chip-level reset, power-on or the watchdog, and kept through core resets: an install
     or a swap after a watchdog restart still shows 0x04. RST_SRC bit 5 says the latest was a core reset: planned. The
     firmware's own 'watchdog' (dev.19, dev.20) misses this; found on Colin's FM-1 right after an install, 2026-11-21) */
  const kind = r.why === 'crash' ? 'crash' : r.why === 'hang' ? 'hang' : (r.rst >> 5) & 1 ? 'planned' : r.why === 'watchdog' ? 'watchdog'
    : p3 & (2 | 8 | 32) ? 'power' : p3 & 16 ? 'button' : p3 & 64 ? 'restart' : (r.rst >> 5) & 1 ? 'planned' : p3 & 1 ? 'on' : 'unknown';
  const said = {power: 'its supply dipped (a brown-out: the USB power or the battery sagged)', button: 'the power button was held',
    restart: 'the firmware restarted itself with no crash record (the emulator stopped with an error, or an update)',
    planned: 'a planned restart (an install or an LSDj swap)', on: 'it was switched on', unknown: 'nothing it can name',
    crash: 'a crash', watchdog: 'the watchdog (CPU0 stopped answering)', hang: 'a hang (CPU0 stuck about 6 s; the hang recorder restarted it)'}[kind];
  return {kind, causes, text: `${said}; reset cause ${causes.join(', ') || 'none'} (P3_RST_SRC 0x${p3.toString(16).padStart(2, '0')}, RST_SRC 0x${(r.rst >>> 0).toString(16)})`};
}

/* An FM-1 known again on new ports (Windows numbers them again when it comes back, and its port name can change:
   "Felucca", "3 - Felucca"): among these candidates, the one whose INFO (infoOf(x) -> {title, firmware, saveCrc})
   says what `info` said, the songs' checksum deciding between two of the same; else null (the user chooses).
   After a firmware update it says a NEWER firmware (and maybe another LSDj, whose songs differ): the one candidate
   with a newer firmware number counts as it (two newer: the user chooses). An older or equal other firmware: no. */
const fwNum = f => +(/(\d+)\D*$/.exec(f || '') || [])[1] || 0;
export function sameFm1(list, info, infoOf = x => x) {
  if (!info) return null;
  const same = list.filter(x => infoOf(x)?.title === info.title && infoOf(x)?.firmware === info.firmware);
  if (same.length === 1) return same[0];
  if (same.length > 1) {
    const crc = same.filter(x => infoOf(x).saveCrc === info.saveCrc);
    return crc.length === 1 ? crc[0] : null;
  }
  const newer = list.filter(x => fwNum(infoOf(x)?.firmware) > fwNum(info.firmware));
  return newer.length === 1 ? newer[0] : null;
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
