// Pure text-matching helpers shared by every accent-insensitive search in the
// app (console nomination search, waiver-form free-agent search, the ledger
// filter's club search). Plain JS with JSDoc types, no fs, no globals, so
// plain node scripts and tests can use the exact same logic without a build
// step, same convention as the other *-core.mjs modules.

/**
 * Letters NFD decomposition does not split into a base letter plus a
 * combining mark. Extended one entry at a time as real names surface a gap
 * (Odegaard/Ø, Soucek's caron IS handled by NFD already).
 * @type {Record<string, string>}
 */
const NON_DECOMPOSING = {
  "ø": "o",
  "Ø": "o",
  "ł": "l",
  "Ł": "l",
  "đ": "d",
  "Đ": "d",
  "æ": "ae",
  "Æ": "ae",
  "ß": "ss",
};

/**
 * Fold a string to a plain-ASCII, lowercase form for accent-insensitive
 * matching: NFD-decompose then strip combining diacritical marks, mapping the
 * handful of letters NFD does not decompose (see NON_DECOMPOSING) before that
 * decomposition runs. Idempotent: folding an already-folded string returns it
 * unchanged.
 * @param {string} s
 * @returns {string}
 */
export function foldAccents(s) {
  let out = String(s ?? "");
  for (const [from, to] of Object.entries(NON_DECOMPOSING)) {
    out = out.split(from).join(to);
  }
  return out
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * True if `haystack` contains `needle` once both are accent-folded. Empty
 * needle always matches (an empty search box shows everything).
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function foldedIncludes(haystack, needle) {
  const n = foldAccents(needle);
  if (!n) return true;
  return foldAccents(haystack).includes(n);
}
