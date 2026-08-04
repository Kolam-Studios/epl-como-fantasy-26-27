// Unit tests for lib/text-core.mjs (pure logic, no DB).
// Usage: node scripts/test-text.mjs
import { foldAccents, foldedIncludes } from "../lib/text-core.mjs";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  report(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- plain ASCII match ---
eq("plain ASCII: exact", foldAccents("Arsenal"), "arsenal");
eq("plain ASCII: search hit", foldedIncludes("Arsenal", "arsenal"), true);
eq("plain ASCII: search miss", foldedIncludes("Arsenal", "chelsea"), false);

// --- folded accent match, both directions ---
// "Soucek" (plain ASCII typed) should find "Souček" (accented stored name).
eq("accent: plain search finds accented name (Soucek -> Souček)", foldedIncludes("Souček", "Soucek"), true);
// And the reverse: an accented search string still finds a plain name.
eq("accent: accented search finds plain name (Söucek -> Soucek)", foldedIncludes("Soucek", "Söucek"), true);

// Ø does not NFD-decompose; needs the explicit map. Both directions.
eq("accent: Odegaard finds Ødegaard", foldedIncludes("Ødegaard", "Odegaard"), true);
eq("accent: Ødegaard search finds plain Odegaard", foldedIncludes("Odegaard", "Ødegaard"), true);
eq("accent: foldAccents(Ø) -> o", foldAccents("Ø"), "o");
eq("accent: foldAccents(Ødegaard) -> odegaard", foldAccents("Ødegaard"), "odegaard");

// Other non-decomposing letters the map covers.
eq("accent: fold ł -> l", foldAccents("Łukasz"), "lukasz");
eq("accent: fold đ -> d", foldAccents("Đorđe"), "dorde");
eq("accent: fold æ -> ae", foldAccents("Værland"), "vaerland");
eq("accent: fold ß -> ss", foldAccents("Straße"), "strasse");

// --- case-insensitivity ---
eq("case: mixed case folds to lowercase", foldAccents("MoHaMeD SaLaH"), "mohamed salah");
eq("case: search is case-insensitive", foldedIncludes("Mohamed Salah", "SALAH"), true);

// --- idempotence: folding an already-folded string is a no-op ---
{
  const once = foldAccents("Ødegaard Souček Łukasz Straße");
  const twice = foldAccents(once);
  eq("idempotence: folding a folded string is unchanged", twice, once);
}
{
  const once = foldAccents("Arsenal");
  eq("idempotence: plain ASCII already stable", foldAccents(once), once);
}

// --- empty needle always matches ---
eq("empty needle: always matches", foldedIncludes("Anything", ""), true);

process.exit(failed ? 1 : 0);
