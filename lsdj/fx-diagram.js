// SPDX-License-Identifier: GPL-3.0-only
// The effects' wiring as the firmware runs it (firmware/lsdj_fx.h lsdj_fx_mix / lsdj_fx_chan):
// per channel DRIVE -> FILTER -> LO-FI (crush, decimate) -> LFO (volume / pan; to the cutoff it
// moves the filter), into the mix; each channel's send, taken after its chain, feeds the one shared
// ECHO, whose return joins the mix; then (0.9.97) the REVERB, fed by each channel's reverb send (dev.7), its return
// joining before the COMPRESSOR; and out. What is on is lit; a muted channel,
// a dry one (Channel FX off) and All FX off are greyed. Pure: returns SVG text.
// Two directions (layout): 'v' upright, one column per channel as on LSDj's song screen
// (PU1 PU2 WAV NOI); 'h' one row per channel. compact: the upright one narrower, for phones.
// Each block names the effects page it is on (data-go, data-ch): the page opens it there (app.js).
import {CHANNELS, reverbSeconds} from './fx-model.js';

const num = v => String(v & 255);   // decimal, as the page's controls show values
const FILTER = ['', 'LP', 'HP', 'BP', 'NOTCH', 'LP24', 'PHASR', 'VOWEL'], DIST = ['SOFT', 'HARD', 'FOLD', 'FUZZ', 'SFOLD', 'RECT', 'RING', 'TAPE'],
  DEST = ['CUT', 'VOL', 'PAN'];
const NAME = {drive: 'Drive', filter: 'Filter', lofi: 'Lo-fi', lfo: 'LFO', echo: 'Echo', reverb: 'Reverb', comp: 'Compressor'};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* a block: lines of text (the first its name), lit when on; go: the page it opens, ch: its channel */
function block(x, y, w, h, lines, on, go, ch, t) {
  const who = ch == null ? '' : ` ${CHANNELS[ch]}`;
  const label = `${NAME[go]}${who}: ${lines.slice(1).join(' ')}. Open its page`;
  return `<g class="blk${on ? ' on' : ''}" data-go="${go}"${ch == null ? '' : ` data-ch="${ch}"`} role="button" tabindex="0" aria-label="${esc(label)}">` +
    `<rect class="box" x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>` +
    lines.map((s, i) => `<text${i ? ' class="sub"' : ''} x="${x + 6}" y="${y + t[0] + i * t[1]}">${esc(s)}</text>`).join('') + '</g>';
}
/* what each block says, per channel */
function chain(fx, c) {
  const ch = fx.ch[c], q = fx.q[c];
  return [
    ['drive', 'DRIVE', ch.drive ? `${DIST[q.dist] || ''} ${num(ch.drive)}` : 'off', !!ch.drive],
    ['filter', 'FILTER', ch.type ? `${FILTER[ch.type]} ${num(ch.cutoff)}${q.warm ? ' W' : ''}` : 'off', !!ch.type],
    ['lofi', 'LO-FI', ch.crush || ch.decim ? `CR ${num(ch.crush)} DC ${num(ch.decim)}` : 'off', !!(ch.crush || ch.decim)],
    ['lfo', 'LFO', q.lfoDepth ? `${DEST[q.lfoDest] || ''} ${num(q.lfoDepth)}` : 'off', !!q.lfoDepth]];
}
const echoText = fx => fx.echo.mix > 0
  ? `MIX ${num(fx.echo.mix)} FB ${num(fx.echo.feedback)}${fx.echo.mode ? ' PING' : ''}${fx.freeze ? ' FRZ' : ''}` : 'mix 0: off';
/* the reverb (0.9.97; fx.reverb from REVERB_GET, absent on older firmware): on when its mix is up */
const rvOn = fx => !!fx.reverb?.rvMix;
const rvSendOf = (fx, c) => fx.reverb?.rvSend?.[c] || 0;   /* channel c's reverb send (0.9.97-dev.7) */
const rvText = fx => (rvOn(fx) ? `MIX ${num(fx.reverb.rvMix)} ${reverbSeconds(fx.reverb.rvSize).toFixed(1)}s` : 'mix 0: off');

/* upright: G is its geometry (desktop, or compact for phones) */
const UPRIGHT = {W: 600, H: 342, CX: [58, 168, 278, 388], BOX_W: 100, BOX_H: 28, TOP0: 34, STEP: 40, SEND_Y: 200,
  ECHO_X: 448, ECHO_W: 146, MIX_Y: 240, OUT_X: 278, BULGE: 9, T: [12, 12], ECHO_LINES: false};
