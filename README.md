# rolldown `stringWidth` hot-loop investigation

Evidence that `rolldown@1.0.0-rc.15 / rc.16` inlines `string-width@7.x` (via `consola`) into its build bundle, where `Intl.Segmenter` + `RegExp.prototype.test` account for ~38% of main-thread CPU during the reporter / post-chunk-emission phase of a large Vite 8 build.

Captured while investigating a ~6-minute post-chunk-emission hang observed on a private Nx monorepo (`~9,400` modules / `~1,515` emitted chunks) running `@storybook/nextjs-vite@10.3.5` + `vite@8.0.8`.

> [!NOTE]
> **Scope of this claim.** The CPU profile and benchmarks show that the inlined `stringWidth` is **one major contributor** to the hang — enough to explain roughly 10–40% of the observed CPU time depending on how often it is called per chunk. They do **not** prove that fixing `stringWidth` alone would eliminate the hang; the full 6-minute duration implies there is at least one other amplifier on top. The fix proposed below is still worthwhile on its own: it's a large, easily-measurable constant factor that every Rolldown-backed Vite 8 consumer pays.

## What's in this repo

| Path | Purpose |
|---|---|
| `benchmark/run-bench-real.mjs` | Measures `string-width@7.2.0` cost on chunk-log-shaped lines at N = 100…20,000. |
| `benchmark/run-bench-varlen.mjs` | Confirms O(n) scaling in character count (50ch → 2000ch ≈ 27× runtime). |
| `benchmark/run-bench.mjs` + `benchmark/stringwidth-ported.mjs` | Independent port of Rolldown's inlined copy vs a `.length` fast path — reproduces the same 90-100× gap without the `string-width` dep. |
| `benchmark/*.log` | Recorded outputs from macOS / Apple M2 Max / Node 24.13. |
| `cpu-profile/hung-build-stack-summary.txt` | Main-thread call graph + top-of-stack summary from a 15-second `sample <pid>` run captured while the hung private build was pinned at 100% CPU. |

## Quick results

```
$ node benchmark/run-bench-real.mjs

N lines | chars/line | real (ms) | fast (ms) | ratio  | per-line µs (real)
--------|------------|-----------|-----------|--------|-------------------
    100 |         89 |      1.00 |      0.03 |  35.4x |               10.0
   1000 |         89 |      8.24 |      0.08 |  98.2x |                8.2
  10000 |         89 |     88.96 |      0.91 |  97.4x |                8.9
  20000 |         90 |    181.21 |      1.76 | 102.9x |                9.1
```

```
$ node benchmark/run-bench-varlen.mjs

chars/line | total (ms) | per-call µs | ratio vs 50ch
        50 |      52.78 |         5.3 |          1.00x
       600 |     439.04 |        43.9 |          8.32x
      2000 |    1408.39 |       140.8 |         26.68x
```

- `string-width` is **90-100× slower** than `string.replace(ansiRegex, '').length`.
- Scales linearly with input length (each grapheme walks ICU `RuleBasedBreakIterator` + multiple `RegExp.test` calls).

## The CPU profile

Every one of the 8,006 main-thread samples collected during the hung build had this shape:

```
rolldown-binding.darwin-arm64.node                ← Rust native
  napi_call_function                               ← Rust → JS boundary
    v8::Function::Call
      (15+ × InterpreterEntryTrampoline)
        Builtins_ArrayMap                          ← .map() callback
          [JIT-compiled JS]
            Builtin_SegmentIteratorPrototypeNext   ← Intl.Segmenter.next()
              icu_77::RuleBasedBreakIterator::next
                BreakCache::populateFollowing
                  handleNext
```

Top-of-stack aggregates (15-second sample, 8,006 ticks):

| Function | Ticks | % of main thread |
|---|---|---|
| `Builtins_RegExpPrototypeTestFast` | 961 | 12.0% |
| `icu_77::RuleBasedBreakIterator::handleNext` | 880 | 11.0% |
| `v8::internal::JSSegmentIterator::Next` | 513 | 6.4% |
| `v8::internal::Builtin_SegmentIteratorPrototypeNext` | 253 | 3.2% |
| `icu_77::RuleBasedBreakIterator::next` | 233 | 2.9% |
| `BreakCache::populateFollowing` | 210 | 2.6% |
| **Intl.Segmenter + ICU + RegExp.test combined** | **~3,050** | **~38%** |

See `cpu-profile/hung-build-stack-summary.txt` for the full excerpt.

## Where the inlined code lives

A grep of the entire `node_modules` tree of the affected private build turned up exactly one file using `Intl.Segmenter`:

```
node_modules/.pnpm/rolldown@1.0.0-rc.15/node_modules/rolldown/dist/shared/rolldown-build-*.mjs
```

Lines 2822–2846 are an inlined copy of `string-width@7.x` — the essential shape:

```js
for (const { segment: character } of segmenter.segment(string)) {
  // ... codePoint range checks ...
  if (defaultIgnorableCodePointRegex.test(character)) continue;
  if (emojiRegex().test(character)) { width += 2; continue; }
  width += eastAsianWidth(codePoint, eastAsianWidthOptions);
}
```

