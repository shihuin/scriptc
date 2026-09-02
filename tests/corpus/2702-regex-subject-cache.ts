// The regex UTF-16 subject cache: the last four converted subjects stay
// converted, so loop-matching the same string pays the O(n) UTF-8→UTF-16
// walk once, not per call. This program pins the correctness contract:
// cache hits must be byte-identical to fresh conversions, in-place append
// (the s += x idiom) must invalidate (the appended suffix is unconverted),
// and released strings must purge (a recycled address never serves a
// stale buffer for its new occupant).
const line = "2026-08-14T07:21:35Z INFO auth req=1234 dur=42ms user=user12 status=200";
const re = /dur=(\d+)ms/;
// Same subject, repeated matching — every call a cache hit after the first.
let hits = 0;
for (let i = 0; i < 1000; i++) {
  const m = re.exec(line);
  if (m && m[0] === "dur=42ms") hits++;
}
console.log("hits:", hits, re.test(line));
// Multiple subjects interleave through the four cache slots.
const lines = [
  "alpha beta gamma delta",
  "Alpha Beta Gamma Delta",
  "αβγ δεζ ηθικ",
  "astral 𝐀𝐁𝐂 pair 𝒳",
  "fifth subject evicts the first",
];
const anchored = /(alpha|αβγ|astral)/i;
for (let r = 0; r < 5; r++) {
  for (const l of lines) anchored.test(l);
}
for (const l of lines) console.log(anchored.test(l));
// Invalidation by in-place append: a subject that grows under the cache.
let log = "start 0";
for (let i = 1; i <= 8; i++) log += ` item${i}`;
// The append left the same address with new bytes; matching must see the
// WHOLE current string (a stale cached buffer would miss the tail items).
const tail = /item8/;
console.log("tail after appends:", tail.test(log), log.indexOf("item8"));
// Purge by release: subjects created and dropped in a loop — recycled
// addresses must never answer for a different string's content.
for (let i = 0; i < 32; i++) {
  const s = `pattern-${i % 4 === 0 ? "odd" : "even"}-${i}`;
  if (!/pattern-(odd|even)-\d+/.test(s)) {
    console.log("purge-fail", i);
    break;
  }
}
console.log("purge loop done");
// replace/matchAll/split ride the same cache; results must stay exact.
console.log("2026-08-14T07:21:35Z".replace(/(\d{2}):(\d{2}):(\d{2})/, "[$1$2$3]"));
console.log("a1b2c3".split(/\d/).join(","));
let count = 0;
for (const m of line.matchAll(/\d+/g)) count++;
console.log("matchAll digits:", count);
