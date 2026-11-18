// SPDX-License-Identifier: GPL-3.0-only
// READ_STREAM (0.9.98-dev.14): the songs streamed by a pretend FM-1 as STREAM_DATA messages (firmware/lsdj_stream.h
// framing), some lost on the way: the page asks for the missing parts again and gets every byte; an FM-1 without the
// stream (no INFO flag) is read with READ as before; a stream that never comes falls back to READ too.
import assert from 'node:assert/strict';
import {Link, OP, crc32} from '../lsdj/link.js';

const SAVE = new Uint8Array(131072);
for (let i = 0; i < SAVE.length; i++) SAVE[i] = (i * 37 + (i >> 8) * 11) & 255;
const pairs = bytes => bytes.flatMap(b => [b & 127, b >> 7]);
const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

/* one STREAM_DATA message, as lsdj_stream.h builds it */
function streamMsg(what, off, src) {
  const m = [0xf0, 0x7d, 0x47, 0x53, OP.STREAM_DATA, 0, what, ...pairs(le32(off))];
  for (let g = 0; g < src.length; g += 7) {
    const grp = src.slice(g, g + 7);
    m.push(grp.reduce((h, v, i) => h | (v >> 7) << i, 0), ...grp.map(v => v & 127));
  }
  m.push(0xf7);
  return m;
}
function fm1({stream = true, lose = new Set(), silent = false} = {}) {
  const input = {onmidimessage: null}, st = {reads: 0, streams: 0};
  const send = d => setTimeout(() => input.onmidimessage?.({data: d}), 0);
  const reply = (op, bytes = [], status = 0) => send([0xf0, 0x7d, 0x47, 0x53, op, status, ...pairs(bytes), 0xf7]);
  const output = {send(m) {
    const op = m[4], d = [];
    for (let i = 5; i + 1 < m.length - 1; i += 2) d.push(m[i] | m[i + 1] << 7);
    const rd = i => d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24;
    if (op === OP.INFO) {
      const info = [1, ...[...'FM-1_998'].map(c => c.charCodeAt(0)), ...Array(16).fill(0), ...le32(SAVE.length), ...le32(crc32(SAVE)), 0, stream ? 32 : 0, ...le32(0)];
      return reply(op, info);
    }
    if (op === OP.READ) { st.reads++; const off = rd(0); return reply(op, [...SAVE.subarray(off, off + 128)]); }
    if (op === OP.READ_STREAM) {
      if (!stream) return reply(op, [], 1);
      const what = d[0], off = rd(1), len = rd(5);
      reply(op, le32(SAVE.length));
      if (!len || silent) return;
      st.streams++;
      const end = Math.min(SAVE.length, off + len);
      for (let a = off; a < end; a += 112) {
        const key = `${a}`;
        if (lose.has(key)) { lose.delete(key); continue; }   /* lost once */
        send(streamMsg(what, a, [...SAVE.subarray(a, Math.min(end, a + 112))]));
      }
    }
  }};
  return {link: new Link(input, output), st};
}

{ /* streamed, three frames lost the first time: asked again, every byte, no READ */
  const {link, st} = fm1({lose: new Set(['0', `${112 * 500}`, `${112 * 1170}`])});
  let last = 0;
  const got = await link.exportSave((n, t) => { assert.ok(n >= last && n <= t); last = n; });
  assert.deepEqual(got, SAVE);
  assert.equal(st.reads, 0, 'no READ');
  assert.ok(st.streams >= 2, `asked again for the lost parts: ${st.streams} streams`);
  assert.equal(last, SAVE.length);
  link.close();
}
{ /* an FM-1 without the stream: READ as before */
  const {link, st} = fm1({stream: false});
  assert.deepEqual(await link.exportSave(), SAVE);
  assert.equal(st.reads, 1024);
  link.close();
}
{ /* the stream flag but nothing comes: READ after its rounds */
  const {link, st} = fm1({silent: true});
  assert.deepEqual(await link.exportSave(), SAVE);
  assert.equal(st.reads, 1024);
  link.close();
}
console.log('link-stream: PASS (the songs streamed, lost frames asked for again, every byte; no stream: READ; a silent stream: READ)');
