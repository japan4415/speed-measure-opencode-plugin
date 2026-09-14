# speed-measure-opencode-plugin

OpenCode TUI のサイドバーに、現在のセッションにおける LLM 応答の Prefill（TTFT）速度と Decode 速度を表示する OpenCode プラグイン。

## 表示例

ストリーミング中:

```
Speed
Prefill: 340 ms
Decode:  ~45.2 chars/s
```

完了後:

```
Speed
Prefill: 340 ms │ 2.1k tok/s
Decode:  58.3 tok/s
```

- **Prefill**: 最初のトークンが返るまでの時間（TTFT）と、入力トークン数から算出したプレフィル速度
- **Decode**: ストリーミング中は生成済み文字数を経過時間で割った概算値（`chars/s`）がライブ更新され、完了後は API が返したトークン数に基づく確定値（`tok/s`）へ切り替わる

## インストール

```bash
npm install
npm run build
```

`npm run build` により `dist/index.js` が生成される。`~/.config/opencode/tui.jsonc` にそのパスを登録する。

```jsonc
{
  "plugin": [
    "/path/to/speed-measure-opencode-plugin/dist/index.js"
  ]
}
```

`@opentui/solid` の bun-plugin は `.tsx` / `.jsx` のみを変換対象とするため、事前ビルド済みの `dist/index.js` は追加変換なしでそのまま読み込まれる。

## 設定

`~/.config/opencode/speed-measure.json` を作成すると表示をカスタマイズできる。ファイルが無い場合や不正な値の場合は既定値にフォールバックする。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `showTTFT` | boolean | `true` | Prefill 行に TTFT（ms）を表示するか |
| `showAverages` | boolean | `false` | セッション全体の平均値を表示するか |
| `showCache` | boolean | `false` | キャッシュ関連の値を表示するか |
| `liveIntervalMs` | number | `150` | ストリーミング中の live 更新間隔（ミリ秒） |
| `order` | number | `150` | サイドバー内での表示順（builtin の `internal:sidebar-context` は `order=100`） |

## 開発

```bash
npm test        # vitest によるユニットテスト
npm run typecheck  # tsc --noEmit
npm run build    # tsup + Solid universal 変換で dist/index.js を生成
```

## 既知の制限

プレフィックスキャッシュによる Prefill 速度の過大表示（Issue #19）は対策済みである。`tokens.cache.read` が報告される場合はキャッシュ分を入力トークン数から差し引き、報告されず算出値が 500,000 tok/s を超える場合は異常値として速度を表示せず TTFT のみ表示する。ただし、閾値以下に収まるキャッシュ由来の歪みは検出できず、将来の高速なハードウェアや小さいモデルで正当に 500,000 tok/s を超えた場合も速度が省略される。
