# speed-measure-opencode-plugin 設計書

> OpenCode TUI (v1.18.30) のサイドバーにモデル速度を表示するプラグイン。
> Prefill（プロンプト処理）と Decode（出力生成）の2行で表示する。

---

## 1. 目的と表示仕様

### 1.1 Prefill / Decode の定義

**Prefill（プロンプト処理フェーズ）**

- **TTFT** (Time To First Token) = `t1 − t0` (ms)
  - `t0 = session.next.step.started` のサーバータイムスタンプ
  - `t1 = session.next.reasoning.started` と `session.next.text.started` のうち早い方のサーバータイムスタンプ（"first token"）
  - `session.next.reasoning.started` / `.delta` / `.ended` の存在は `types.gen.d.ts` lines 788/798/808 で確認済み。旧バージョンの OpenCode (v1.15.0 未満) では v1 fallback に切り替わる
  - 両値とも `session.next.*` イベントのサーバータイムスタンプを使用（network jitter によるクライアント側ずれを排除）
- **Prefill 速度** = `tokens.input / (TTFT / 1000)` tok/s
  - OpenCode 1.18.30 の `tokens.input` は既にキャッシュ読み出し分を除いた値であり、`tokens.cache.read` とは互いに素である（合計式は `input + output + reasoning + cache.read + cache.write`、根拠: `docs/research/web.md:239`）。したがって `cached_tokens` を報告する Anthropic / OpenAI / Google / Bedrock では Prefill 速度を正しく算出できる
  - `cached_tokens` を報告しないプロバイダ（実測したローカル vLLM など）では `tokens.input` が全プロンプトトークンになる一方、キャッシュにより TTFT だけが短縮されるため、Prefill 速度が過大になる
  - `tokens.input <= 0` の場合、または算出値が `500,000 tok/s` を超える場合は速度を利用不能（`null`）とし、TTFT のみ表示する。上限値は極端な異常値を抑える緩和策であり、キャッシュ歪みの完全な検出手段ではない
  - `showCache: true` 設定時は `tokens.cache.read` を副表示として別途示す
  - `tokens.cache.write` も `tokens.input` とは互いに素であり、合計トークン数では独立した加算項として扱う

**Decode（出力生成フェーズ）**

- **Decode 速度** = `(tokens.output + tokens.reasoning) / (decode_time / 1000)` tok/s
  - `decode_time = step_ended.timestamp − t1 − tool_busy` (ms)
  - `t1` は first token タイムスタンプ（§1.1 TTFT と同じマーカー：reasoning.started / text.started のうち早い方）
  - `tool_busy` は、`[t1, step_ended.timestamp]` に含まれるツール実行区間を clamp し、重複を union でマージした合計長。並列ツールで重なる区間は一度だけ減算する
  - **`step.ended` は全 tool fiber が settle した後に publish される。** このため `step_ended.timestamp − t1` をそのまま decode 時間に使うとツール実行時間が丸ごと混入し、速度を大きく過小評価する。除外が必須である
  - ツール実行区間の開始は `tool.called`（= tool-input 生成が終わった後）。tool 呼び出しの**引数生成時間は decode 窓に残している**。分子の `tokens.output` が tool-call 引数トークンを含むため、引数生成を除外すると意味的整合が崩れる
  - `decode_time <= 0` の場合は `decodeTokPerSec = 0` とする
  - reasoning トークンを分子に含める理由：reasoning はデコードフェーズで順次生成されるトークンであり、総スループットの一部。vLLM の thinking モードでは reasoning が先行するため除外すると速度が過小評価される

### 1.2 サイドバーブロックのレイアウト

```
Speed                          ← bold、theme.text 色
Prefill: 340 ms │ 2.1k tok/s  ← theme.textMuted 色
Decode:  58.3 tok/s            ← theme.textMuted 色
```

builtin の `internal:sidebar-context`（order=100）の直後、order=150 に挿入する。

### 1.3 状態別表示

| 状態 | Prefill 行 | Decode 行 |
|------|-----------|----------|
| idle（初期） | `Prefill: --` | `Decode:  --` |
| prefilling | `Prefill: …` | `Decode:  --` |
| decoding (ライブ) | `Prefill: 340 ms` | `Decode:  ~45.2 chars/s` |
| done (確定) | `Prefill: 340 ms │ 2.1k tok/s` | `Decode:  58.3 tok/s` |
| done (Prefill 速度が利用不能) | `Prefill: 340 ms` | `Decode:  58.3 tok/s` |
| done + avg 表示 | `Prefill: 340 ms (avg 280 ms)` | `Decode:  58.3 (avg 52) tok/s` |
| error/abort | `Prefill: error` | `Decode:  error` |

> **注記**: `done` および `error` 状態は `session.status (idle)` イベントを受け取っても次の `session.next.step.started` まで維持される。ターン完了後の確定値はアイドル中も表示し続ける。アイドルへの遷移は `prefilling`/`decoding` の中断時のみ発生する。
> `showTTFT: false` かつ Prefill 速度が利用不能の場合は、情報のない空行を避けるため `Prefill: --` と表示する。

