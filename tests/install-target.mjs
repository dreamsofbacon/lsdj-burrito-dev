// SPDX-License-Identifier: GPL-3.0-only
// installOn (the DJ crate): the unchanged install() runs on one FM-1 while others stay plugged in. Pretend FM-1s
// on pretend MIDI ports answer the identity query, stage, restart into update mode (new ports), write and restart
// (new ports again), as the FM-1's USB updater does. Nothing may ever be sent to an avoided port.
import assert from 'node:assert/strict';
import {install, installOn, accessWithout} from '../lsdj/install.js';
import {pack7, unpack7, HS_QUERY, STAGE_DONE, WRITE_DONE} from '../vendor/fm1ota.js';

const PRODUCT = 'FM-1_537000998';
let nextId = 1;
const access = {inputs: new Map(), outputs: new Map(), heard: new Set(),   /* (statechange, as Chrome's MIDIAccess) */
  addEventListener(t, f) { this.heard.add(f); }, removeEventListener(t, f) { this.heard.delete(f); }};
const changed = port => access.heard.forEach(f => f({port}));

function identity(text) {
  const d = [0, 0x59, 0x11, 0, 0, 0, ...[...text.padEnd(27, '\0')].map(c => c.charCodeAt(0)), 0];
  return [0xf0, ...pack7(d), 0xf7];
}
function request(addr, len) {
  const u = [0, 0x59, 0x30, 15, 0, 0, 0, addr & 255, addr >>> 8 & 255, addr >>> 16 & 255, addr >>> 24, len & 255, len >>> 8 & 255, 0];
  u.push(~u.slice(6).reduce((n, b) => n + b, 0) & 255);
  return [0xf0, ...pack7(u), 0xf7];
}
const isSuccess = m => { const u = unpack7(m.slice(1, -1)); return u[1] === 0x59 && u[2] === 0x30 && String.fromCharCode(...u.slice(14, 21)) === 'success'; };
const later = (f, ms = 1) => setTimeout(f, ms);

/* one pretend FM-1: mode 'app' | 'ota'; every message sent to any of its ports is kept in .got */
function fm1(name, text) {
  const dev = {name, text, mode: text.startsWith('ota') ? 'ota' : 'app', got: [], ports: null, upgraded: false,
    back: {ota: 300, app: 300}};   /* ms until it is on USB again after a restart (Infinity: until replugged) */
  dev.plug = () => {
    const [inId, outId] = dev.reuse?.shift() || [`in${nextId}`, `out${nextId++}`];
    const input = {id: inId, name: dev.name, state: 'connected', listeners: new Set(), onmidimessage: null,
      open: async () => {}, addEventListener(t, f) { this.listeners.add(f); }, removeEventListener(t, f) { this.listeners.delete(f); }};
    const output = {id: outId, name: dev.name, state: 'connected', open: async () => {}, send: m => { dev.got.push(m); dev.hear(m); }};
    const emit = data => later(() => { if (input.state !== 'connected') return; const ev = {data}; input.listeners.forEach(f => f(ev)); input.onmidimessage?.(ev); });
    dev.ports = {input, output, emit};
    access.inputs.set(input.id, input); access.outputs.set(output.id, output);
    changed(input); changed(output);
  };
  dev.unplug = () => {
    if (!dev.ports) return;
    for (const p of [dev.ports.input, dev.ports.output]) p.state = 'disconnected';
    access.inputs.delete(dev.ports.input.id); access.outputs.delete(dev.ports.output.id);
    changed(dev.ports.input); changed(dev.ports.output);
    dev.ports = null;
  };
  dev.hear = m => {
    const {emit} = dev.ports;
    if (m.join() === HS_QUERY.join()) return emit(identity(dev.text));
    if (m.length === 6 && m[1] === 0x22) {   /* UPGRADE: read some, then ask for success */
      const done = dev.mode === 'app' ? STAGE_DONE : WRITE_DONE;
      emit(request(0, 256)); later(() => emit(request(done, 8)), 5);
      return;
    }
    if (isSuccess(m)) {   /* the update loader's "success": restart, on new ports */
      if (dev.mode === 'app') { dev.unplug(); dev.text = 'ota-FM-1_1'; dev.mode = 'ota'; if (dev.back.ota < Infinity) later(dev.plug, dev.back.ota); }
      else { dev.unplug(); dev.text = PRODUCT; dev.mode = 'app'; dev.upgraded = true; if (dev.back.app < Infinity) later(dev.plug, dev.back.app); }
    }
  };
  dev.plug();
  return dev;
}
const pkg = {product: PRODUCT, image: new Uint8Array(4096).fill(7)};
const reset = () => { access.inputs.clear(); access.outputs.clear(); };
const ids = d => ({input: d.ports.input.id, output: d.ports.output.id});
const avoidOf = (...ds) => ds.flatMap(d => [d.ports.input.id, d.ports.output.id]);

