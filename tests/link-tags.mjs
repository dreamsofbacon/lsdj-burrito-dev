// SPDX-License-Identifier: GPL-3.0-only
// Tagged requests (0.9.98-dev.3, INFO flags bit 1): each request carries a number the reply echoes, so a late reply
// is never taken as the next one's and no LIVE waits for it. Firmware without them: untagged as before
// (node tests/link-tags.mjs).
import assert from 'node:assert/strict';
import {Link, OP, TAGGED, frame, parse, infoFrom} from '../lsdj/link.js';

assert.deepEqual(frame(OP.LIVE, [], 5), [0xf0, 0x7d, 0x47, 0x53, OP.LIVE | TAGGED, 5, 0xf7]);
assert.deepEqual(parse([0xf0, 0x7d, 0x47, 0x53, OP.READ | TAGGED, 0, 9, 1, 1, 0xf7]), {op: OP.READ, status: 0, tag: 9, data: new Uint8Array([129])});
assert.equal(parse([0xf0, 0x7d, 0x47, 0x53, OP.READ, 0, 1, 1, 0xf7]).tag, undefined);

/* a pretend FM-1: tags (dev.3) or not; replies after delays[i] ms (Infinity: lost); mute: what is true now */
function fm1(tags) {
  const input = {onmidimessage: null}, sent = [];
  const s = {input, sent, mute: 8, delays: [], output: {send(m) {
    const tagged = (m[4] & TAGGED) !== 0, op = m[4] & ~TAGGED;
    sent.push({op, tag: tagged ? m[5] : undefined});
    if (tagged && !tags) return;   /* older firmware: an unknown op, answered "bad request" with no tag: never matched */
    const data = op === OP.INFO ? [1, ...Array(33).fill(0), tags ? 3 : 1] : op === OP.LIVE ? [1, 1, 120, 0, s.mute, 0, 0, ...Array(68).fill(0)] : [];
    const reply = [0xf0, 0x7d, 0x47, 0x53, m[4], 0, ...(tagged ? [m[5]] : []), ...data.flatMap(b => [b & 127, b >> 7]), 0xf7];
    const ms = s.delays.shift() ?? 0;
    if (Number.isFinite(ms)) setTimeout(() => input.onmidimessage?.({data: reply}), ms);
  }}};
  return s;
}

{ /* dev.3: INFO says tags; a LIVE answered late is ignored by its tag, the next LIVE asks at once */
  const f = fm1(true), link = new Link(f.input, f.output);
  assert.equal(infoFrom([1, ...Array(33).fill(0), 3]).tags, true);
  assert.equal(infoFrom([1, ...Array(33).fill(0), 3]).fx98, false);   /* 0.9.98-dev.10: the new effect choices */
  assert.equal(infoFrom([1, ...Array(33).fill(0), 16 | 3]).fx98, true);
  assert.equal(link.tagged, false, 'untagged until INFO says so');
  assert.equal((await link.info()).tags, true);
  assert.equal(f.sent[0].tag, undefined, 'INFO itself untagged (it says whether tags work)');
  assert.ok(link.tagged);
  f.delays = [1700, 0];
  await assert.rejects(link.live(), /did not answer/);
  f.mute = 0;
  const t0 = Date.now(), l = await link.live();
  assert.equal(l.mute, 0, 'its own answer, not the late one');
  assert.ok(Date.now() - t0 < 300, `no wait for the late reply: ${Date.now() - t0} ms`);
  const tags = f.sent.slice(1).map(x => x.tag);
  assert.ok(tags.every(t => Number.isInteger(t)) && new Set(tags).size === tags.length, `a new tag each request: ${tags}`);
  await new Promise(r => setTimeout(r, 1800));   /* the late reply arrives: nothing waits for it */
  link.close();
}
{ /* firmware without tags (dev.2 and older): untagged, the late-LIVE drain as before */
  const f = fm1(false), link = new Link(f.input, f.output);
  assert.equal((await link.info()).tags, false);
  assert.equal(link.tagged, false);
  await link.live();
  assert.ok(f.sent.every(x => x.tag === undefined), 'never tags to firmware that did not say so');
  link.close();
}
{ /* one FM-1, two links (the page's and a deck's): the second knows from the first's INFO */
  const f = fm1(true), a = new Link(f.input, f.output);
  await a.info(); a.close();
  const b = new Link(f.input, f.output);
  assert.ok(b.tagged);
  b.close();
}
console.log('link-tags: PASS (tags when INFO says so; a late tagged reply ignored without waiting; none to older firmware; shared by links to one FM-1)');