(ICU break iteration per grapheme + two `RegExp.test` calls + a numeric range check, done for every string that reaches `FancyReporter`.)

The only in-bundle call site is `FancyReporter.formatLogObj` at line 2914: `stringWidth(left) - stringWidth(right)` on every log message.

`FancyReporter` comes from `consola`, transitively pulled in on the **programmatic build path** (not CLI-only) via:

- [`utils/bindingify-output-options.ts#L7`](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/utils/bindingify-output-options.ts#L7) imports the logger from [`cli/logger.ts`](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/cli/logger.ts#L1) (which does `createConsola()` at module top level).
- The same file then calls `logger.warn(...)` for deprecation/conflict diagnostics — [first one at L49](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/utils/bindingify-output-options.ts#L49), with several more through L272.

Rolldown's build step inlines all of it into `dist/shared/rolldown-build-*.mjs`, so any consumer importing `RolldownBuild` — Vite 8 included — drags in the whole `FancyReporter` + `string-width` subtree, and every `logger.warn` runs through `stringWidth(left) + stringWidth(right)`.

## Candidate fix

**Primary:** drop `consola` from the programmatic build path by replacing the `logger.warn` calls in `utils/bindingify-output-options.ts` with `console.warn`. This removes the entire `FancyReporter` + `string-width` subtree from the build bundle. `cli/logger.ts` can keep using consola unchanged so the CLI's fancy output isn't affected. Smallest blast radius, largest runtime win for every Rolldown-backed Vite consumer.

<details>
<summary>Alternatives if the primary fix is rejected</summary>

- **ASCII fast-path in the inlined `stringWidth`**: match `/^[\x00-\x7F]*$/` and fall through to `string.replace(ansiRegex, '').length`. Chunk paths and ASCII log lines skip Segmenter entirely.
- **Upstream fix in `sindresorhus/string-width` or `unjs/consola`**: widest benefit but slowest to reach consumers — depends on upstream release cadence **and** Rolldown rebuilding its bundle.

</details>

## Workaround (for users hitting the hang today)

Pin `vite` to `7.3.2` (Rollup-based, no Rolldown, all April 2026 security advisories patched):

```json
{
  "devDependencies": {
    "@vitejs/plugin-react": "5.2.0"
  },
  "pnpm": {
    "overrides": {
      "vite": "7.3.2"
    }
  }
}
```

`@vitejs/plugin-react@6.x` peer-requires `vite@^8`, so downgrade to `5.2.0` (peer range `^4.2 || ^5 || ^6 || ^7 || ^8`).

## Environment

- OS: macOS 15.7.4 (Apple M2 Max, arm64). Also reproduced in GitHub Actions Ubuntu 24.04 arm64.
- Node: v24.13.0 (benchmark) / v24.14.1 (CI)
- pnpm: 10.27.0
- `rolldown`: `1.0.0-rc.15` — same inlined code in `rc.16` (current as of 2026-04).
- `vite`: `8.0.8` (hangs) / `7.3.2` (builds cleanly).

## Running the benchmark yourself

```bash
pnpm install
node benchmark/run-bench-real.mjs
node benchmark/run-bench-varlen.mjs
node benchmark/run-bench.mjs  # port without string-width dep
```

## Reproducing the CPU profile

The snapshot in `cpu-profile/hung-build-stack-summary.txt` was captured on macOS with `sample`, which attaches to a running process without killing it (Node's `--cpu-prof` flag doesn't help here because it only writes the profile on graceful exit — a hung build has to be `SIGKILL`ed):

```bash
# Start the hung build in one terminal (substitute your own --config-dir / --output-dir)
node ./node_modules/storybook/dist/bin/dispatcher.js build \
  --config-dir <your-storybook-config-dir> \
  --output-dir <your-output-dir> \
  --quiet

# In another terminal, once CPU is pinned at ~100% after the "chunks are larger" warning:
sample <pid> 15 -file /tmp/stacks.txt

# Key sections of the output:
grep -n "^Call graph:" /tmp/stacks.txt         # per-thread tree with all inclusive counts
grep -n "^Sort by top of stack" /tmp/stacks.txt  # aggregated top-of-stack hotspots
```

## External references

- [rolldown/rolldown](https://github.com/rolldown/rolldown) — dep chain origin. I searched for duplicate reports using `hang`, `stringWidth`, `Intl.Segmenter`, `100% CPU`, `chunks are larger`, etc. The open `hang`-labeled issues (e.g. [#3890](https://github.com/rolldown/rolldown/issues/3890)) are all watch-mode / dev-server scoped — none match the post-chunk-emission build-hang pattern here.
- [unjs/consola](https://github.com/unjs/consola) — `FancyReporter.formatLogObj` is the in-bundle call site.
- [sindresorhus/string-width](https://github.com/sindresorhus/string-width) — the `Intl.Segmenter`-per-grapheme pattern. Open issues are correctness-focused ([#62](https://github.com/sindresorhus/string-width/issues/62), [#75](https://github.com/sindresorhus/string-width/issues/75)); no performance-specific tracker.
