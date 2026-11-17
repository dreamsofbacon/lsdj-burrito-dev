// SPDX-License-Identifier: GPL-3.0-only
/* "FM-1 1", "FM-1 2": a number each FM-1 keeps while it's plugged in, not its place in the list by port. Windows gives
   an FM-1 new ports when it restarts (a reflash), so by port the two swapped numbers, and the DJ decks' labels with
   them (Colin's DJ test, 2026-11-17). One that comes back takes the lowest number free: its own, when the others
   stayed. Entries are the page's device objects (kept across searches while their ports stay). */
export function fm1Numbers() {
  const nos = new Map();
  return {
    /* the list as found (sorted by port), in number order; new ones numbered in that order */
    renumber(list) {
      for (const d of [...nos.keys()]) if (!list.includes(d)) nos.delete(d);
      for (const d of list) if (!nos.has(d)) {
        const used = new Set(nos.values());
        let n = 1; while (used.has(n)) n++;
        nos.set(d, n);
      }
      return list.slice().sort((a, b) => nos.get(a) - nos.get(b));
    },
    no: d => nos.get(d) ?? null,
  };
}