### 1.4 数値フォーマット

```
tok/s < 1000    → "58.3 tok/s"   (小数1桁)
tok/s ≥ 1000   → "1.2k tok/s"   (小数1桁)
tok/s ≥ 10000  → "12k tok/s"    (整数)
TTFT            → "340 ms"       (整数 ms)
```

k 表記の小数1桁は `Number.prototype.toFixed(1)` に基づき、二進浮動小数点の丸め結果に従う。

### 1.5 マルチステップターン（ツールコールを含む場合）

- ツールコールを含むターンは複数の step が発生する（各 step に固有の `session.next.step.*` イベント列）
- **直近の text 生成ステップの値**を主表示とし、`showAverages: true` 時は同一 `assistantMessageID` 内の全ステップ平均を副表示する
- テキストを生成しないステップ（ツール実行のみ）は Prefill/Decode メトリクスを記録しない
- 1 つの step の途中でツールが実行される場合、そのツール実行区間を decode 時間から除外する（§3.4）。`step.ended` はツール実行完了後に発火するため、区間を除外しないと decode 速度が過小になる
- `props.session_id` と一致する `sessionID` のイベントのみ処理し、subagent セッションの値を親セッションのサイドバーに混入させない

---

## 2. アーキテクチャ

### 2.1 ファイルレイアウト

```
speed-measure-opencode-plugin/
├── src/
│   ├── index.tsx        # プラグインエントリ + sidebar_content slot コンポーネント
│   ├── collector.ts     # 純粋状態機械（JSX なし・テスト容易）
│   └── format.ts        # 数値フォーマット関数
├── test/
│   ├── collector.test.ts
│   ├── format.test.ts
│   └── fixtures/        # 実 vLLM セッションから記録したイベント列 JSON
│       ├── simple-text.json
│       ├── tool-call.json
│       └── reasoning.json
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── scripts/
│   └── transform-solid.mjs # バンドル後の Solid universal 変換
└── vitest.config.ts
```

### 2.2 ビルド方針：tsup の JSX preserve + Solid universal 事前変換

ビルドを採用する理由：モジュール分割でユニットテストが容易、TypeScript 型チェックで API シグネチャの誤りを事前検出、`dist/index.js` を npm package の `main` として公開できる。

tsup 8.x のトップレベル `jsx: "preserve"` は `Options` 型に存在せず無効である。このため `esbuildOptions` 内で `options.jsx = "preserve"` を指定し、`splitting: false` で `.tsup-out/index.js` へ単一ファイルとしてバンドルする。続けて `babel-preset-solid` を `moduleName: "@opentui/solid"`、`generate: "universal"` で実行し、変換に成功したコードだけを一時ファイルから `dist/index.js` へ rename する。この Babel 設定は `@opentui/solid@0.5.11` の `scripts/solid-transform.js` と同一である。中間出力と公開先を分離するため、Babel が失敗しても生 JSX を含む中間成果物が `dist/index.js` に残らず、直前の正常な配布物を保持できる。

esbuild の automatic JSX 変換は採用しない。automatic では `<text>{value()}</text>` が `jsx("text", { children: value() })` となり、`value()` がランタイムの effect より先に評価されるため、シグナル依存が登録されずライブ表示が更新されない。Solid universal 変換後は、同じ子要素が `_$insert(_el$, value)`、動的 prop が `_$effect(... value() ...)` となり、読み取りがリアクティブスコープ内に保たれる。

OpenCode の実行時変換にも依存しない。`@opentui/solid` の `solid-transform.js` は `/\.[cm]?[jt]sx$/` に一致する `.tsx` / `.jsx` だけへ Solid preset を適用するため、配布物の `.js` は対象外である。案 A（`dist/index.tsx`）と案 B（`src/index.tsx` の直接配布）はこの制約には適合するが、案 C の事前変換が実測で成立し、Issue #3 の `dist/index.js` 要件も維持できるため採用しない。

`tsconfig.json` の `jsx: "preserve"` / `jsxImportSource: "@opentui/solid"` は型検査と tsup の第一段変換に対応し、最終段は上記 Solid universal 変換に統一する。

```ts
// tsup.config.ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  splitting: false,
  clean: true,
  // OpenCode ランタイムが注入するので外部化（バンドルしない）
  external: [
    "@opentui/solid",
    "solid-js",
    "solid-js/store",
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
  ],
  esbuildOptions(options) {
    options.jsx = "preserve";
    options.logOverride = {
      ...options.logOverride,
      "unsupported-jsx-comment": "silent",
    };
  },
  target: "esnext",
  outDir: ".tsup-out",
});
```

### 2.3 package.json 主要フィールド

```json
{
  "name": "speed-measure-opencode-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist"],
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.15.0"
  },
  "devDependencies": {
    "@babel/core": "^7.28.0",
    "@opencode-ai/plugin": "1.18.30",
    "@opencode-ai/sdk": "1.18.30",
    "@opentui/solid": "^0.5.11",
    "babel-preset-solid": "^1.9.12",
    "tsup": "^8.3.6",
    "vitest": "^2.1.8",
    "typescript": "^5.7.3"
  },
  "scripts": {
    "build": "tsup && node scripts/transform-solid.mjs",
    "prepack": "npm run build",
    "test":  "vitest run"
  }
}
```

