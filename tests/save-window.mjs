// SPDX-License-Identifier: GPL-3.0-only
// Link.sendChunks: a save's CHUNKs with several on the way at once, against a simulated FM-1 that keeps the
// firmware's rules (lsdj_link.h CHUNK: in order only, the last one again is fine, BAD otherwise, nothing changed;
// felucca usb.c: one incoming SysEx held at a time, one that comes in meanwhile is dropped) and loses replies.
import assert from 'node:assert/strict';
import {Link, OP, CHUNK, SAVE_SIZE, TAGGED} from '../lsdj/link.js';

function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/* busy: chance the FM-1 holds a frame a moment (one coming in meanwhile is dropped); lose: a frame lost on the way;
   noReply: a reply lost; mute: [from, to) chunk offsets whose first OK reply is lost */
function fm1({busy = 0, lose = 0, noReply = 0, mute = null, seed = 1} = {}) {
  const rnd = lcg(seed), save = new Uint8Array(SAVE_SIZE), st = {next: 0, frames: 0, dropped: 0, held: null};
  const input = {};
  const reply = (op, status, tag) => {
    setImmediate(() => input.onmidimessage?.({data: Uint8Array.from([0xF0, 0x7D, 0x47, 0x53, op | TAGGED, status, tag, 0xF7])}));
  };
  const handle = m => {
    st.frames++;
    const tag = m[5], d = [];
    for (let i = 6; i + 1 < m.length - 1; i += 2) d.push(m[i] | (m[i + 1] & 1) << 7);
    const off = (d[0] | d[1] << 8 | d[2] << 16 | d[3] << 24) >>> 0;
    let status = 0;
    if (off + CHUNK === st.next) status = 0;
    else if (off !== st.next || off + CHUNK > SAVE_SIZE) status = 1;
    else { save.set(d.slice(4), off); st.next += CHUNK; }
    const muted = mute && status === 0 && off >= mute[0] && off < mute[1] && !st.muted?.has(off);
    if (muted) (st.muted ??= new Set()).add(off);   /* (each one lost once: a resend is answered) */
    if (!muted && rnd() >= noReply) reply(OP.CHUNK, status, tag);
  };
  const output = {
    send(msg) {
      assert.equal(msg[4], OP.CHUNK | TAGGED);
      setImmediate(() => {
        if (rnd() < lose) return;
        if (st.held) { st.dropped++; return; }
        if (rnd() < busy) { st.held = msg; setTimeout(() => { const h = st.held; st.held = null; handle(h); }, 1); }
        else handle(msg);
      });
    }
  };
  return {input, output, save, st};
}

const payload = Uint8Array.from({length: SAVE_SIZE}, (_, i) => (i * 31 + (i >>> 9)) & 255);
async function run(name, opts) {
  const f = fm1(opts), link = new Link(f.input, f.output), progress = [];
  const t = Date.now();
  await link.sendChunks(payload, (n, total) => progress.push([n, total]));
  assert.deepEqual(f.save, payload, `${name}: every byte stored`);
  assert.equal(f.st.next, SAVE_SIZE, `${name}: the FM-1 has all of it`);
  assert.deepEqual(progress.at(-1), [SAVE_SIZE, SAVE_SIZE]);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0], `${name}: progress only goes up`);
  assert.equal(link.chunkAck, null, `${name}: the reply hook removed`);
  link.close();
  console.log(`  ${name}: ${f.st.frames} frames, ${Date.now() - t} ms`);
  return {frames: f.st.frames, dropped: f.st.dropped, ms: Date.now() - t, win: link.chunkWinMax};
}

const clean = await run('clean', {});
assert.equal(clean.frames, SAVE_SIZE / CHUNK, 'a clean link sends each piece once');
assert.ok(clean.win >= 32, `the window grows on a clean link (${clean.win})`);
await run('a busy FM-1 (frames dropped while it holds one)', {busy: 0.05, seed: 2});
await run('frames and replies lost', {lose: 0.01, noReply: 0.01, seed: 3});
await run('all of it at once', {busy: 0.1, lose: 0.02, noReply: 0.03, seed: 4});
await run('every OK lost for 40 pieces (the FM-1 is ahead of the page)', {mute: [10 * CHUNK, 50 * CHUNK], seed: 5});
await run('the last reply lost', {mute: [SAVE_SIZE - CHUNK, SAVE_SIZE], seed: 6});
const packed = await run('an FM-1 that drops every frame sent behind another (one at a time, as before)', {busy: 1, seed: 7});
assert.ok(packed.frames < 1.2 * SAVE_SIZE / CHUNK, `settles on one at a time (${packed.frames} frames)`);

/* a dead FM-1: an error, not a hang */
{
  const input = {}, link = new Link(input, {send() {}});
  await assert.rejects(link.sendChunks(payload), /did not answer/);
  link.close();
}
console.log('PASS save window: every byte stored with frames dropped by a busy FM-1, frames and replies lost, an FM-1 ahead of the page, the last reply lost, an FM-1 that takes one at a time only; a clean link sends each piece once; a dead FM-1 fails');
