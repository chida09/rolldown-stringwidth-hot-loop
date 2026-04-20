// Vary chars-per-line to test scaling behavior.
import stringWidth from 'string-width';
import { performance } from 'node:perf_hooks';

function bench(fn, iterations = 1) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - start;
}

console.log('# stringWidth cost vs line length (10,000 calls each)');
console.log('');
console.log('chars/line | total (ms) | per-call µs | ratio vs 50ch');

let baseline = 0;
for (const len of [50, 92, 150, 300, 600, 1000, 2000]) {
  const line = 'x'.repeat(len);
  // Warmup
  for (let i = 0; i < 100; i++) stringWidth(line);
  const ms = bench(() => {
    for (let i = 0; i < 10000; i++) stringWidth(line);
  });
  if (baseline === 0) baseline = ms;
  const perCall = (ms * 1000) / 10000;
  const ratio = (ms / baseline).toFixed(2);
  console.log(`${String(len).padStart(10)} | ${ms.toFixed(2).padStart(10)} | ${perCall.toFixed(1).padStart(11)} | ${ratio.padStart(13)}x`);
}

console.log('');
console.log('# Confirm O(n) scaling in characters:');
console.log('# 50ch → 2000ch is 40x longer, expected ~40x runtime if O(n)');