### 2.4 tui.jsonc 登録例

```jsonc
// ~/.config/opencode/tui.jsonc
{
  "plugin": [
    "./herdr-tui-session.js",
    "./node_modules/speed-measure-opencode-plugin/dist/index.js"
  ]
}
```

npm 公開後は `opencode plugin speed-measure-opencode-plugin --global` でインストール。

---

## 3. 計測ロジックの状態機械

### 3.1 型定義

```ts
// src/collector.ts

export type IdleState       = { phase: "idle" };
export type PrefillingState = {
  phase: "prefilling";
  sessionID: string; assistantMessageID: string; t0: number;
};
export type ToolInterval = {
  callID: string;
  start: number;
  end?: number;    // 未完了（実行中）の間は absent
};
export type DecodingState = {
  phase: "decoding";
  sessionID: string; assistantMessageID: string;
  t0: number; t1: number; ttft: number;
  liveChars: number; liveEstimate: number | null;
  toolIntervals?: ToolInterval[];   // この step でツールを観測した場合のみ存在
};
export type DoneState = {
  phase: "done";
  sessionID: string;
  ttft: number;
  prefillTokPerSec: number | null;   // null = tokens.input が 0 またはフォールバック
  decodeTokPerSec: number;
};
export type ErrorState = { phase: "error"; sessionID: string };

export type StepState = IdleState | PrefillingState | DecodingState | DoneState | ErrorState;

export type SessionMetrics = {
  current: StepState;
  stepHistory: DoneState[];   // 同一 assistantMessageID 内の完了ステップ
};

export type CollectorState = Map<string, SessionMetrics>;  // key = sessionID
```

### 3.2 イベント → 状態遷移テーブル

**Primary path（v2 サーバータイムスタンプ、`session.next.*` イベント）**

| イベント | 遷移前 | 遷移後 | アクション |
|---------|--------|--------|-----------|
| `session.next.step.started` | any | prefilling | t0 = ev.properties.timestamp |
| `session.next.reasoning.started` | prefilling | decoding | t1 = timestamp（first token）; ttft = t1 − t0 |
| `session.next.reasoning.delta` | decoding | decoding | liveChars += delta.length |
| `session.next.text.started` | prefilling | decoding | t1 = timestamp（first token）; ttft = t1 − t0 |
| `session.next.text.delta`   | decoding | decoding | liveChars += delta.length |
| `session.next.tool.called`  | decoding | decoding | toolIntervals に `{ callID, start }` を追加（開始は引数生成後。引数生成時間は decode 窓に残す） |
| `session.next.tool.success` / `session.next.tool.failed` | decoding | decoding | 一致する開いた区間を `end` で閉じる |
| `session.next.step.ended`   | decoding | done | `decodeTokPerSec = (output + reasoning) / ((timestamp − t1 − tool_busy) / 1000)`; stepHistory に追加 |
| `session.next.step.ended`   | prefilling | idle | テキストなしステップ → 無視 |
| `session.next.step.failed`  | any | error | |
| `session.status` (idle)     | prefilling / decoding | idle | prefilling / decoding の中断時のみ遷移。done / error は次の step.started まで維持する |
| `session.error`             | any | error | |

> **`session.next.step.ended` の発火タイミング（decode 時間の前提）**
>
> OpenCode は step 内のすべての tool fiber が settle した後に `session.next.step.ended` を publish する。
> このため `step.ended.timestamp − t1` にはツール実行時間が丸ごと混入する。decode 時間は
> `tool_busy`（`[t1, step.ended.timestamp]` に clamp したツール実行区間を union でマージした合計長）を
> 減算して求める。並列ツールで重なる区間は二重に引かない。
>
> ツール実行区間の開始は `session.next.tool.called`（= tool-input 生成が終わった後）、終了は
> `session.next.tool.success` / `session.next.tool.failed`。tool 呼び出しの引数生成時間は decode 窓に残す
> （分子の `tokens.output` が tool-call 引数トークンを含むため）。

> **イベントペイロード（`types.gen.d.ts` より確認済み）**
>
> | イベント | 主要 properties | 行 |
> |---------|----------------|-----|
> | `session.next.reasoning.started` | `{ timestamp, sessionID, assistantMessageID, reasoningID, providerMetadata? }` | 788 |
> | `session.next.reasoning.delta` | `{ timestamp, sessionID, assistantMessageID, reasoningID, delta: string }` | 798 |
> | `session.next.step.failed` | `{ timestamp, sessionID, assistantMessageID, error: SessionErrorUnknown }` | 750 |
> | `session.status` | `{ sessionID: string; status: SessionStatus }` — sessionID は非 optional | 1217 |
> | `session.error` | `{ sessionID?: string; error?: ... }` — sessionID は **optional** | 990 |
>
> `session.next.reasoning.started` が先着した場合は `t1` がそのタイムスタンプになり、後着の `text.started` は decoding 状態で受け取るため `t1` を上書きしない。
>
> `session.error` の `sessionID` が absent の場合は、全 in-flight（prefilling/decoding）セッションを error 状態にする。
>
> `api.lifecycle.signal`（`AbortSignal`、`tui.d.ts` line 413）: `onDispose` のコールバックと同等のクリーンアップを `signal.addEventListener('abort', cleanup)` で登録できる。v1 fallback の `setTimeout` 内処理を早期キャンセルする場合も `signal.aborted` を起点にできる。

