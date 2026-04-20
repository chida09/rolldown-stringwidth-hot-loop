[English](./README.md) | 日本語

# rolldown `stringWidth` ホットループ調査

`rolldown@1.0.0-rc.15 / rc.16` は `string-width@7.x` を（`consola` 経由で）ビルドバンドルにインライン化している。その結果、大規模な Vite 8 ビルドの reporter / post-chunk-emission フェーズで `Intl.Segmenter` + `RegExp.prototype.test` がメインスレッド CPU の約 38% を占める、という証拠集です。

調査のきっかけは、private な Nx monorepo（約 9,400 modules / 1,515 emitted chunks、`@storybook/nextjs-vite@10.3.5` + `vite@8.0.8`）で観測された約 6 分の post-chunk-emission ハングです。

> [!NOTE] > **本主張のスコープ**: CPU プロファイルとベンチマークは、インライン化された `stringWidth` がハングの **主要な要因の 1 つ** であることを示している — 1 チャンクあたり何回呼ばれるかに応じて、観測された CPU 時間の 10〜40% 程度を説明できる規模。ただし、`stringWidth` を直せば 6 分ハングが単独で消えるという証明にはなっていない。長いハング時間は、少なくとも 1 つ別の増幅要因がある可能性を示唆する。それでも、以下で提案する修正は単独で価値がある — Rolldown 経由の Vite 8 consumer 全員が支払う、測定可能で大きな定数項だから。

## このリポジトリの内容

| Path                                                           | 役割                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `benchmark/run-bench-real.mjs`                                 | `string-width@7.2.0` のコストを N = 100…20,000 のチャンクログ形文字列で計測。                                            |
| `benchmark/run-bench-varlen.mjs`                               | 文字数に対する O(n) スケーリングを確認（50ch → 2000ch で約 27 倍）。                                                     |
| `benchmark/run-bench.mjs` + `benchmark/stringwidth-ported.mjs` | Rolldown のインライン版を独立に移植し、`.length` fast-path と比較。`string-width` 依存なしでも同じ 90-100 倍の差を再現。 |
| `benchmark/*.log`                                              | macOS / Apple M2 Max / Node 24.13 での実測ログ。                                                                         |
| `cpu-profile/hung-build-stack-summary.txt`                     | ハング中ビルドの 15 秒 `sample <pid>` スナップショット。メインスレッドのコールグラフと top-of-stack 集計。               |

## クイック結果

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

- `string-width` は `string.replace(ansiRegex, '').length` より **90〜100 倍遅い**。
- 入力文字数に対して線形スケール（各グラフェムで ICU `RuleBasedBreakIterator` を歩き、複数の `RegExp.test` を実行するため）。

## CPU プロファイル

ハング中ビルドから収集した 8,006 個のメインスレッドサンプルは、すべて以下の形:

```
rolldown-binding.darwin-arm64.node                ← Rust native
  napi_call_function                               ← Rust → JS 境界
    v8::Function::Call
      (15+ × InterpreterEntryTrampoline)
        Builtins_ArrayMap                          ← .map() callback
          [JIT-compiled JS]
            Builtin_SegmentIteratorPrototypeNext   ← Intl.Segmenter.next()
              icu_77::RuleBasedBreakIterator::next
                BreakCache::populateFollowing
                  handleNext
```

Top-of-stack 集計（15 秒サンプル、8,006 tick）:

| Function                                             | Ticks        | % メインスレッド |
| ---------------------------------------------------- | ------------ | ---------------- |
| `Builtins_RegExpPrototypeTestFast`                   | 961          | 12.0%            |
| `icu_77::RuleBasedBreakIterator::handleNext`         | 880          | 11.0%            |
| `v8::internal::JSSegmentIterator::Next`              | 513          | 6.4%             |
| `v8::internal::Builtin_SegmentIteratorPrototypeNext` | 253          | 3.2%             |
| `icu_77::RuleBasedBreakIterator::next`               | 233          | 2.9%             |
| `BreakCache::populateFollowing`                      | 210          | 2.6%             |
| **Intl.Segmenter + ICU + RegExp.test の合計**        | **約 3,050** | **約 38%**       |

完全な出力は `cpu-profile/hung-build-stack-summary.txt` を参照。

## インライン化されたコードの所在

影響を受けた private build の `node_modules` ツリー全体を `Intl.Segmenter` で grep したところ、該当ファイルはただ 1 つでした:

```
node_modules/.pnpm/rolldown@1.0.0-rc.15/node_modules/rolldown/dist/shared/rolldown-build-*.mjs
```

L2822〜2846 が `string-width@7.x` のインライン版で、本質的な形はこれ:

```js
for (const { segment: character } of segmenter.segment(string)) {
  // ... codePoint の範囲チェック ...
  if (defaultIgnorableCodePointRegex.test(character)) continue;
  if (emojiRegex().test(character)) {
    width += 2;
    continue;
  }
  width += eastAsianWidth(codePoint, eastAsianWidthOptions);
}
```

（グラフェム単位の ICU break iteration + `RegExp.test` 2 回 + 数値範囲チェックを、`FancyReporter` に到達するすべての文字列に対して実行）

バンドル内で唯一の呼び出し元は L2914 の `FancyReporter.formatLogObj`: 各ログメッセージで `stringWidth(left) - stringWidth(right)` を実行。

