// SPDX-License-Identifier: GPL-3.0-only
// Hear it here (lsdj/usb-audio.js): each FM-1's USB sound input found by its MIDI port's name, played through a gain
// of its own; gains follow at once, inputs start and stop as wanted; the USB AUDIO switch and its INFO flag
// (node tests/usb-audio.mjs).
import assert from 'node:assert/strict';
import {Hear, pickInput, isFm1Input} from '../lsdj/usb-audio.js';
import {infoFrom} from '../lsdj/link.js';
import {FEATURES, unpackFeatures, packFeatures} from '../lsdj/fx-model.js';

const inp = (deviceId, label) => ({kind: 'audioinput', deviceId, label});
const one = inp('a', 'Microphone (Felucca)'), two = inp('b', 'Microphone (2- Felucca)'), mic = inp('m', 'Microphone (Realtek)');
assert.ok(isFm1Input(one) && !isFm1Input(mic) && !isFm1Input({kind: 'audiooutput', label: 'Felucca'}));
assert.equal(pickInput([one], 'Felucca'), 'a');
assert.equal(pickInput([one], 'something else'), 'a', 'the only one');
assert.equal(pickInput([one, two], '2- Felucca'), 'b');
assert.equal(pickInput([one, two], 'Felucca'), 'a');
assert.equal(pickInput([one, two], '3- Felucca'), null, 'unsure: the user chooses');
assert.equal(pickInput([one, two], '3- Felucca', 'b'), 'b', 'chosen before');
assert.equal(pickInput([one, two], 'Felucca', 'gone'), 'a');
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

const b = browser(), h = new Hear(b.env);
assert.ok(h.supported);
assert.ok(!new Hear({navigator: {}}).supported);
await h.want(new Map([['k1', {port: 'Felucca', gain: 0.5}]]));
assert.deepEqual(h.inputs.map(i => i.deviceId), ['a', 'b'], 'FM-1 inputs only, named after the permission');
const p1 = h.players.get('k1');
assert.equal(p1.deviceId, 'a');
assert.equal(p1.gain.gain.value, 0.5);
const c = p1.stream.constraints;
assert.ok(!c.echoCancellation && !c.noiseSuppression && !c.autoGainControl, 'raw sound, no voice processing');
assert.deepEqual(c.deviceId, {exact: 'a'});
assert.equal(h.ctx.opts.latencyHint, 'interactive');

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

/* chosen by hand: the other input */
h.choose('k2', 'a'); await h.busy;
assert.equal(h.inputFor('k2'), 'a');
/* nothing wanted: all stop, the context sleeps */
await h.want(new Map());
assert.equal(h.players.size, 0);
assert.ok(b.streams.filter(s => s.constraints.deviceId).every(s => s.stopped));
assert.ok(b.log.includes('suspend'));

/* an unknown port among two inputs: nothing plays until chosen */
await h.want(new Map([['k3', {port: '7- Felucca', gain: 1}]]));
assert.equal(h.players.size, 0);
h.choose('k3', 'b'); await h.busy;
assert.equal(h.inputFor('k3'), 'b');

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

console.log('PASS usb audio: inputs found by port name, raw, gains at once, start / stop / choose, permission refused; USB AUDIO switch and INFO flag');
