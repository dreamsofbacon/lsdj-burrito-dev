// SPDX-License-Identifier: GPL-3.0-only
// A cart's label (the crate, lsdj/crate-ui.js, and Studio › Build's cards, lsdj/studio-ui.js): its colour (one of CART_COLORS, or
// any colour as #rrggbb) and its picture (an image file, made small on this computer and kept in this browser's file
// library as kind 'img'; never uploaded).
import {CART_COLORS} from './crate.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };

export const IMG_SIDE = 240;   /* a picture's longest side, in pixels, once made small */
export const IMG_MAX = 96 * 1024;   /* its bytes at most (JPEG quality steps down until it fits) */
export const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
/* the text colour on a label of that colour: dark on light colours */
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16), [r, g, b] = [n >> 16, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#2a2925' : '#fff';
}
/* a label element in that colour: a preset by data-color (index.html), any other colour by --lab / --lab-ink */
export function paintLabel(box, color) {
  if (isHex(color)) { box.dataset.color = 'custom'; box.style.setProperty('--lab', color); box.style.setProperty('--lab-ink', inkFor(color)); }
  else { box.dataset.color = CART_COLORS.includes(color) ? color : 'grey'; box.style.removeProperty('--lab'); box.style.removeProperty('--lab-ink'); }
}

/* an image file -> JPEG bytes, at most IMG_SIDE on its longest side and IMG_MAX bytes; throws for a file that isn't
   a picture the browser can read */
export async function shrinkImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw Error(`${file.name || 'That file'} isn't a picture this browser can read.`); }
  const k = Math.min(1, IMG_SIDE / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = Object.assign(document.createElement('canvas'), {width: w, height: h}), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);   /* (a transparent PNG: on white, as JPEG has no transparency) */
  g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    if (blob && (blob.size <= IMG_MAX || q === 0.4)) return new Uint8Array(await blob.arrayBuffer());
  }
  throw Error('That picture could not be made small enough.');
}

/* object URLs for pictures by library id (made once, kept for the visit) */
const urls = new Map();
export function imageUrl(id, bytes) {
  if (!id || !bytes) return null;
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'})));
  return urls.get(id);
}

/* the label editor: colour swatches, Custom… (any colour), Picture… / No picture.
   {color, hasImage, name}; onColor(color), onImage(file), onNoImage() */
export function labelEditor({color, hasImage, name = 'Cart', onColor, onImage, onNoImage}) {
  const box = el('div', {className: 'cart-label-edit', role: 'group', ariaLabel: `${name}: label`});
  const sw = c => {
    const b = el('button', {type: 'button', className: 'cart-swatch' + (c === color ? ' on' : ''), title: c, ariaLabel: `Colour ${c}`, onclick: () => onColor(c)});
    b.setAttribute('aria-pressed', String(c === color)); b.dataset.color = c;
    return b;
  };
  const custom = el('input', {type: 'color', className: 'cart-custom', value: isHex(color) ? color : '#c0453a', title: 'Any colour',
    onchange: () => onColor(custom.value.toLowerCase())});
  custom.setAttribute('aria-label', `${name}: any colour`);
  if (isHex(color)) custom.classList.add('on');
  const file = el('input', {type: 'file', accept: 'image/*', hidden: true, onchange: () => { const f = file.files?.[0]; file.value = ''; if (f) onImage(f); }});
  box.append(el('span', {className: 'cart-swatches'}, ...CART_COLORS.map(sw), custom),
    el('span', {className: 'cart-pic-acts'},
      el('button', {type: 'button', textContent: hasImage ? 'Change picture…' : 'Picture…', onclick: () => file.click(), title: 'A picture for the label (kept in this browser)'}),
      hasImage ? el('button', {type: 'button', textContent: 'No picture', onclick: () => onNoImage()}) : null, file));
  return box;
}