**Fallback path（v2 イベントが来ない場合、起動後 2 秒タイムアウトで切り替え）**

```ts
let useV2 = false;
const unsubDetect = api.event.on("session.next.step.started", () => { useV2 = true; });
setTimeout(() => {
  unsubDetect();
  if (!useV2) activateV1Fallback(api, setSessionMetrics, collector);
}, 2000);

function activateV1Fallback(...) {
  // message.part.updated (step-start part) → t0 = Date.now()
  // message.part.delta (field="text", first occurrence) → t1 = Date.now()
  // message.part.updated (tool part) → state.time.start で区間開始、state.time.end で区間終了
  // message.part.updated (step-finish part) → tokens, decodeTokPerSec = tokens / ((now − t1 − tool_busy) / 1000)
}
```

v1 fallback では `tokens.input` は `StepFinishPart.tokens.input` から取得。`TextPart.time.start` は optional のため信頼しない。
v1 fallback のツール区間は tool part の `state.time.start` / `state.time.end`（クライアント時刻ではなく SDK が記録した時刻）から取得し、
v2 と同じ `tool_busy` の union 減算を適用する。

### 3.3 ライブデコード推定

```ts
// collector.ts の tick() メソッド（setInterval から呼ばれる）
tick(state: CollectorState, now: number = Date.now()): CollectorState {
  const updated = new Map(state);
  for (const [sid, m] of updated) {
    if (m.current.phase !== "decoding") continue;
    // 閉じていないツール区間がある間は直前の liveEstimate を凍結する
    const running = (m.current.toolIntervals ?? []).some((i) => i.end === undefined);
    const est = running
      ? m.current.liveEstimate
      : (() => {
          const elapsed = (now - m.current.t1) / 1000;
          return elapsed > 0.1 ? m.current.liveChars / elapsed : null;
        })();
    updated.set(sid, { ...m, current: { ...m.current, liveEstimate: est } });
  }
  return updated;
}
```

閉じていないツール区間がある間は、経過時間だけが伸びて `chars/s` が 0 へ引きずられるため、
直前の `liveEstimate` を凍結する。ツール終了後の次の tick で再計算される。

`liveEstimate` は文字数÷経過秒であり、表示単位は `chars/s` とする。確定値は
`step_ended` のトークン数から計算して `tok/s` と表示する。文字数とトークン数の比は
入力内容やモデルに依存するため、固定係数では換算せず、ライブ値と確定値を異なる単位で
明示して同一尺度であるという誤認を防ぐ。

### 3.4 decodeTokPerSec 計算

```ts
// session.next.step.ended ハンドラ内
// t1 = first token タイムスタンプ（reasoning.started または text.started のうち早い方）
// toolBusyMs = [t1, stepEndedTs] に clamp したツール実行区間の union 長（並列の重複は1回だけ数える）
const toolBusy = toolBusyMs(current.toolIntervals, t1, stepEndedTs);
const decodeTimeSec = (stepEndedTs - t1 - toolBusy) / 1000;
const decodeTokPerSec = decodeTimeSec > 0
  ? (tokens.output + tokens.reasoning) / decodeTimeSec
  : 0;
const calculatedPrefillTokPerSec = ttft > 0 && tokens.input > 0
  ? tokens.input / (ttft / 1000)
  : null;
const prefillTokPerSec = calculatedPrefillTokPerSec !== null
  && calculatedPrefillTokPerSec <= 500_000
    ? calculatedPrefillTokPerSec
    : null;
```

`toolBusyMs` は各区間を `[t1, stepEndedTs]` へ clamp し、`end` の無い未完了区間は `stepEndedTs` で閉じたものとして扱う。
`[t1, stepEndedTs]` が空になる区間（`end <= start`）は除外し、開始時刻でソートしたうえで重なる区間を union に統合して合計長を返す。
分母が 0 以下なら `decodeTokPerSec = 0` とする。

---

## 4. 描画

### 4.1 SolidJS シグナル設計

> **SolidJS ではコンポーネント本体は一度しか実行されないため、シグナルは JSX 式の中（またはそこから呼ばれる関数内）で読む。**

