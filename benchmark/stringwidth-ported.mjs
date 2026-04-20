// Exact port of rolldown@1.0.0-rc.16 dist/shared/rolldown-build-*.mjs:2790-2886
// (the inlined copy of string-width@7.x + its deps)
// Used to measure the cost of stringWidth on chunk-like file paths at scale.

const ansiRegex = () =>
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(string) {
  const regex = ansiRegex();
  return string.replace(regex, '');
}

function isAmbiguous(x) {
  // (truncated, omitted for bench — not on hot path for ASCII paths)
  return false;
}
function isFullWidth(x) {
  return x === 12288 || (x >= 65281 && x <= 65376) || (x >= 65504 && x <= 65510);
}
function isWide(x) {
  return (
    (x >= 4352 && x <= 4447) ||
    x === 8986 ||
    x === 8987 ||
    x === 9001 ||
    x === 9002
  );
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  if (isFullWidth(codePoint) || isWide(codePoint) || (ambiguousAsWide && isAmbiguous(codePoint))) return 2;
  return 1;
}

// Real emoji regex from string-width — simplified to representative size
const emojiRegex = () =>
  /[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?/g;

const segmenter = globalThis.Intl?.Segmenter
  ? new Intl.Segmenter()
  : { segment: (str) => str.split('') };

const defaultIgnorableCodePointRegex = /^\p{Default_Ignorable_Code_Point}$/u;

export function stringWidthFull(string, options = {}) {
  if (typeof string !== 'string' || string.length === 0) return 0;
  const { ambiguousIsNarrow = true, countAnsiEscapeCodes = false } = options;
  if (!countAnsiEscapeCodes) string = stripAnsi(string);
  if (string.length === 0) return 0;

  let width = 0;
  const eastAsianWidthOptions = { ambiguousAsWide: !ambiguousIsNarrow };

  for (const { segment: character } of segmenter.segment(string)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) continue;
    if ((codePoint >= 8203 && codePoint <= 8207) || codePoint === 65279) continue;
    if (
      (codePoint >= 768 && codePoint <= 879) ||
      (codePoint >= 6832 && codePoint <= 6911) ||
      (codePoint >= 7616 && codePoint <= 7679) ||
      (codePoint >= 8400 && codePoint <= 8447) ||
      (codePoint >= 65056 && codePoint <= 65071)
    )
      continue;
    if (codePoint >= 55296 && codePoint <= 57343) continue;
    if (codePoint >= 65024 && codePoint <= 65039) continue;
    if (defaultIgnorableCodePointRegex.test(character)) continue;
    if (emojiRegex().test(character)) {
      width += 2;
      continue;
    }
    width += eastAsianWidth(codePoint, eastAsianWidthOptions);
  }
  return width;
}

// The "patched" version — short-circuit to string.length
export function stringWidthPatched(string, options = {}) {
  if (typeof string !== 'string' || string.length === 0) return 0;
  const { countAnsiEscapeCodes = false } = options;
  if (!countAnsiEscapeCodes) string = stripAnsi(string);
  return string.length;
}
