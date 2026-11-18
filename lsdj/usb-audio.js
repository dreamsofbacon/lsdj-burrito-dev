// SPDX-License-Identifier: GPL-3.0-only
/* The FM-1's sound played on this computer. 0.9.98-dev.11 and newer send it over the USB cable as a sound input (its
   USB name, "Felucca", until renamed). The page plays each FM-1 wanted through a gain of its own, so the DJ crossfader
   (or Perform's volume) mixes them with no mixer or DAW. Reading a sound input needs the browser's microphone
   permission; nothing is recorded or sent anywhere. Which input is which FM-1: chosen here (kept by the FM-1's MIDI
   port name); a first guess only from the name. */

/* Chrome lists the default and communications devices again under these ids */
const ALIAS = new Set(['default', 'communications']);
export const isInput = d => d.kind === 'audioinput' && !ALIAS.has(d.deviceId);

const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
/* "Microphone (2- Felucca)" -> "2- felucca": the device name inside the brackets Windows adds */
const inner = label => norm(label.match(/\(([^()]*)\)\s*$/)?.[1] ?? label);

/* the input for an FM-1 on MIDI port `port`: the one chosen for it, else the one named as that port, else the only one
   named Felucca; null when it can't tell (the user chooses) */
export function pickInput(inputs, port, chosen) {
  if (chosen && inputs.some(i => i.deviceId === chosen)) return chosen;
  const p = norm(port);
  const named = p ? inputs.filter(i => inner(i.label) === p || norm(i.label) === p) : [];
  if (named.length === 1) return named[0].deviceId;
  const felucca = inputs.filter(i => /felucca/i.test(i.label));
  return felucca.length === 1 ? felucca[0].deviceId : null;
}

const RAW = {echoCancellation: false, noiseSuppression: false, autoGainControl: false};

export class Hear {
  /* store: {get(port), set(port, deviceId)}: the inputs chosen, kept (app.js: this browser's storage) */
  constructor(env = globalThis, store = {get: () => null, set: () => {}}) {
    this.env = env; this.store = store; this.ctx = null; this.players = new Map(); this.inputs = [];
    this.wanted = new Map(); this.busy = null; this.error = '';
    this.onChange = () => {};
    this.md?.addEventListener?.('devicechange', () => { if (this.wanted.size) void this.apply(true); });
  }
  get md() { return this.env.navigator?.mediaDevices; }
  get supported() { return !!this.md?.getUserMedia && !!(this.env.AudioContext || this.env.webkitAudioContext); }
  /* in the click that turns it on: a browser lets a page start its sound only in answer to a click */
  unlock() {
    if (!this.supported) return;
    const C = this.env.AudioContext || this.env.webkitAudioContext;
    this.ctx ||= new C({latencyHint: 'interactive'});
    void this.ctx.resume?.();
  }
  async list() {
    if (!this.supported) return (this.inputs = []);
    let all = await this.md.enumerateDevices();
    if (all.some(d => d.kind === 'audioinput' && !d.label)) {   /* no names before the permission */
      (await this.md.getUserMedia({audio: RAW})).getTracks().forEach(t => t.stop());
      all = await this.md.enumerateDevices();
    }
    return (this.inputs = all.filter(isInput));
  }
  choose(port, deviceId) { this.store.set(norm(port), deviceId || null); return this.apply(); }
  inputFor(key) { return this.players.get(key)?.deviceId ?? null; }
  /* what the FM-1 `key` plays: its input's name, or why nothing */
  status(key) {
    if (this.error) return this.error;
    const p = this.players.get(key);
    if (p) return this.ctx?.state === 'running' ? `Playing ${this.inputs.find(i => i.deviceId === p.deviceId)?.label || 'its sound input'}`
      : 'Waiting for a click on the page to start the sound (the browser\'s rule).';
    if (!this.wanted.has(key)) return '';
    return this.inputs.length ? 'Choose the FM-1\'s sound input.' : 'No sound input found (FM-1 0.9.98-dev.11 or newer over USB).';
  }
  /* want: Map key -> {port, gain 0..1}; the FM-1s not in it stop. Gains change at once, inputs one at a time. */
  want(map) {
    this.wanted = map;
    for (const [key, w] of map) { const p = this.players.get(key); if (p) this.level(p, w.gain); }
    return this.apply();
  }
  level(p, v) {
    const g = Math.max(0, Math.min(1, +v || 0));
    p.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);   /* (a smooth step: no click) */
  }
  pick(w) { return pickInput(this.inputs, w.port, this.store.get(norm(w.port))); }
  apply(relist = false) {
    const run = async () => {
      try {
        if (this.wanted.size && (relist || !this.inputs.length)) await this.list();
        for (const [key, p] of this.players) {
          const w = this.wanted.get(key);
          if (!w || this.pick(w) !== p.deviceId) this.stop(key);
        }
        for (const [key, w] of this.wanted) {
          if (this.players.has(key)) continue;
          const id = this.pick(w);
          if (id) await this.start(key, id);
        }
        if (!this.players.size) await this.ctx?.suspend?.();
        else await this.ctx.resume();
        this.error = '';
      } catch (e) { this.error = e.name === 'NotAllowedError' ? 'The browser was not allowed to hear the FM-1 (its microphone permission).' : e.message; }
      this.onChange();
    };
    this.busy = (this.busy || Promise.resolve()).then(run);
    return this.busy;
  }
  async start(key, deviceId) {
    this.unlock();
    const stream = await this.md.getUserMedia({audio: {...RAW, deviceId: {exact: deviceId}, channelCount: {ideal: 2}}});
    if (!this.wanted.has(key)) { stream.getTracks().forEach(t => t.stop()); return; }   /* (let go meanwhile) */
    const src = this.ctx.createMediaStreamSource(stream), g = this.ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, +this.wanted.get(key).gain || 0));
    src.connect(g).connect(this.ctx.destination);
    this.players.set(key, {deviceId, stream, src, gain: g});
  }
  stop(key) {
    const p = this.players.get(key);
    if (!p) return;
    p.stream.getTracks().forEach(t => t.stop()); p.src.disconnect(); p.gain.disconnect();
    this.players.delete(key);
  }
}