```tsx
// src/index.tsx
/** @jsxImportSource @opentui/solid */
import { createSignal, createRoot } from "solid-js";
import { SpeedCollector } from "./collector.js";
import { formatSpeed, formatTTFT } from "./format.js";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";

export default {
  id: "speed-measure.sidebar",
  tui: async (api) => {
    const config = await loadConfig();   // ~/.config/opencode/speed-measure.json

    createRoot((dispose) => {
      const collector = new SpeedCollector();
      const [sessionMetrics, setSessionMetrics] =
        createSignal<CollectorState>(new Map());

      const setM = (fn: (prev: CollectorState) => CollectorState) =>
        setSessionMetrics(fn);

      // --- Primary v2 イベント購読 ---
      let useV2 = false;
      const unsubs: Array<() => void> = [];

      const unsubDetect = api.event.on("session.next.step.started", (ev) => {
        useV2 = true;
        setM((m) => collector.onStepStarted(m, ev.properties));
      });
      unsubs.push(unsubDetect);
      setTimeout(() => { if (!useV2) activateV1Fallback(); }, 2000);

      unsubs.push(api.event.on("session.next.reasoning.started", (ev) =>
        setM((m) => collector.onReasoningStarted(m, ev.properties))));
      unsubs.push(api.event.on("session.next.reasoning.delta", (ev) =>
        setM((m) => collector.onReasoningDelta(m, ev.properties))));
      unsubs.push(api.event.on("session.next.text.started", (ev) =>
        setM((m) => collector.onTextStarted(m, ev.properties))));
      unsubs.push(api.event.on("session.next.text.delta", (ev) =>
        setM((m) => collector.onTextDelta(m, ev.properties))));
      unsubs.push(api.event.on("session.next.step.ended", (ev) =>
        setM((m) => collector.onStepEnded(m, ev.properties))));
      unsubs.push(api.event.on("session.next.step.failed", (ev) =>
        setM((m) => collector.onStepFailed(m, ev.properties))));
      unsubs.push(api.event.on("session.status", (ev) => {
        if ((ev.properties as any).status?.type === "idle")
          setM((m) => collector.onIdle(m, (ev.properties as any).sessionID));
      }));
      unsubs.push(api.event.on("session.error", (ev) => {
        // sessionID は optional: absent の場合は null を渡して全 in-flight セッションを error にする
        const sid = ev.properties.sessionID ?? null;
        setM((m) => collector.onSessionError(m, sid));
      }));

      // --- ライブ更新タイマー ---
      const liveTimer = setInterval(
        () => setM((m) => collector.tick(m)),
        config.liveIntervalMs ?? 150
      );

      // --- サイドバースロット登録 ---
      api.slots.register({
        order: config.order ?? 150,
        slots: {
          sidebar_content(_ctx, props) {
            // TuiSlotContext = { theme: TuiTheme } (tui.d.ts line 394)
            // TuiTheme.current: TuiThemeCurrent — text/textMuted/primary/error/success 等が RGBA (lines 218–280)
            const theme = _ctx.theme.current;
            // シグナルはアクセサ関数として定義し、JSX 内で評価させる
            const state = () =>
              sessionMetrics().get(props.session_id)?.current ?? { phase: "idle" as const };

            const prefillLine = (): string => {
              const s = state();
              switch (s.phase) {
                case "idle":       return "Prefill: --";
                case "prefilling": return "Prefill: …";
                case "decoding":   return `Prefill: ${formatTTFT(s.ttft)}`;
                case "done": {
                  const spd = s.prefillTokPerSec != null
                    ? ` │ ${formatSpeed(s.prefillTokPerSec)}` : "";
                  return `Prefill: ${formatTTFT(s.ttft)}${spd}`;
                }
                default:           return "Prefill: error";
              }
            };

            const decodeLine = (): string => {
              const s = state();
              switch (s.phase) {
                case "idle":
                case "prefilling": return "Decode:  --";
                case "decoding": {
                  const est = s.liveEstimate;
                  return est != null
                    ? `Decode:  ~${stripSpeedUnit(formatSpeed(est))} chars/s`
                    : "Decode:  …";
                }
                case "done":  return `Decode:  ${formatSpeed(s.decodeTokPerSec)}`;
                default:      return "Decode:  error";
              }
            };

            return (
              <box>
                <text fg={theme.text}><b>Speed</b></text>
                <text fg={theme.textMuted}>{prefillLine()}</text>
                <text fg={theme.textMuted}>{decodeLine()}</text>
              </box>
            );
          },
        },
      });

      api.lifecycle.onDispose(() => {
        unsubs.forEach((u) => u());
        clearInterval(liveTimer);
        dispose();
      });
    });
  },
} satisfies { id: string; tui: TuiPlugin };
```

### 4.2 テーマカラーと幅制約

アクセスパス `_ctx.theme.current.text`（`RGBA` 型）は `TuiSlotContext = { theme: TuiTheme }` / `TuiTheme.current: TuiThemeCurrent`（`tui.d.ts` lines 394/273）で確認済み。`text`、`textMuted`、`primary`、`error`、`success` 等の色トークンがすべて `RGBA` 型として定義されている。

- ヘッダ: `theme.text`（`fg` prop）、`<b>` タグで太字
- データ行: `theme.textMuted`
- サイドバー幅は概ね 30〜40 文字。最長行の例:
  `Prefill: 1234 ms │ 12.3k tok/s` = 32 文字（収まる）
- 平均値併記時は 2 行に分けて表示するか、省略記法（`(a:280ms)` など）を使用する

### 4.3 注意：Solid primitives のインポートパス

