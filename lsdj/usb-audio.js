// SPDX-License-Identifier: GPL-3.0-only
/* The FM-1's sound played on this computer. 0.9.98-dev.11 and newer send it over the USB cable: a sound input named
   as its MIDI port ("Felucca", "2- Felucca"). The page plays each FM-1 wanted through a gain of its own, so the DJ
   crossfader (or Perform's volume) mixes them with no mixer or DAW. Reading a sound input needs the browser's
   microphone permission; nothing is recorded or sent anywhere. */

export const isFm1Input = d => d.kind === 'audioinput' && /felucca/i.test(d.label);

/* "Microphone (2- Felucca)" -> "2- felucca": the port name inside the brackets Windows adds */
const portOf = label => (label.match(/\(([^()]*felucca[^()]*)\)/i)?.[1] ?? label).replace(/\s+/g, ' ').trim().toLowerCase();

/* the input for an FM-1 on MIDI port `port`: the one chosen for it before, else the one named after that port,
   else the only one; null when it can't tell (the user chooses) */
export function pickInput(inputs, port, chosen) {
  if (chosen && inputs.some(i => i.deviceId === chosen)) return chosen;
  const p = (port || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const named = inputs.filter(i => portOf(i.label) === p);
  if (named.length === 1) return named[0].deviceId;
  return inputs.length === 1 ? inputs[0].deviceId : null;
}

const RAW = {echoCancellation: false, noiseSuppression: false, autoGainControl: false};

export class Hear {
  constructor(env = globalThis) {
    this.env = env; this.ctx = null; this.players = new Map(); this.inputs = [];
    this.wanted = new Map(); this.chosen = new Map(); this.busy = null; this.error = '';
    this.onChange = () => {};
    this.md?.addEventListener?.('devicechange', () => { if (this.wanted.size) void this.apply(true); });
  }
  get md() { return this.env.navigator?.mediaDevices; }
  get supported() { return !!this.md?.getUserMedia && !!(this.env.AudioContext || this.env.webkitAudioContext); }
  async list() {
    if (!this.supported) return (this.inputs = []);
    let all = await this.md.enumerateDevices();
    if (all.some(d => d.kind === 'audioinput' && !d.label)) {   /* no names before the permission */
      (await this.md.getUserMedia({audio: RAW})).getTracks().forEach(t => t.stop());
      all = await this.md.enumerateDevices();
    }
    return (this.inputs = all.filter(isFm1Input));
  }
  choose(key, deviceId) { if (deviceId) this.chosen.set(key, deviceId); else this.chosen.delete(key); void this.apply(); }
  inputFor(key) { return this.players.get(key)?.deviceId ?? null; }
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
  apply(relist = false) {
    const run = async () => {
      try {
        if (this.wanted.size && (relist || !this.inputs.length)) await this.list();
        for (const [key, p] of this.players) {
          const w = this.wanted.get(key);
          const id = w && pickInput(this.inputs, w.port, this.chosen.get(key));
          if (!w || id !== p.deviceId) this.stop(key);
        }
        for (const [key, w] of this.wanted) {
          if (this.players.has(key)) continue;
          const id = pickInput(this.inputs, w.port, this.chosen.get(key));
          if (id) await this.start(key, id, w.gain);
        }
        if (!this.players.size) await this.ctx?.suspend?.();
        this.error = '';
      } catch (e) { this.error = e.name === 'NotAllowedError' ? 'The browser was not allowed to hear the FM-1 (its microphone permission).' : e.message; }
      this.onChange();
    };
    this.busy = (this.busy || Promise.resolve()).then(run);
    return this.busy;
  }
  async start(key, deviceId, gain) {
    const C = this.env.AudioContext || this.env.webkitAudioContext;
    this.ctx ||= new C({latencyHint: 'interactive'});
    const stream = await this.md.getUserMedia({audio: {...RAW, deviceId: {exact: deviceId}, channelCount: {ideal: 2}}});
    if (!this.wanted.has(key)) { stream.getTracks().forEach(t => t.stop()); return; }   /* (let go meanwhile) */
    await this.ctx.resume();
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