/* the view: avoided ports are gone from it; new ports show up */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const view = accessWithout(access, avoidOf(b));
  assert.deepEqual([...view.inputs.keys()], [a.ports.input.id]);
  const c = fm1('FM-1', 'FM-1_996');
  assert.deepEqual([...view.outputs.keys()], [a.ports.output.id, c.ports.output.id]);
}

/* why: the normal install refuses with two FM-1s plugged in (and that stays so) */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(install(access, pkg), /More than one FM-1/);
  assert.equal(a.upgraded || b.upgraded, false);
}

/* deck A's FM-1 is updated; B (playing) never hears a byte */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const steps = [];
  const r = await installOn(access, pkg, {target: ids(a), avoid: avoidOf(b), onStep: s => steps.push(s)});
  assert.deepEqual(r, {id: PRODUCT, confirmed: true});
  assert.equal(a.upgraded, true);
  assert.deepEqual(b.got, [], 'nothing is sent to the other FM-1');
  assert.deepEqual(steps, ['found', 'stage', 'loader', 'write', 'restart', 'done']);
  assert.equal(b.text, 'FM-1_996');
}

/* the chosen ports aren't the FM-1 that answers: nothing installed, no UPGRADE sent */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: {input: 'gone-in', output: 'gone-out'}, avoid: avoidOf(b)}), /different FM-1.*Nothing was installed/);
  assert.equal(a.upgraded, false);
  assert.ok(a.got.every(m => m.join() === HS_QUERY.join()), 'only asked who it is');
  assert.deepEqual(b.got, []);
}

/* the other FM-1 not avoided: the install's own guard refuses */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(a), avoid: []}), /More than one FM-1/);
  assert.equal(a.upgraded || b.upgraded, false);
}

/* an FM-1 already in update mode: left for Install */
{
  reset();
  const o = fm1('FM-1', 'ota-FM-1_1'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(o), avoid: avoidOf(b)}), /update mode.*Nothing was installed/);
  assert.equal(o.got.filter(m => m.length === 6).length, 0, 'no UPGRADE');
}

/* the target among the avoided ports, or none: refused before anything is sent */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(a), avoid: avoidOf(a)}), /in use elsewhere/);
  await assert.rejects(installOn(access, pkg, {avoid: []}), /No FM-1 chosen/);
  assert.deepEqual(a.got, []);
}

/* the other FM-1 unplugged during the install: done, but not confirmed as deck A's */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const r = await installOn(access, pkg, {target: ids(a), avoid: avoidOf(b), onStep: s => { if (s === 'write') b.unplug(); }});
  assert.deepEqual(r, {id: PRODUCT, confirmed: false});
  assert.deepEqual(b.got, []);
}
/* Windows numbers ports by when they came: the restarted FM-1 takes a number the DJ layout kept out from another day
   (its mixer, gone now). It is still found after its restart, with nothing sent to the FM-1 playing */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  a.reuse = [['in-old', 'out-old'], ['in-old', 'out-old']];
  const steps = [];
  const r = await installOn(access, pkg, {target: ids(a), avoid: [...avoidOf(b), 'in-old', 'out-old'], onStep: s => steps.push(s), waitMs: 3000});
  assert.deepEqual(r, {id: PRODUCT, confirmed: true});
  assert.equal(a.upgraded, true);
  assert.deepEqual(b.got, []);
  assert.ok(!steps.some(s => s.startsWith('replug')), steps.join());
}
/* the other FM-1 unplugged during the install and deck A's FM-1 back on its number: found, not confirmed */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996'), bIds = avoidOf(b);
  a.reuse = [[`in${nextId}`, `out${nextId}`], [bIds[0], bIds[1]]];
  nextId++;
  const r = await installOn(access, pkg, {target: ids(a), avoid: bIds, waitMs: 3000, onStep: s => { if (s === 'write') b.unplug(); }});
  assert.deepEqual(r, {id: PRODUCT, confirmed: false});
  assert.equal(a.upgraded, true);
  assert.deepEqual(b.got, []);
}
/* slow to come back on USB after each restart (Windows missed it; the cable replugged): the page says so once
   per restart (replug, replug-back) and carries on */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996');
  a.back = {ota: 2600, app: 3100};
  const steps = [];
  const id = await install(access, pkg, {onStep: s => steps.push(s), hintMs: 400, waitMs: 8000});
  assert.equal(id, PRODUCT);
  assert.deepEqual(steps, ['found', 'stage', 'loader', 'replug', 'write', 'restart', 'replug-back', 'done']);
}
/* back in time: no hint */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), steps = [];
  await install(access, pkg, {onStep: s => steps.push(s), hintMs: 1000, waitMs: 8000});
  assert.ok(!steps.some(s => s.startsWith('replug')), steps.join());
}
/* never back in update mode: stopped, and the message says to replug and press Install again */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996');
  a.back = {ota: Infinity, app: 300};
  await assert.rejects(install(access, pkg, {hintMs: 200, waitMs: 800}), e => e.resumable && /UPDATE MODE: WAITING FOR THE INSTALLER, unplug its USB cable, plug it back in/.test(e.message));
}
console.log('install-target: PASS (the targeted install: only the chosen FM-1 hears anything; the normal install unchanged)');