- **`solid-js`**: Solid primitives（`createSignal`、`createRoot` 等）の標準ソース。`tsup.config.ts` の `external` リストに含まれており、OpenCode ランタイムが注入する
- **`@opentui/solid`**: JSX ランタイム・ホスト要素（`<box>`、`<text>` 等）を提供するパッケージ。型検査とビルド時検証のため devDependency に置き、実行時は OpenCode 側の同パッケージを使うためバンドルから外す。`/** @jsxImportSource @opentui/solid */` は JSX の型付けに使用し、実コードは §2.2 の Solid universal 変換で事前コンパイルする

実装時は jimicze/opencode-plugin-tps の `.tsx` ソースを参照し、`solid-js` と `@opentui/solid` の実際の役割分担を確認すること。

---

## 5. 設定・永続化

### 5.1 設定ファイル

`~/.config/opencode/speed-measure.json`（省略可、デフォルト値で動作）:

```json
{
  "showTTFT": true,
  "showAverages": false,
  "showCache": false,
  "liveIntervalMs": 150,
  "order": 150
}
```

プラグイン起動時に非同期読み込み。読み込み失敗・パース失敗時はデフォルト値を使用（非フェータル）。

### 5.2 api.kv によるセッション平均の永続化

`api.kv` は全プラグイン共有のため、`speed-measure:` プレフィックスで衝突を防ぐ（docs/research/web.md §2 確認済み）。

`TuiKV` の型定義（`tui.d.ts` lines 282–286）:

```ts
type TuiKV = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value;
  set: (key: string, value: unknown) => void;
  readonly ready: boolean;   // boolean であり Promise ではない — await 不可
};
```

削除メソッドは存在しない。使用例:

```ts
const KV_PREFIX = "speed-measure:avg:";

// showAverages: true かつ step 完了時
// ready は boolean: await ではなく if チェックで使用する
if (api.kv.ready) {
  api.kv.set(`${KV_PREFIX}${sessionID}:decode`, runningAvg);
}
```

`dispose` 時のキークリーンアップ: 削除メソッドがないため、キーはそのまま残してよい（セッション数で上限が決まるため低コスト）。

`showAverages: false`（デフォルト）の場合は `api.kv` を使用しない。

---

## 6. テスト戦略

### 6.1 collector の単体テスト（vitest）

```ts
// test/collector.test.ts
import { describe, it, expect } from "vitest";
import { SpeedCollector } from "../src/collector.js";

const ev = {
  stepStarted: (sessionID: string, ts: number) => ({
    sessionID, assistantMessageID: "msg1", timestamp: ts,
    agent: "default", model: { id: "deepseek-v4.1-flash" },
  }),
  reasoningStarted: (ts: number) => ({
    sessionID: "s1", assistantMessageID: "msg1", timestamp: ts, reasoningID: "r1",
  }),
  textStarted: (ts: number) => ({
    sessionID: "s1", assistantMessageID: "msg1", timestamp: ts, textID: "t1",
  }),
  stepEnded: (ts: number, output: number, reasoning = 0) => ({
    sessionID: "s1", assistantMessageID: "msg1", timestamp: ts,
    finish: "stop", cost: 0,
    tokens: { input: 100, output, reasoning, cache: { read: 0, write: 0 } },
  }),
};

describe("SpeedCollector", () => {
  it("TTFT = text_started − step_started", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    s = c.onTextStarted(s, ev.textStarted(1340));
    expect((s.get("s1")!.current as any).ttft).toBe(340);
  });

  it("reasoning precedes text: t1 is taken from reasoning.started", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    s = c.onReasoningStarted(s, ev.reasoningStarted(1200));
    // text.started が後から来ても t1 は reasoning.started のタイムスタンプのまま
    s = c.onTextStarted(s, { ...ev.textStarted(1500), sessionID: "s1" });
    expect((s.get("s1")!.current as any).ttft).toBe(200);  // 1200 - 1000
  });

  it("decode tok/s = (output + reasoning) / decode_sec", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 0));
    s = c.onTextStarted(s, ev.textStarted(500));
    s = c.onStepEnded(s, ev.stepEnded(2500, 80, 20));  // decode = 2000ms, 100tok
    const done = s.get("s1")!.current as any;
    expect(done.phase).toBe("done");
    expect(done.decodeTokPerSec).toBeCloseTo(50.0);   // 100 / 2.0
  });

  it("step without text returns idle", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 0));
    s = c.onStepEnded(s, ev.stepEnded(1000, 0));
    expect(s.get("s1")!.current.phase).toBe("idle");
  });

  it("status idle after done keeps done state", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 0));
    s = c.onTextStarted(s, ev.textStarted(500));
    s = c.onStepEnded(s, ev.stepEnded(2500, 80, 20));
    expect(s.get("s1")!.current.phase).toBe("done");
    // session.status idle を受け取っても done のまま
    s = c.onIdle(s, "s1");
    expect(s.get("s1")!.current.phase).toBe("done");
  });

  it("session_id filter: other session events do not affect s1", () => {
    const c = new SpeedCollector();
    let s = c.onStepStarted(new Map(), ev.stepStarted("s1", 1000));
    s = c.onTextStarted(s, { ...ev.textStarted(1340), sessionID: "s2" });
    expect((s.get("s1")!.current as any).phase).toBe("prefilling");
  });
});
```

