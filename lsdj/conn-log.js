// SPDX-License-Identifier: GPL-3.0-only
// What happened to the FM-1 connections, kept for reading afterwards (the status lines change too fast to read
// mid-set): the last LOG_MAX events with their times, in this browser only (localStorage), shown in the DJ layout.
// A 'conn-log' event says when it changed.
const KEY = 'lsdj-burrito-conn-log', LOG_MAX = 80;
let entries = (() => { try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l.slice(-LOG_MAX) : []; } catch { return []; } })();
let last = '', lastAt = 0;
export function logEvent(text) {
  text = String(text || '').trim();
  if (!text) return;
  const t = Date.now();
  if (text === last && t - lastAt < 2000) return;   /* the same line again at once: once */
  last = text; lastAt = t;
  entries.push({t, text});
  if (entries.length > LOG_MAX) entries = entries.slice(-LOG_MAX);
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* this visit only */ }
  try { document.dispatchEvent(new Event('conn-log')); } catch { /* no page */ }
}
export const logEntries = () => entries.slice();
export function clearLog() {
  entries = []; last = '';
  try { localStorage.removeItem(KEY); } catch { /* this visit only */ }
  try { document.dispatchEvent(new Event('conn-log')); } catch { /* no page */ }
}
const two = n => String(n).padStart(2, '0');
export const logTime = t => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
export const logText = () => entries.map(e => `${logTime(e.t)}  ${e.text}`).join('\n');
/* 0.9.98-dev.26: a script error on the page goes in the Log too (the DJ decks' BPM went blank once until a reload, and
   nothing said why): its message and first place, each one at most once a minute and at most 10 a visit, so a loop
   that fails every tick can't push the FM-1 lines out of the Log. */
const errSaid = new Map();
let errCount = 0;
function logPageError(what, err) {
  const msg = String(err?.message || err || 'unknown').split('\n')[0].slice(0, 160);
  const at = String(err?.stack || '').split('\n').map(s => s.trim()).find(s => /^at |@/.test(s)) || '';
  const where = (at.match(/([\w.-]+\.m?js):(\d+)/) || []).slice(1, 3).join(':');
  const key = msg + where, t = Date.now();
  if (errCount >= 10 || t - (errSaid.get(key) ?? -Infinity) < 60000) return;
  errSaid.set(key, t); errCount++;
  logEvent(`Page error (${what}): ${msg}${where ? ` at ${where}` : ''}. A reload usually clears it; please send this line.`);
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('error', e => logPageError('script', e.error || e.message));
  window.addEventListener('unhandledrejection', e => logPageError('promise', e.reason));
}