`FancyReporter` は `consola` から来ており、**プログラマティックビルド経路**（CLI 限定ではない）経由で推移的に引き込まれる:

- [`utils/bindingify-output-options.ts#L7`](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/utils/bindingify-output-options.ts#L7) が [`cli/logger.ts`](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/cli/logger.ts#L1) から logger を import（`cli/logger.ts` はモジュールトップレベルで `createConsola()` を実行）。
- 同ファイルは deprecation / conflict 警告として `logger.warn(...)` を複数回呼ぶ — [最初は L49](https://github.com/rolldown/rolldown/blob/v1.0.0-rc.16/packages/rolldown/src/utils/bindingify-output-options.ts#L49)、L272 まで数箇所。

Rolldown のビルド step はこれらをすべて `dist/shared/rolldown-build-*.mjs` にインライン化する。そのため `RolldownBuild` を import する consumer（Vite 8 を含む）は、`FancyReporter` + `string-width` サブツリー全体を引きずり込み、すべての `logger.warn` が `stringWidth(left) + stringWidth(right)` を経由する。

## 修正候補

**メイン案**: `utils/bindingify-output-options.ts` の `logger.warn` を `console.warn` に置き換えて、プログラマティックビルド経路から `consola` を外す。これで `FancyReporter` + `string-width` サブツリー全体がビルドバンドルから消える。`cli/logger.ts` は consola を使ったままで良いので、CLI の装飾出力は影響なし。変更範囲は最小、Rolldown 経由の Vite consumer 全員にとってのランタイム改善は最大。

<details>
<summary>メイン案が却下された場合の代替</summary>

- **インライン化された `stringWidth` に ASCII fast-path を追加**: `/^[\x00-\x7F]*$/` にマッチしたら `string.replace(ansiRegex, '').length` を返すだけ。チャンクパスや ASCII ログ行は Segmenter を完全にバイパスできる。
- **`sindresorhus/string-width` または `unjs/consola` の upstream を修正**: 最も広い恩恵だが consumer に届くのが最も遅い — upstream のリリースサイクルと Rolldown のバンドル再生成の両方に依存。

</details>

## Workaround（今日このハングを踏んでいる人向け）

`vite` を `7.3.2`（Rollup ベース、Rolldown なし、2026 年 4 月のセキュリティアドバイザリはすべて patched 済み）に pin する:

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

`@vitejs/plugin-react@6.x` は peer に `vite@^8` を要求するので、`5.2.0`（peer range `^4.2 || ^5 || ^6 || ^7 || ^8`）にダウングレードする必要があります。

## 環境

- OS: macOS 15.7.4（Apple M2 Max, arm64）。GitHub Actions Ubuntu 24.04 arm64 でも再現。
- Node: v24.13.0（ベンチマーク）/ v24.14.1（CI）
- pnpm: 10.27.0
- `rolldown`: `1.0.0-rc.15` — `rc.16`（2026-04 時点の current）にも同じインラインコードが含まれる。
- `vite`: `8.0.8`（ハング）/ `7.3.2`（正常ビルド）。

## ベンチマークを自分で走らせる

```bash
pnpm install
node benchmark/run-bench-real.mjs
node benchmark/run-bench-varlen.mjs
node benchmark/run-bench.mjs  # string-width 依存なしの移植版
```

## CPU プロファイルを再現する

`cpu-profile/hung-build-stack-summary.txt` のスナップショットは macOS の `sample` で取得。`sample` は実行中のプロセスにアタッチして kill せずにスタックを採取できる（Node の `--cpu-prof` フラグは graceful exit 時にしか書き出されないため、`SIGKILL` が必要なハングしたビルドでは使えない）:

```bash
# 別のターミナルでハング中ビルドを起動（--config-dir / --output-dir は自分のパスに置き換え）
node ./node_modules/storybook/dist/bin/dispatcher.js build \
  --config-dir <your-storybook-config-dir> \
  --output-dir <your-output-dir> \
  --quiet

# "chunks are larger" 警告の後 CPU が 100% に張り付いたら、別のターミナルで:
sample <pid> 15 -file /tmp/stacks.txt

# 出力の主要セクション:
grep -n "^Call graph:" /tmp/stacks.txt         # per-thread ツリー（全 inclusive counts）
grep -n "^Sort by top of stack" /tmp/stacks.txt  # 集計済みの top-of-stack ホットスポット
```

## 外部参照

- [rolldown/rolldown](https://github.com/rolldown/rolldown) — 依存チェーンの起点。`hang`、`stringWidth`、`Intl.Segmenter`、`100% CPU`、`chunks are larger` などで重複報告を検索済み。`hang` ラベルが付いた既存の open issue（例: [#3890](https://github.com/rolldown/rolldown/issues/3890)）はすべて watch-mode / dev-server 限定で、本件の post-chunk-emission build-hang パターンには該当しない。
- [unjs/consola](https://github.com/unjs/consola) — `FancyReporter.formatLogObj` がバンドル内の呼び出し元。
- [sindresorhus/string-width](https://github.com/sindresorhus/string-width) — グラフェムごとに `Intl.Segmenter` を回すパターン。open issue は正確性寄り（[#62](https://github.com/sindresorhus/string-width/issues/62), [#75](https://github.com/sindresorhus/string-width/issues/75)）で、パフォーマンス専用のトラッカーは無い。