カバーすべきケース: v2 primary、v1 fallback、ツールコール（複数ステップ）、reasoning あり、step.failed、abort 後の idle 復帰、subagent フィルタリング。

### 6.2 format のユニットテスト

```ts
// test/format.test.ts
import { formatSpeed, formatTTFT } from "../src/format.js";
it.each([
  [58.3,   "58.3 tok/s"],
  [999,    "999 tok/s"],
  [1200,   "1.2k tok/s"],
  [10000,  "10k tok/s"],
  [12345,  "12k tok/s"],
])("formatSpeed(%d) = %s", (n, expected) => expect(formatSpeed(n)).toBe(expected));
it("formatTTFT(340) = '340 ms'", () => expect(formatTTFT(340)).toBe("340 ms"));
```

### 6.3 実機スモークテスト（vLLM プロバイダー）

vLLM サーバーは `http://172-25-4-137.tailcd0071.ts.net:8888/v1` で稼働中（`opencode.jsonc` 確認済み）。

手順:
1. `npm run build` → `dist/index.js` 生成を確認
2. `tui.jsonc` にパスを追加して OpenCode を再起動
3. チャットを送信して以下を確認:
   - ストリーミング中に文字ベースの `Decode: ~XX chars/s` がライブ更新される
   - 完了後に確定値（整数 TTFT と tok/s）に切り替わる
   - `TTFT` が概ね 100ms〜数秒（vLLM の典型範囲）であること
   - ツールコールを含むプロンプトで各ステップが独立して計測されること

### 6.4 手動チェックリスト

- [ ] アイドル状態で `--` 表示
- [ ] vLLM 非キャッシュリクエストで TTFT が妥当な範囲（100ms〜数秒）
- [ ] Decode 速度が vLLM の実測値と一致（30〜150 tok/s 程度）
- [ ] ツールコール後の次ステップで値がリセット＆再計測される
- [ ] `session.next.step.failed` / abort 後にアイドル状態に戻る
- [ ] subagent セッションの値が親セッションサイドバーに漏れない
- [ ] プラグイン reload 後にメモリリークしない（`dispose` が正しく呼ばれる）
- [ ] `speed-measure.json` を削除してもデフォルト値で起動する

---

## 7. リスクと未確定事項

`cached_tokens` を報告しないローカル vLLM の追加実測では、次の値となった。すべて 500,000 tok/s の閾値を大きく下回るため、閾値だけではキャッシュによる 5〜27 倍の膨張を検出できない。

| ケース | TTFT | `prompt_tokens` | 見かけ Prefill | cold 比 |
|---|---:|---:|---:|---:|
| 完全 cold | 12,384 ms | 4,217 | 341 tok/s | 基準 |
| 完全 warm | 460 ms | 4,217 | 9,170 tok/s | 27倍 |
| 部分ヒット | 2,460 ms | 4,215 | 1,713 tok/s | 5倍 |

このため、`cached_tokens` を報告しないプロバイダでキャッシュが効いている間は Prefill 速度を参考値とし、TTFT のみを信頼する。報告するプロバイダでは `tokens.input` が非キャッシュ入力を表すため Prefill 速度は正しい。

| # | リスク | 影響度 | 緩和策 |
|---|--------|--------|--------|
| 1 | **API 安定性**: v1.14.42 で `api.command.*` が予告なく削除された前例あり（docs/research/web.md §6）。`api.slots`・`api.event` も同様のリスクがある | 高 | `peerDependencies: ">=1.15.0"` で制限し、CHANGELOG を監視する |
| 2 | **`SolidPlugin` スロット仕様の未確認**: `@opentui/solid` はローカル未インストール（docs/research/local-sdk.md §7）。`tui.d.ts` line 5 で `import type { JSX, SolidPlugin } from "@opentui/solid"` は確認済みだが、`order` フィールドとスロット関数シグネチャ `(ctx, props) => ...` はローカル型から検証不可 | 中 | jimicze/opencode-plugin-tps の `.tsx` と `sidebar/context.tsx` の `<box>`/`<text fg={...}>` パターンをそのまま採用する |
| 3 | **ネットワークジッター（Tailscale 経由の vLLM）**: サーバータイムスタンプ間の差分は正確だが、クライアント受信タイミングがずれる。v1 fallback の client-side `Date.now()` は特にジッターの影響を受ける | 低〜中 | v2 イベントを優先（サーバータイムスタンプはネットワーク遅延に依存しない）。数十 ms 程度のばらつきは表示上許容 |
| 4 | **v2 イベント不在（v1.15.0 未満のバージョン）**: `session.next.*` イベントは v1.15.0 以降（docs/research/web.md §4）で追加 | 低（現在 v1.18.30） | feature-detect（§3.2）で v1 fallback に自動切り替え |
| 5 | **プレフィックスキャッシュによる Prefill 速度の過大表示（実機で確認済み）**: `cached_tokens` を報告しないローカル vLLM では、キャッシュヒット後も `tokens.input` が全プロンプト分のまま TTFT だけが短縮される。上記の追加実測では 5〜27 倍の膨張が閾値を下回った | 中 | 500,000 tok/s 超を破棄する処理は極端な値だけを抑える緩和策とする。キャッシュ中は Prefill 速度を参考値、TTFT を信頼値として扱う。`cached_tokens` を報告するプロバイダでは `tokens.input` をそのまま使用する |
| 6 | **`api.slots.register` がアンレジスタ関数を返さない**: 文字列 ID のみ返却（docs/research/web.md §8）。スロットの動的削除が不可能 | 低 | プラグイン全体を `dispose` することで対処。ライフサイクル内で動的追加削除は行わない |

