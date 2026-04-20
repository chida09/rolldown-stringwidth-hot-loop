// Uses the REAL string-width@7.2.0 (the same version rolldown inlines).
// Measures actual cost on realistic chunk-log lines at scale.

import stringWidth from 'string-width';
import { performance } from 'node:perf_hooks';

function stringWidthFast(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  return s.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  ).length;
}

function makeChunkPaths(count) {
  const paths = [];
  const rand = (() => {
    let seed = 1;
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 0) / 0x80000000;
    };
  })();
  for (let i = 0; i < count; i++) {
    const hash = rand().toString(36).slice(2, 10);
    const name = [
      'chunk',
      'components',
      'iframe',
      'react-dom',
      'axe',
      'card',
      'error-fallback',
      'poll-error-boundary-fallback',
      'internal-server-error',
      'profile-page',
    ][i % 10];
    paths.push(`dist/storybook/app/assets/${name}-${String(i).padStart(4, '0')}-${hash}.js`);
  }
  return paths;
}

function makeLogLines(chunkPaths) {
  return chunkPaths.map(
    (p, i) => `│  ${p}   ${(1 + (i % 500)).toFixed(2).padStart(7)} kB │ gzip: ${(i * 0.37).toFixed(2).padStart(7)} kB`,
  );
}

function bench(fn, iterations = 1) {
  const start = performance.now();
  let result = 0;
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }
  const elapsed = performance.now() - start;
  return { elapsed, result, per_call_us: (elapsed * 1000) / iterations };
}

console.log('# Real string-width@7.2.0 (same version rolldown bundles) benchmark');
console.log(`# Node: ${process.version}`);
console.log('');
console.log('N lines | chars/line | real (ms) | fast (ms) | ratio | per-line µs (real)');
console.log('--------|------------|-----------|-----------|-------|-------------------');

for (const n of [100, 500, 1000, 2000, 5000, 10000, 20000]) {
  const paths = makeChunkPaths(n);
  const lines = makeLogLines(paths);
  const charsPerLine = Math.round(lines.reduce((s, l) => s + l.length, 0) / lines.length);

  // Warmup
  for (const line of lines) stringWidth(line);
  for (const line of lines) stringWidthFast(line);

  const real = bench(() => {
    let sum = 0;
    for (const line of lines) sum += stringWidth(line);
    return sum;
  });
  const fast = bench(() => {
    let sum = 0;
    for (const line of lines) sum += stringWidthFast(line);
    return sum;
  });

  const ratio = (real.elapsed / Math.max(fast.elapsed, 0.001)).toFixed(1);
  const perLine = ((real.elapsed * 1000) / n).toFixed(1);
  console.log(
    `${String(n).padStart(7)} | ${String(charsPerLine).padStart(10)} | ${real.elapsed.toFixed(2).padStart(9)} | ${fast.elapsed
      .toFixed(2)
      .padStart(9)} | ${ratio.padStart(5)}x | ${perLine.padStart(18)}`,
  );
}

console.log('');
console.log('# The private app build emitted 9,399 modules and 1,515 chunks.');
console.log('# If Rolldown/consola calls stringWidth N times per line × M log events,');
console.log("# the total calls required to explain a 6+ min hang (~360s) given per-call cost of ~8µs");
console.log('# is 360 / 8e-6 = 45M calls. That far exceeds any reasonable per-chunk formatting budget.');
console.log('#');
console.log('# => stringWidth alone cannot explain the full hang.');
console.log('# But it CAN be a meaningful fraction (~10-30%) of the CPU time, matching the profile.');
