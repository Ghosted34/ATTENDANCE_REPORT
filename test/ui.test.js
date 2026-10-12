// The renderer's rules that are invisible to the DOM-free tests but were real defects: an
// untouched field marked red, and the product mark drifting apart between the two places it is
// drawn. Asserted against the stylesheet itself, because that is where both live.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(root, "renderer/app/css/styles.css"), "utf8");

test("a field is only marked red once the user has something to fix", () => {
  // `input:invalid:not(:focus)` paints every empty required field red on load — a sign-in form
  // that opens with two red boxes reads as broken. `:user-invalid` waits for typing or a submit.
  assert.doesNotMatch(css, /input:invalid/, "no rule may key off :invalid (empty counts as invalid)");
  assert.match(css, /input:user-invalid\s*\{[^}]*border-color:\s*var\(--danger\)/,
    "an unusable field is still shown in red, just after the user has been there");
});

test("the product mark is one definition, used by the top bar and the sign-in card", () => {
  // Both draw the same shield through the token, so the card cannot end up with a different mark.
  assert.equal([...css.matchAll(/--mark-mask:\s*url\(/g)].length, 1, "the shield is a token, defined once");
  // Precise on purpose: `-webkit-mask: var(...)` contains "mask: var(...)", and the token itself
  // reads "--mark-mask: url(...)". So count only the plain declarations, and drop the definition
  // before looking for anything that inlines its own copy.
  assert.equal([...css.matchAll(/(?<!-webkit-)mask:\s*var\(--mark-mask\)/g)].length, 2,
    "the top bar's mark and the card's mark both use it");
  assert.doesNotMatch(css.replace(/--mark-mask:\s*url\([^;]*;/g, ""), /mask:\s*url\(/,
    "and neither of them inlines its own copy");
});
