# speed-measure-opencode-plugin

OpenCode TUI のサイドバーに、現在のセッションにおける LLM 応答の Prefill（TTFT）速度と Decode 速度を表示する OpenCode プラグイン。

## 表示例

```
Speed
Prefill: 340 ms │ 2.1k tok/s
Decode:  58.3 tok/s
```

- **Prefill**: 最初のトークンが返るまでの時間（TTFT）と、入力トークン数から算出したプレフィル速度
- **Decode**: 応答生成中のトークン生成速度。ストリーミング中はライブ更新され、完了後に確定値へ切り替わる

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

現在の Prefill 速度計算式は `prefillTokPerSec = tokens.input / (ttft / 1000)` である。vLLM / OpenAI 互換 API では `prompt_tokens` にキャッシュ済みトークンを含む総数が返ることがあり、OpenCode が `tokens.input` にその値をそのまま入れる場合、キャッシュヒット率が高いプロンプトで Prefill 速度が実際より大幅に過大表示される可能性がある（Issue #8 参照、実機検証待ち）。