const COMPACT = {W: 420, H: 372, CX: [46, 134, 222, 310], BOX_W: 82, BOX_H: 34, TOP0: 34, STEP: 42, SEND_Y: 212,
  ECHO_X: 356, ECHO_W: 60, MIX_Y: 276, OUT_X: 222, BULGE: 5, T: [14, 14], ECHO_LINES: true};
function upright(fx, mute, G) {
  const parts = [], echoOn = fx.echo.mix > 0, echoMid = G.ECHO_X + G.ECHO_W / 2;
  for (let c = 0; c < 4; c++) {
    const cx = G.CX[c], x = cx - G.BOX_W / 2, top = k => G.TOP0 + k * G.STEP, ch = fx.ch[c], q = fx.q[c];
    const muted = (mute >> c) & 1, dry = (fx.fxOff >> c) & 1;
    let g = `<g class="row${muted ? ' muted' : dry ? ' dry' : ''}" data-ch="${c}"><line class="wire" x1="${cx}" y1="30" x2="${cx}" y2="${G.MIX_Y}"/>`;
    g += `<text class="ch" x="${cx}" y="14" text-anchor="middle">${CHANNELS[c]}</text>`;
    if (muted || dry) g += `<text class="sub why" x="${cx}" y="26" text-anchor="middle">${muted ? 'MUTED' : 'DRY'}</text>`;
    chain(fx, c).forEach(([go, title, value, on], k) => { g += block(x, top(k), G.BOX_W, G.BOX_H, [title, value], on, go, c, G.T); });
    if (q.lfoDepth && q.lfoDest === 0) {   // to the cutoff: it moves the filter (a loop up the right side)
      const r = x + G.BOX_W, y3 = top(3) + G.BOX_H / 2, y1 = top(1) + G.BOX_H / 2;
      g += `<path class="mod" d="M${r} ${y3} C ${r + G.BULGE} ${y3}, ${r + G.BULGE} ${y1}, ${r} ${y1}"/>`;
    }
    if (ch.send) {
      g += `<path class="send${echoOn ? '' : ' idle'}" d="M${cx} ${G.SEND_Y} H ${G.ECHO_X}"/><circle class="tap" cx="${cx}" cy="${G.SEND_Y}" r="3"/>` +
        `<text class="sub" x="${cx + 5}" y="${G.SEND_Y - 5}">send ${num(ch.send)}</text>`;
    }
    if (rvSendOf(fx, c)) {   /* its reverb send: across to the reverb's line (below the echo sends) */
      const ry = (G.SEND_Y + G.MIX_Y) / 2;
      g += `<path class="send rv${rvOn(fx) ? '' : ' idle'}" d="M${cx} ${ry} H ${G.ECHO_X - 8}"/><circle class="tap" cx="${cx}" cy="${ry}" r="3"/>` +
        `<text class="sub" x="${cx + 5}" y="${ry - 5}">rev ${num(rvSendOf(fx, c))}</text>`;
    }
    parts.push(g + '</g>');
  }
  const e = fx.echo;
  const lines = !G.ECHO_LINES ? ['ECHO (shared)', echoText(fx)] : echoOn
    ? ['ECHO', `MIX ${num(e.mix)}`, `FB ${num(e.feedback)}`, [e.mode ? 'PING' : '', fx.freeze ? 'FRZ' : ''].join(' ').trim()].filter(Boolean)
    : ['ECHO', 'off'];
  const echoH = G.ECHO_LINES ? 4 + lines.length * G.T[1] + 4 : G.BOX_H, echoTop = G.SEND_Y - (G.ECHO_LINES ? 14 : G.BOX_H / 2);
  const echo = block(G.ECHO_X, echoTop, G.ECHO_W, echoH, lines, echoOn, 'echo', null, G.T);
  const compTop = G.MIX_Y + 16;
  const comp = block(G.OUT_X - G.BOX_W / 2, compTop, G.BOX_W, G.BOX_H, ['COMP', fx.comp ? num(fx.comp) : 'off'], !!fx.comp, 'comp', null, G.T);
  /* the reverb level with the compressor, under the echo: the sends down into it, out into the compressor */
  let rv = '';
  if (fx.reverb) {
    const on = rvOn(fx), y = compTop + G.BOX_H / 2, ry = (G.SEND_Y + G.MIX_Y) / 2;
    rv = ([0, 1, 2, 3].some(c => rvSendOf(fx, c)) ? `<path class="send rv${on ? '' : ' idle'}" d="M${G.ECHO_X - 8} ${ry} V ${compTop + 6} H ${G.ECHO_X}"/>` : '') +
      `<line class="wire${on ? '' : ' idle'}" x1="${G.ECHO_X}" y1="${y}" x2="${G.OUT_X + G.BOX_W / 2}" y2="${y}"/>` +
      block(G.ECHO_X, compTop, G.ECHO_W, G.BOX_H, G.ECHO_LINES ? ['REVERB', on ? `MIX ${num(fx.reverb.rvMix)}` : 'off'] : ['REVERB', rvText(fx)], on, 'reverb', null, G.T);
  }
  const bus = `<line class="wire" x1="${G.CX[0]}" y1="${G.MIX_Y}" x2="${echoMid}" y2="${G.MIX_Y}"/>` +
    `<line class="wire${echoOn ? '' : ' idle'}" x1="${echoMid}" y1="${echoTop + echoH}" x2="${echoMid}" y2="${G.MIX_Y}"/>` +
    `<line class="wire" x1="${G.OUT_X}" y1="${G.MIX_Y}" x2="${G.OUT_X}" y2="${compTop}"/>` +
    `<line class="wire" x1="${G.OUT_X}" y1="${compTop + G.BOX_H}" x2="${G.OUT_X}" y2="${compTop + G.BOX_H + 16}"/>` +
    `<text x="${G.OUT_X}" y="${compTop + G.BOX_H + 30}" text-anchor="middle">OUT</text>`;
  const off = fx.bypass ? `<text class="alloff" x="${G.W / 2}" y="${G.H - 6}" text-anchor="middle">ALL FX OFF: dry, mutes still apply</text>` : '';
  return {w: G.W, h: G.H, body: `${parts.join('')}${echo}${bus}${rv}${comp}`, off};
}