---

## 8. 実装タスク分解

### タスク一覧

**タスク A: `src/collector.ts`**（担当: js-coder）
- 内容: `SpeedCollector` クラス、全状態遷移メソッド（`onStepStarted`, `onReasoningStarted`, `onReasoningDelta`, `onTextStarted`, `onTextDelta`, `onStepEnded`, `onStepFailed`, `onIdle`, `onSessionError(state, sessionID: string | null)`, `tick`）、v1 fallback ロジック
- 依存: なし（並列実行可能）
- 完了条件: pure function のみ（副作用・JSX なし）。`CollectorState` 型を export し、`collector.test.ts` の全テストが green

**タスク B: `src/format.ts`**（担当: js-coder、タスク A と並列）
- 内容: `formatSpeed(n: number): string`、`formatTTFT(ms: number): string`
- 依存: なし（並列実行可能）
- 完了条件: `format.test.ts` の境界値テスト（999/1000/9999/10000 tok/s 等）が全 green

**タスク C: `src/index.tsx`**（担当: js-coder）
- 内容: プラグインエントリ、`createRoot` + `createSignal` 配線、v2/v1 イベント購読、`sidebar_content` スロット、`speed-measure.json` 設定読み込み、`api.lifecycle.onDispose` クリーンアップ
- 依存: タスク A・B 完了後（型定義が確定してから）
- 完了条件: `npm run build` で `dist/index.js` が生成され、OpenCode TUI を起動したときに "Speed" セクションがサイドバーに表示される。vLLM チャット後にライブ更新と確定値表示が動作する

**タスク D: テスト**（担当: tester、タスク A・B と並列開始可能）
- ファイル: `test/collector.test.ts`、`test/format.test.ts`、`test/fixtures/*.json`
- 内容: §6.1〜6.2 のテスト実装 + vLLM イベント列フィクスチャ記録
- 依存: タスク A・B のインターフェース定義（型だけ決まれば先行実装可能）
- 完了条件: `npm test` が全テスト green。フィクスチャは simple-text / tool-call / reasoning の 3 ケースを含む

**タスク E: プロジェクト設定**（担当: js-coder、並列実行可能）
- ファイル: `package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`
- 内容: §2.2〜2.3 の設定一式
- 依存: なし
- 完了条件: `npm run build` が `dist/index.js` を出力し、`npm test` が vitest を実行できる

### 依存グラフ

```
タスク E ───────────────────┐
タスク A ──────────┐        ├── タスク C（最後に実行）
タスク B ──────────┘        │
タスク D（A・B のインターフェースを参照するが型定義次第で並列開始可）
```

タスク A・B・D・E は並列実行可能。タスク C のみタスク A・B 完了を待つ。

---

## 9. 既知の問題

いずれも本設計書の記述と実装挙動が食い違う箇所であり、未修正である。

- **v2 有効時に TTFT がほぼ 0 になる**
  - OpenCode の publisher は `case "step-start": return` で何もせず、`SessionEvent.Step.Started` は `startAssistant()` 経由で text-start / reasoning-start / tool-input-start の最初のコンテンツ片で初めて publish される。
  - このため v2 では `t0`（`session.next.step.started`）と `t1`（first token）がほぼ同時刻になり TTFT ≈ 0 になる。
  - v1 経路では `step-start` part が真の開始（実測で first token の 508 ms 前）なので TTFT は正常に計測できる。
  - §1.1 の前提（`t0` = step 開始）と矛盾する。**別 Issue として扱う（今回は未修正）。**
- **v2 では continuation ごとに `assistantMessageID` が変わりうる**
  - collector は `assistantMessageID` の変化で `stepHistory` をリセットする（`src/collector.ts` の `onStepStarted` 内、215 行目付近）。
  - このため平均値表示（`showAverages: true`）が step をまたげない可能性がある。未検証。

---

## 参考資料

- docs/research/local-sdk.md: `@opencode-ai/plugin` v1.18.30・v2 SDK 型定義（検証済みローカルファイル）
- docs/research/web.md: 公式 spec (`tui-plugins.md`)・jimicze/opencode-plugin-tps ソース・`sidebar/context.tsx`
- `~/.config/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`: `EventSessionNextStepStarted/Ended/Failed`, `EventSessionNextTextStarted/Delta` の型（行 5433–5487 確認済み）
