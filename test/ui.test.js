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
// The rules, with the comments removed: a passing mention of a bad pattern in a comment that
// explains why it was removed is not the pattern.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");

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

/* ---------- Contrast, computed rather than claimed ---------- */

// The README says WCAG 2.2 AA. That is a number, so it is checked as one: the tokens are read out
// of the stylesheet and their ratios computed, for the surfaces each one is actually used on.
const tokensOf = (selector) => {
  const start = css.indexOf(selector);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, name, value]) => [name, value]));
};
const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const round = (n) => Math.round(n * 100) / 100;

for (const [theme, selector] of [["light", ":root {"], ["dark", '[data-theme="dark"] {']]) {
  test(`every token that carries words clears 4.5:1 in the ${theme} theme`, () => {
    const t = tokensOf(selector);
    // The worst surface a token can land on decides, not the friendliest one.
    const surfaces = ["surface", "surface-2", "canvas"];
    for (const ink of ["ink-1", "ink-2"]) {
      for (const surface of surfaces) {
        const ratio = contrast(t[ink], t[surface]);
        assert.ok(ratio >= 4.5, `${ink} on ${surface} is ${round(ratio)}:1, needs 4.5:1`);
      }
    }
    for (const [text, background] of [["ok", "ok-soft"], ["danger", "danger-soft"], ["warn", "warn-soft"], ["accent-ink", "accent"]]) {
      const ratio = contrast(t[text], t[background]);
      assert.ok(ratio >= 4.5, `${text} on ${background} is ${round(ratio)}:1, needs 4.5:1`);
    }
  });

  test(`--ink-3 clears the 3:1 non-text floor in the ${theme} theme`, () => {
    const t = tokensOf(selector);
    for (const surface of ["surface", "surface-2", "canvas"]) {
      const ratio = contrast(t["ink-3"], t[surface]);
      assert.ok(ratio >= 3, `ink-3 on ${surface} is ${round(ratio)}:1, needs 3:1`);
    }
  });
}

test("--ink-3 is never used for text", () => {
  // Anything that sets a colour on words uses --ink-2; only the field glyph and the summary
  // separator are allowed to use the non-text token.
  const allowed = [".input-affix .field-icon", ".summary-strip span::after"];
  const offenders = [];
  cssRules.split("\n").forEach((line, index) => {
    if (!line.includes("var(--ink-3)")) return;
    const selector = [...cssRules.slice(0, cssRules.indexOf(line)).matchAll(/(^|\})\s*([^@{}]+)\{/g)].pop()?.[2]?.trim();
    if (!allowed.includes(selector)) offenders.push(`${index + 1}: ${selector}`);
  });
  assert.deepEqual(offenders, [], "these rules use the non-text token for text");
});

test("column widths are not keyed to a position in the table", () => {
  // Columns are per report and per period, so a positional rule lands on whatever happens to sit
  // there — the Name column's width used to end up on Employee ID in the single-date views.
  assert.doesNotMatch(cssRules, /th:nth-child\(\d+\),\s*td:nth-child\(\d+\)\s*\{\s*min-width/,
    "widths belong to the column definition (minWidth), not to nth-child");
});

test("no row asks the browser for its own compositing layer", () => {
  // `will-change: transform` on every row costs a layer per row and buys nothing when nothing is
  // animating — thousands of rows is exactly where that hurts.
  assert.doesNotMatch(cssRules, /will-change/);
});

test("the app icon exists, is big enough for the installer, and is wired into the build", () => {
  const ico = path.join(root, "assets/icon.png");
  assert.ok(fs.existsSync(ico), "assets/icon.png is committed");
  const png = fs.readFileSync(ico);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "it is a PNG");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "8-bit");
  assert.equal(png[25], 6, "RGBA");
  assert.deepEqual([width, height], [512, 512]);
  // electron-builder refuses anything under 256x256, which is a build failure, not a bad icon.
  assert.ok(width >= 256 && height >= 256, "at least 256x256");

  const builder = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.json"), "utf8"));
  const icon = path.join(root, builder.icon || "build/icon.png");
  assert.ok(fs.existsSync(icon), `electron-builder points at ${builder.icon}, which exists`);
  assert.equal(path.relative(root, icon).replace(/\\/g, "/"), "assets/icon.png");
});

test("a group heading sticks under the header, and never on paper", () => {
  // A 31-day grouped report scrolls past its heading; the heading is worth keeping in view, and it
  // has to sit exactly under the sticky column header or it will cover the row above it.
  const row = cssRules.match(/tr\.grp td \{([^}]*)\}/);
  assert.ok(row, "the group heading rule is still there");
  assert.match(row[1], /position:\s*sticky/);
  assert.match(row[1], /top:\s*var\(--table-row-height\)/,
    "the offset is the header's own height, which changes with the density");
  const header = cssRules.match(/\nth \{([^}]*)\}/);
  assert.match(header[1], /position:\s*sticky/, "the header it hides under is sticky too");
  assert.match(header[1], /top:\s*0/);

  // A group heading is one cell spanning the row, so it is also `td:first-child` — the frozen
  // column — which would otherwise paint the scrolling rows on top of the heading labelling them.
  const frozen = cssRules.match(/td:first-child \{[^}]*z-index:\s*(\d+)/);
  const heading = cssRules.match(/tr\.grp td:first-child \{[^}]*z-index:\s*(\d+)/);
  assert.ok(frozen && heading, "both stacking orders are stated");
  assert.ok(Number(heading[1]) > Number(frozen[1]),
    `the heading sits above the rows (${heading[1]} > ${frozen[1]})`);
  const headerZ = cssRules.match(/\nth \{[^}]*z-index:\s*(\d+)/);
  assert.ok(Number(headerZ[1]) > Number(heading[1]),
    `and under the column header (${headerZ[1]} > ${heading[1]})`);

  // The rows a reader cannot see are skipped, and a grouped body is guessed at about a section's
  // height rather than the whole table's, so the scrollbar does not promise what is not there.
  const tableGuess = cssRules.match(/\.table-wrap tbody \{[^}]*contain-intrinsic-size:\s*auto\s+(\d+)px/);
  const sectionGuess = cssRules.match(/\.table-wrap table\.grouped tbody \{[^}]*contain-intrinsic-size:\s*auto\s+(\d+)px/);
  assert.match(cssRules, /\.table-wrap tbody \{[^}]*content-visibility:\s*auto/, "the hint is still there");
  assert.ok(tableGuess && sectionGuess, "both bodies state their guess");
  assert.ok(Number(sectionGuess[1]) < Number(tableGuess[1]),
    `a section is guessed smaller than a whole table (${sectionGuess[1]} < ${tableGuess[1]})`);

  // Print has no viewport: the rule is undone, along with the header's own stickiness.
  const print = cssRules.slice(cssRules.indexOf("@media print"));
  assert.match(print, /tr\.grp td \{\s*position:\s*static\s*!important/,
    "a printed heading does not pin itself to the top of the page");
});