/* one row per channel, left to right */
function across(fx, mute) {
  const ROW0 = 30, ROW = 44, BOX_W = 80, BOX_H = 28, X = [60, 150, 240, 330], SEND_X = 440, MIX_X = 610, T = [12, 12], RV_X = 424;
  const parts = [], echoOn = fx.echo.mix > 0, echoY = ROW0 + 4 * ROW;
  for (let c = 0; c < 4; c++) {
    const ch = fx.ch[c], q = fx.q[c], y = ROW0 + c * ROW, top = y - BOX_H / 2;
    const muted = (mute >> c) & 1, dry = (fx.fxOff >> c) & 1;
    let g = `<g class="row${muted ? ' muted' : dry ? ' dry' : ''}" data-ch="${c}"><line class="wire" x1="52" y1="${y}" x2="${MIX_X}" y2="${y}"/>`;
    g += `<text class="ch" x="4" y="${y + 4}">${CHANNELS[c]}</text>`;
    if (muted || dry) g += `<text class="sub why" x="4" y="${y + 16}">${muted ? 'MUTED' : 'DRY'}</text>`;
    chain(fx, c).forEach(([go, title, value, on], k) => { g += block(X[k], top, BOX_W, BOX_H, [title, value], on, go, c, T); });
    if (q.lfoDepth && q.lfoDest === 0)   // to the cutoff: it moves the filter
      g += `<path class="mod" d="M${X[3] + 20} ${top} C ${X[3]} ${top - 10}, ${X[1] + 60} ${top - 10}, ${X[1] + 40} ${top}"/>`;
    if (ch.send) {
      g += `<path class="send${echoOn ? '' : ' idle'}" d="M${SEND_X} ${y} V ${echoY}"/><circle class="tap" cx="${SEND_X}" cy="${y}" r="3"/>` +
        `<text class="sub" x="${SEND_X + 6}" y="${y - 4}">send ${num(ch.send)}</text>`;
    }
    if (rvSendOf(fx, c)) {   /* its reverb send: a tap just before the echo's, down the reverb's line */
      g += `<circle class="tap" cx="${RV_X}" cy="${y}" r="3"/><text class="sub" x="${RV_X - 4}" y="${y + 25}" text-anchor="end">rev ${num(rvSendOf(fx, c))}</text>`;
    }
    parts.push(g + '</g>');
  }
  const echo = block(SEND_X + 20, echoY - BOX_H / 2, 120, BOX_H, ['ECHO (shared)', echoText(fx)], echoOn, 'echo', null, T);
  const comp = block(MIX_X + 12, ROW0 + 1.5 * ROW - BOX_H / 2, 76, BOX_H, ['COMP', fx.comp ? num(fx.comp) : 'off'], !!fx.comp, 'comp', null, T);
  /* the reverb under the compressor: the sends down and round under the echo into it, out up into the compressor */
  let rv = '';
  if (fx.reverb) {
    const on = rvOn(fx), y = ROW0 + 3 * ROW, mid = MIX_X + 50, idle = on ? '' : ' idle';
    const first = [0, 1, 2, 3].find(c => rvSendOf(fx, c));
    rv = (first !== undefined ? `<path class="send rv${idle}" d="M${RV_X} ${ROW0 + first * ROW} V ${echoY + 22} H ${mid} V ${y + BOX_H / 2}"/>` : '') +
      `<line class="wire${idle}" x1="${mid}" y1="${y - BOX_H / 2}" x2="${mid}" y2="${ROW0 + 1.5 * ROW + BOX_H / 2}"/>` +
      block(MIX_X + 12, y - BOX_H / 2, 96, BOX_H, ['REVERB', rvText(fx)], on, 'reverb', null, T);
  }
  const bus = `<line class="wire" x1="${MIX_X}" y1="${ROW0}" x2="${MIX_X}" y2="${echoY}"/>` +
    `<line class="wire${echoOn ? '' : ' idle'}" x1="${SEND_X + 140}" y1="${echoY}" x2="${MIX_X}" y2="${echoY}"/>` +
    `<line class="wire" x1="${MIX_X}" y1="${ROW0 + 1.5 * ROW}" x2="${MIX_X + 12}" y2="${ROW0 + 1.5 * ROW}"/>` +
    `<line class="wire" x1="${MIX_X + 88}" y1="${ROW0 + 1.5 * ROW}" x2="716" y2="${ROW0 + 1.5 * ROW}"/>` +
    `<text x="${MIX_X + 92}" y="${ROW0 + 1.5 * ROW - 6}">OUT</text>`;
  const extra = fx.reverb ? 16 : 0;   /* room for the sends' way round to the reverb */
  const off = fx.bypass ? `<text class="alloff" x="${SEND_X - 20}" y="${ROW0 + 4 * ROW + 30 + extra}">ALL FX OFF: dry, mutes still apply</text>` : '';
  return {w: 720, h: ROW0 + 4 * ROW + 40 + extra, body: `${parts.join('')}${echo}${bus}${rv}${comp}`, off};
}

