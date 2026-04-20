import { stringWidthFull, stringWidthPatched } from './stringwidth-ported.mjs';
import { performance } from 'node:perf_hooks';

function makeChunkPaths(count) {
  // App-like chunk paths: "dist/storybook/app/assets/<name>-<hash>.js"
  const paths = [];
  for (let i = 0; i < count; i++) {
    const hash = Math.random().toString(36).slice(2, 10);
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
  // Mimics consola FancyReporter formatLogObj's "left" param:
  // e.g. "│  dist/storybook/app/assets/chunk-0001-abcdef12.js  408.26 kB │ gzip: 162.53 kB"
  return chunkPaths.map(
    (p, i) => `│  ${p}   ${(1 + (i % 500)).toFixed(2).padStart(7)} kB │ gzip: ${(i * 0.37).toFixed(2).padStart(7)} kB`,
  );
}

function bench(label, fn, iterations = 1) {
  const start = performance.now();
  let result = 0;
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }
  const elapsed = performance.now() - start;
  return { label, elapsed, result, per_call_us: (elapsed * 1000) / iterations };
}

const sizes = [100, 500, 1000, 2000, 5000, 10000];

console.log('# stringWidth micro-benchmark');
console.log('# Context: rolldown@1.0.0-rc.15/rc.16 inlines string-width@7.x in dist/shared/rolldown-build-*.mjs');
console.log('# stringWidthFull = exact port of rolldown inlined version');
console.log('# stringWidthPatched = .length fast-path (what our local patch does)');
console.log('');
console.log('N chunks | chars/line | full (ms) | patched (ms) | ratio | full per-line µs');
console.log('---------|------------|-----------|--------------|-------|------------------');

for (const n of sizes) {
  const paths = makeChunkPaths(n);
  const lines = makeLogLines(paths);
  const charsPerLine = Math.round(lines.reduce((s, l) => s + l.length, 0) / lines.length);

  // Warmup
  for (const line of lines) stringWidthFull(line);
  for (const line of lines) stringWidthPatched(line);

  // Measure
  const full = bench('full', () => {
    let sum = 0;
    for (const line of lines) sum += stringWidthFull(line);
    return sum;
  });
  const patched = bench('patched', () => {
    let sum = 0;
    for (const line of lines) sum += stringWidthPatched(line);
    return sum;
  });

  const ratio = (full.elapsed / Math.max(patched.elapsed, 0.001)).toFixed(1);
  const perLine = ((full.elapsed * 1000) / n).toFixed(1);
  console.log(
    `${String(n).padStart(8)} | ${String(charsPerLine).padStart(10)} | ${full.elapsed
      .toFixed(2)
      .padStart(9)} | ${patched.elapsed.toFixed(2).padStart(12)} | ${ratio.padStart(5)}x | ${perLine.padStart(15)}`,
  );
}

console.log('');
console.log('# Projection: if App emits 9,399 chunks and FancyReporter.formatLogObj');
console.log('# calls stringWidth twice per line (left + right), total stringWidth calls = ~18,800.');
console.log('# Scaled cost = (full_per_line_us * 18,800) / 1000 ms');
