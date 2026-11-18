// SPDX-License-Identifier: GPL-3.0-only
// Hear it here (lsdj/usb-audio.js): every sound input listed (the FM-1's may be renamed), the one chosen for an FM-1
// kept by its MIDI port name, a first guess from the name; played through a gain of its own; gains follow at once,
// inputs start and stop as wanted; the USB AUDIO switch and its INFO flag (node tests/usb-audio.mjs).
import assert from 'node:assert/strict';
import {Hear, pickInput, isInput} from '../lsdj/usb-audio.js';
import {infoFrom} from '../lsdj/link.js';
import {FEATURES, unpackFeatures, packFeatures} from '../lsdj/fx-model.js';

const inp = (deviceId, label) => ({kind: 'audioinput', deviceId, label});
const one = inp('a', 'Microphone (Felucca)'), two = inp('b', 'Microphone (2- Felucca)'), mic = inp('m', 'Microphone (Realtek)');
const renamed = inp('r', 'Deck A (Felucca)');
assert.ok(isInput(one) && isInput(mic) && !isInput({kind: 'audiooutput', deviceId: 'x', label: 'Felucca'}));
assert.ok(!isInput(inp('default', 'Default - Microphone (Felucca)')) && !isInput(inp('communications', 'x')), 'aliases left out');
assert.equal(pickInput([one, mic], 'Felucca'), 'a');
assert.equal(pickInput([one, mic], 'something else'), 'a', 'the only Felucca');
assert.equal(pickInput([one, two], '2- Felucca'), 'b');
assert.equal(pickInput([one, two], 'Felucca'), 'a');
assert.equal(pickInput([one, two], '3- Felucca'), null, 'unsure: the user chooses');
assert.equal(pickInput([one, two], '3- Felucca', 'b'), 'b', 'chosen before');
assert.equal(pickInput([one, two], 'Felucca', 'gone'), 'a');
assert.equal(pickInput([mic], 'Felucca'), null, 'never a guess at a microphone');
assert.equal(pickInput([mic, inp('x', 'Line (My FM-1)')], 'Felucca', 'x'), 'x', 'any name, once chosen');
assert.equal(pickInput([renamed, mic], 'Felucca'), 'r');
assert.equal(pickInput([], 'Felucca'), null);

/* a pretend browser: two FM-1 inputs and a microphone; names only after the permission */
function browser() {
  const log = [], streams = [];
  let allowed = false;
  const devs = [one, two, mic];
  const node = name => ({name, connected: [], connect(n) { this.connected.push(n); return n; }, disconnect() { log.push(`disconnect ${name}`); }});
  class AudioContext {
    constructor(o) { this.opts = o; this.currentTime = 0; this.destination = node('out'); this.state = 'running'; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; log.push('suspend'); }
    createMediaStreamSource(s) { const n = node(`src ${s.id}`); n.stream = s; return n; }
    createGain() { const n = node('gain'); n.gain = {value: 1, setTargetAtTime(v) { this.value = v; }}; return n; }
  }
  const md = {
    async enumerateDevices() { return devs.map(d => allowed ? d : {...d, label: ''}); },
    async getUserMedia(c) {
      allowed = true;
      const id = c.audio.deviceId?.exact ?? 'default', s = {id, constraints: c.audio, stopped: false, getTracks: () => [{stop: () => { s.stopped = true; }}]};
      streams.push(s); return s;
    },
    addEventListener() {},
  };
  return {env: {navigator: {mediaDevices: md}, AudioContext}, log, streams};
}

const kept = new Map(), store = {get: p => kept.get(p) ?? null, set: (p, id) => { if (id) kept.set(p, id); else kept.delete(p); }};
const b = browser(), h = new Hear(b.env, store);
assert.ok(h.supported);
assert.ok(!new Hear({navigator: {}}).supported);
h.unlock();
assert.equal(h.ctx.state, 'running', 'the page\'s sound made in the click');
await h.want(new Map([['k1', {port: 'Felucca', gain: 0.5}]]));
assert.deepEqual(h.inputs.map(i => i.deviceId), ['a', 'b', 'm'], 'every input, named after the permission');
const p1 = h.players.get('k1');
assert.equal(p1.deviceId, 'a');
assert.equal(p1.gain.gain.value, 0.5);
const c = p1.stream.constraints;
assert.ok(!c.echoCancellation && !c.noiseSuppression && !c.autoGainControl, 'raw sound, no voice processing');
assert.deepEqual(c.deviceId, {exact: 'a'});
assert.equal(h.ctx.opts.latencyHint, 'interactive');
assert.equal(h.status('k1'), 'Playing Microphone (Felucca)');

/* gains follow at once; a second FM-1 joins; the first leaves */
h.want(new Map([['k1', {port: 'Felucca', gain: 0.2}]]));
assert.equal(p1.gain.gain.value, 0.2);
await h.busy;
await h.want(new Map([['k1', {port: 'Felucca', gain: 1}], ['k2', {port: '2- Felucca', gain: 0}]]));
assert.equal(h.players.get('k2').deviceId, 'b');
assert.equal(h.players.get('k2').gain.gain.value, 0);
await h.want(new Map([['k2', {port: '2- Felucca', gain: 2}]]));
assert.ok(!h.players.has('k1') && p1.stream.stopped, 'stopped and let go');
assert.equal(h.players.get('k2').gain.gain.value, 1, 'clamped');

/* chosen by hand (any input, by the FM-1's port name, kept) */
await h.choose('2- Felucca', 'm');
assert.equal(h.inputFor('k2'), 'm');
assert.equal(kept.get('2- felucca'), 'm');
/* nothing wanted: all stop, the context sleeps */
await h.want(new Map());
assert.equal(h.players.size, 0);
assert.ok(b.streams.filter(s => s.constraints.deviceId).every(s => s.stopped));
assert.ok(b.log.includes('suspend'));

/* an unknown port among two Felucca inputs: nothing plays until chosen, and says so */
await h.want(new Map([['k3', {port: '7- Felucca', gain: 1}]]));
assert.equal(h.players.size, 0);
assert.match(h.status('k3'), /Choose/);
await h.choose('7- Felucca', 'b');
assert.equal(h.inputFor('k3'), 'b');
/* a browser holding the sound until a click: said */
h.ctx.state = 'suspended';
assert.match(h.status('k3'), /click/);

/* refused permission: said, nothing plays */
const r = browser(); r.env.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('no'), {name: 'NotAllowedError'}); };
const hr = new Hear(r.env);
await hr.want(new Map([['k', {port: 'Felucca', gain: 1}]]));
assert.match(hr.error, /not allowed/);
assert.equal(hr.players.size, 0);

/* the USB AUDIO switch: bit 23, Full by default (older words read so); INFO flags bit 6 */
const f = FEATURES.find(x => x.key === 'usbAudio');
assert.deepEqual(f.bits, [23, 1]);
assert.equal(unpackFeatures(0x460001CE).usbAudio, 0);
assert.equal(packFeatures({...unpackFeatures(0x460001CE), usbAudio: 1}), (0x460001CE | 1 << 23) >>> 0);
assert.equal(unpackFeatures((0x460001CE | 1 << 23) >>> 0).usbAudio, 1);
const info = flags => infoFrom(new Uint8Array([1, ...new Array(33).fill(0), flags, 0, 0, 0, 0]));
assert.ok(info(64).usbVol && !info(32).usbVol);

console.log('PASS usb audio: every input listed, chosen per FM-1 and kept, a guess only from the name, raw, gains at once, start / stop, status, click unlock, permission refused; USB AUDIO switch and INFO flag');