/* fx: unpackFx(...) (with .freeze from LIVE); mute: bit per channel (LIVE); layout 'v' or 'h' */
export function fxDiagram(fx, {mute = 0, layout = 'v', compact = false} = {}) {
  const d = layout === 'h' ? across(fx, mute) : upright(fx, mute, compact ? COMPACT : UPRIGHT);
  const rows = CHANNELS.map((n, c) => `${n}${(mute >> c) & 1 ? ' muted' : (fx.fxOff >> c) & 1 ? ' dry (Channel FX off)' : ''}`);
  const label = `Effects wiring. ${rows.join('; ')}. Echo ${fx.echo.mix > 0 ? 'on' : 'off'}, ` +
    (fx.reverb ? `reverb ${rvOn(fx) ? 'on' : 'off'}${[0, 1, 2, 3].some(c => rvSendOf(fx, c)) ? ' (sent to by ' +
      CHANNELS.filter((n, c) => rvSendOf(fx, c)).join(', ') + ')' : ''}, ` : '') + `compressor ${fx.comp ? 'on' : 'off'}` +
    (fx.bypass ? '. All FX off.' : '.');
  const kind = layout === 'h' ? 'h' : compact ? 'vc' : 'v';
  return `<svg class="fxd${fx.bypass ? ' bypass' : ''}" data-layout="${kind}" viewBox="0 0 ${d.w} ${d.h}" role="group" aria-label="${label}">` +
    `<g class="chain">${d.body}</g>${d.off}</svg>`;
}
/* the effects page a block opens: its name in pagesForFx (legacy firmware: drive and comp on TONE) */
export function pageFor(go, legacy = false) {
  return legacy ? {drive: 'TONE', comp: 'TONE', filter: 'FILTER', lofi: 'LO-FI', lfo: 'LFO', echo: 'ECHO'}[go]
    : {drive: 'DRIVE', comp: 'MASTER', filter: 'FILTER', lofi: 'LO-FI', lfo: 'LFO', echo: 'ECHO', reverb: 'REVERB'}[go];
}
