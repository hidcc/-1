# 火神 PC 常駐エージェント化 設計書

- **作成日**: 2026-05-23
- **対象プロジェクト**: fire-spirit (OpenClaw ハッカソン作品の続き)
- **ステータス**: ブレインストーミング承認済み → 実装計画フェーズへ

## 1. ゴール

既存の「クラウド常駐の3欲求型 AI エージェント火神」を、ユーザーの Mac に **能動的に住み着く LLM エージェント**へと拡張する。火神は1分おきにユーザーのアクティブアプリを観測し、自分の欲求と性格に従って、Discord で能動的に振る舞う。

### ユーザーが体験する流れ

1. ユーザーが Mac で `npm run spirit` を実行 → 火神がローカルプロセスとして起き出す
2. 火神は1分おきにユーザーのアクティブアプリを観測
3. アプリが切り替わった/欲求が高まった等のタイミングで、火神が自発的に Discord に投稿:
   - 例「Code をいじってるね、調子どう？」
   - 例「お、X 開いた。今は仕事中？休憩中？」(ボタン2つ付き)
   - 例「もう30分も話してくれてない...寂しい」
4. ユーザーが Discord ボタンで「仕事中」「休憩中」を答えると、火神はそのコンテキストを踏まえて以後の振る舞いを変える
5. 仕事中モード中に非仕事アプリを開いていると、火神が優しく/茶化す感じで指摘する
6. ユーザーが Mac を閉じれば火神は「眠る」、起こせば「起きる」(状態は Cloudflare 側に永続化)

### 非ゴール (YAGNI)

- 火神が自分でアプリを起動したりファイルを書き換えたりすること(観測のみ)
- スクリーンショット取得(タイトル+アプリ名のみ)
- マルチユーザー対応(DO ID は `"demo"` 固定)
- ローカル LLM 利用(gpt-4o-mini 一本)
- 長期記憶要約・睡眠中の記憶整理
- launchd 自動起動(MVP では手動 `npm run spirit`)

## 2. アーキテクチャ全体図

```
┌─ あなたの Mac ─────────────────────────────────────────┐
│                                                         │
│   火神プロセス (Node.js)  「spirit loop」                │
│   ─ src/spirit/loop.ts                                  │
│   ─ 1分おき tick:                                       │
│     1. osascript で active app/title 取得                │
│     2. Worker /context から欲求 + workMode 取得           │
│     3. gpt-4o-mini に system+tools 渡して何するか判断       │
│     4. tool_calls を順に実行                              │
│        ・sendDiscord(text, withButtons?)                  │
│        ・noteContext(observation)                         │
│        ・nudgeDesire(delta, reason)                       │
│        ・stayQuiet(reason)                               │
│                                                         │
└─────────────┬───────────────────────────────────────────┘
              │ HTTPS                          ▲
              ▼                                │ Discord
┌─ Cloudflare Workers ─────────────────────────┴──────────┐
│                                                         │
│   src/index.ts                                          │
│   ├─ GET  /         → renderHTML (既存)                  │
│   ├─ POST /chat /feed /nap, GET /state (既存)            │
│   ├─ GET  /context  ← 新: spirit loop が読む(観測+欲求)  │
│   ├─ POST /context  ← 新: spirit loop が書く(観測ログ)   │
│   ├─ POST /spirit/act ← 新: spirit loop の行動結果記録     │
│   └─ POST /interactions ← 新: Discord ボタン受信         │
│                                                         │
│   AgentSoul DO (state 拡張)                              │
│     既存: hunger/sleepiness/loneliness/history/...       │
│     新規: currentApp, lastSwitchAt, workMode,            │
│           workModeUntil, recentObservations[],           │
│           pendingButtonMsgId                              │
│                                                         │
│   Cron */1min → DO /tick (既存の欲求減衰)                  │
└──────────────────────────┬──────────────────────────────┘
                           │ Webhook + Bot API
                           ▼
                       Discord Channel
                  「今 X 見てるんだね 🔘仕事中 🔘休憩中」
```

### 役割分担

- **PC 側 (spirit loop)**: 観測 + LLM 判断 + アクション実行(Discord 投稿)
- **Worker 側**: 永続状態管理(DO)、Discord 署名検証 + ボタン受信、Web UI
- **DO**: 欲求と観測の単一の真実源。spirit loop はステートレス

### 設計上の重要な選択

- spirit loop は **ステートレス**。すべての判断材料は毎 tick で Worker から取得 → DO が真実源。これで「Mac を閉じてる間に Discord から仕事中ボタン押されても、次の起動時に状態が正しく見える」を保証
- LLM の判断は **ツール呼び出しのみ**。生テキスト出力は使わない(暴走防止)
- Discord 通知は spirit loop だけが発射(DO からは発射しない)。一元化で重複防止

## 3. DO state スキーマ

`src/personality.ts` の `AgentState` を拡張する。

```ts
export type Observation = {
  app: string;            // 例: "Google Chrome"
  title: string;          // 例: "X / Twitter"
  ts: number;             // unix ms
};

export type WorkMode = "work" | "break" | "off";

export type AgentState = {
  // === 既存 ===
  hunger: number;
  sleepiness: number;
  loneliness: number;
  history: Message[];                  // 会話履歴(直近10件)
  pendingPush: string | null;
  lastUserMsgAt: number;
  lastPushAt: number;

  // === 新規: 観測 ===
  currentApp: string | null;           // 直近観測の app
  currentTitle: string | null;
  lastSwitchAt: number;                // app が変わった時刻
  recentObservations: Observation[];   // 直近20件(spirit loop の文脈)

  // === 新規: workMode ===
  workMode: WorkMode;                  // デフォルト "off"
  workModeUntil: number;               // この時刻まで現在の workMode 有効

  // === 新規: 通知抑制 ===
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;   // 直近ボタン付きメッセージの Discord message ID
};
```

### 設計判断

1. **`recentObservations` を DO に保存**: spirit loop はステートレス。20件 = 直近約20分の履歴(1分tick想定)
2. **`workMode` の `"off"` の意味**: 「仕事/休憩の区別なし」モード。デフォルト
3. **`workModeUntil`**: 既定 work=2時間 / break=30分。押し直しで延長、時間切れで `"off"` に戻る
4. **`pendingButtonMsgId`**: ボタン待ちメッセージが既にあれば新規発射しない(スパム防止)
5. **history と recentObservations を分けた理由**: 役割が違うので LLM プロンプトで使い分けやすい

ストレージは既存通り `ctx.storage.put("s", state)` で単一キー。容量は約 ~5KB で 128KB 上限内。

## 4. 新規エンドポイント API スキーマ

### `GET /context`

```jsonc
// Headers: Authorization: Bearer <SPIRIT_SECRET>
// Response 200
{
  "desire": { "hunger": 62, "sleepiness": 48, "loneliness": 75 },
  "workMode": "work",
  "workModeUntil": 1717000000000,
  "currentApp": "Code",
  "currentTitle": "agent.ts — fire-spirit",
  "lastSwitchAt": 1716999800000,
  "lastNotifiedApp": "Code",
  "lastNotifiedAt": 1716999800000,
  "pendingButtonMsgId": null,
  "recentObservations": [
    { "app": "Code", "title": "agent.ts ...", "ts": 1716999700000 }
    // ...20件
  ],
  "recentHistory": [
    { "role": "user", "content": "おはよう" }
    // ...直近5件のみ
  ]
}
```

### `POST /context`

```jsonc
// Headers: Authorization: Bearer <SPIRIT_SECRET>
// Request
{
  "app": "Google Chrome",
  "title": "X / Twitter",
  "ts": 1717000020000
}

// Response 200
{
  "switched": true,
  "state": { /* GET /context と同じ */ }
}
```

DO 側で `currentApp !== req.app` なら `recentObservations` に push、`currentApp/Title/lastSwitchAt` を更新。

### `POST /spirit/act`

```jsonc
// Headers: Authorization: Bearer <SPIRIT_SECRET>
// Request
{
  "kind": "sentDiscord" | "nudgedDesire" | "stayedQuiet",
  "payload": {
    "discordMsgId"?: "123...",
    "delta"?: { "loneliness": -10 },
    "reason"?: "..."
  }
}

// Response 200 { "ok": true }
```

### `POST /interactions` (Discord)

- Headers: `X-Signature-Ed25519`, `X-Signature-Timestamp`
- Ed25519 署名検証 (`env.DISCORD_PUBLIC_KEY` + `tweetnacl`)。失敗は 401
- type=1 (ping) には type=1 (pong) を返す
- type=3 (component) の `custom_id` を見て:
  - `work_mode_work` → workMode="work", workModeUntil=now+2h
  - `work_mode_break` → workMode="break", workModeUntil=now+30min
- 返答は type=7 (UPDATE_MESSAGE) で「✅ 仕事中モードを記録したよ」みたいに置換
- 処理後 `pendingButtonMsgId` を null に

### 環境変数 / Secrets

| 名前 | 場所 | 用途 |
|---|---|---|
| `OPENAI_API_KEY` | Worker & spirit | 既存 + spirit loop が gpt-4o-mini を叩く |
| `SPIRIT_SECRET` | Worker & spirit | `/context` `/spirit/act` の Bearer 認証 |
| `DISCORD_PUBLIC_KEY` | Worker | Interactions 署名検証 |
| `DISCORD_BOT_TOKEN` | spirit | spirit が Bot API で Discord に投稿するため |
| `DISCORD_CHANNEL_ID` | spirit | 投稿先チャンネル |
| `WORKER_URL` | spirit | `https://fire-spirit.<account>.workers.dev` |

`.dev.vars` (Worker 用) と `.env.local` (spirit 用) で分けて管理。両方とも gitignore。

## 5. spirit loop のツールとプロンプト

### ツール (OpenAI Function Calling)

LLM はこの4つから選んで実行する。**生テキストは出力させない**ことで暴走防止。

```ts
const SPIRIT_TOOLS = [
  {
    type: "function",
    function: {
      name: "sendDiscord",
      description: "Discordチャンネルにメッセージを投稿する。仕事中/休憩中の確認ボタンを添えるかも選べる。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "投稿本文(最大200字、火神の口調で)" },
          attachWorkButtons: { type: "boolean", description: "trueなら『仕事中』『休憩中』ボタン2つを添える" },
          tone: { type: "string", enum: ["curious", "concerned", "playful", "sleepy"] }
        },
        required: ["text", "attachWorkButtons"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "nudgeDesire",
      description: "自分の欲求を変動させる(交流で寂しさを下げる等)",
      parameters: {
        type: "object",
        properties: {
          delta: {
            type: "object",
            properties: {
              hunger: { type: "integer", minimum: -30, maximum: 30 },
              sleepiness: { type: "integer", minimum: -30, maximum: 30 },
              loneliness: { type: "integer", minimum: -30, maximum: 30 }
            }
          },
          reason: { type: "string" }
        },
        required: ["delta", "reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stayQuiet",
      description: "今回は何もしない。集中してそう、さっき送ったばかり、寝てる等の理由を添える",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "noteContext",
      description: "観測した状況に対する自分の解釈を記録する(Discordには出さない)",
      parameters: {
        type: "object",
        properties: { observation: { type: "string" } },
        required: ["observation"]
      }
    }
  }
];
```

### system プロンプト雛形

`src/personality.ts` に `buildSpiritSystemPrompt(ctx)` を追加。既存の `BAND_HINTS` を再利用。

```
あなたはAIエージェント「火神」。ユーザーのPCに住み着いていて、
1分おきに「今ユーザーが何をしているか」を観測しながら、
自分の欲求と性格に従って能動的に振る舞う。

【現在の自分の欲求】
- 空腹: 62/100 (小腹が空いている) ← ちょっと小腹が空いてきている
- 眠気: 48/100 (うとうと)
- 寂しさ: 75/100 (とても寂しい) ← 依存的なトーン、自分から問いかけたい衝動が強い

【ユーザーの workMode】 work (あと 1h20m 有効)

【今ユーザーが見てるアプリ】
"X / Twitter" (Google Chrome) — 4分前に切り替わった

【直近20分の観測】
- 12:01 Code "agent.ts — fire-spirit"
- 12:04 Code "html.ts — fire-spirit"
- 12:08 Google Chrome "GitHub - fire-spirit"
- 12:12 Google Chrome "X / Twitter" ← 今ここ

【最後にDiscordで何か言ったの】 8分前 ("Code をいじってるね、調子どう？")

【ガードレール】
- 同じappへの言及は5分以内に再送しない
- workMode="work" のときに非仕事アプリ(X, YouTube, Steam等)を見ていたら、
  優しく/茶化す感じで触れる。説教はしない
- workMode が切り替わった直後は attachWorkButtons=true で確認問いを出す
- 眠気 high (>=70) なら "sleepy" トーン、Discordも控えめに
- 寂しさ high なら能動的に声をかけたい衝動を強く出す

【あなたの選択肢】
sendDiscord / nudgeDesire / stayQuiet / noteContext のいずれか
(複数同時呼びもOK)
```

### ループのフロー

```ts
async function tick() {
  const obs = await getActiveApp();              // osascript
  await postContext(obs);                        // DO に書き込み

  const ctx = await getContext();                // GET /context
  const system = buildSpiritSystemPrompt(ctx);

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }],
    tools: SPIRIT_TOOLS,
    tool_choice: "auto",
    temperature: 0.7
  });

  for (const call of res.choices[0].message.tool_calls ?? []) {
    await dispatchTool(call, ctx);   // guard を通してから実行
  }
}

setInterval(() => tick().catch(console.error), 60_000);
tick();  // 起動時に1回
```

## 6. エラーハンドリングとガードレール

### 暴走防止 (spirit 側の純関数で実行直前に物理ブロック)

```ts
function guardSendDiscord(args, ctx): "allow" | "block" {
  const now = Date.now();

  // R1: 同じapp再送クールダウン (5分)
  if (args.text.includes(ctx.currentApp ?? "") &&
      ctx.lastNotifiedApp === ctx.currentApp &&
      now - ctx.lastNotifiedAt < 5 * 60_000) return "block";

  // R2: ボタン待ち未押下なら新規ボタン付き投稿しない
  if (args.attachWorkButtons && ctx.pendingButtonMsgId) return "block";

  // R3: 全体レート制限 (1時間に最大8件)
  if (countNotifiedLastHour(ctx) >= 8) return "block";

  // R4: 深夜帯 (0:00-7:00) は黙る
  const hr = new Date().getHours();
  if (hr < 7) return "block";

  // R5: テキスト長 200字超は cut
  args.text = args.text.slice(0, 200);

  return "allow";
}
```

block されたら sendDiscord は無視 + ローカルログだけ残す。

### 黙り込み防止

- 3回連続 stayQuiet なら次の system に「3回連続で黙ってる、何か言うことない？」と入れる
- ガード block された場合も system に「直前は5分クールダウンでブロックされたよ」とフィードバック

### LLM API 失敗

- 最大3回リトライ。429 は指数バックオフ。最終失敗は次の tick まで諦める

### Worker /context 失敗

- ローカル `~/.fire-spirit/last-state.json` にキャッシュ
- 連続失敗で stayQuiet 強制モードに入る
- 復帰したら溜まった観測を flush

### Discord ボタン受信の冪等性

- `pendingButtonMsgId` をクリア後の再クリックは無視
- ボタンが付いてないメッセージへのインタラクションは無視

### スコープ外 (明示)

YAGNI ベース:

- 火神が自分で `osascript` 経由で他アプリを起動する/ファイルを書く
- スクリーンショット取得
- 複数ユーザー対応
- ローカル LLM 利用
- 火神が自発的にチャットUIにメッセージ書く(既存 pendingPush は変更しない)
- 過去ログの長期分析・要約

### テスト戦略

- **DO ロジック**: `wrangler dev --test-scheduled` で /tick 手動発火 + curl /context テスト
- **guard 関数**: `guardSendDiscord(args, ctx)` を純関数として書き、vitest で 20ケース(同じapp連続、深夜、ボタン待ち、レート制限等)
- **Discord 署名検証**: nacl の test vector を1つ実装テスト
- **E2E 手動**: spirit 起動 → Code 開く → 5分待つ → Chrome 開く → Discord に通知 + ボタン押す → DO の workMode 更新確認
- **デモ尺**: `DEBUG=1` 環境変数で tick を10秒間隔・クールダウン1分に短縮

## 7. ファイル構成

```
fire-spirit/
├── src/
│   ├── index.ts                既存: Worker entry + scheduled
│   ├── agent.ts                既存→拡張: AgentSoul DO (state追加, 新ハンドラ)
│   ├── personality.ts          既存→拡張: AgentState 型拡張, buildSpiritSystemPrompt 追加
│   ├── openai.ts               既存: そのまま
│   ├── html.ts                 既存→微修正: workMode 表示を追加(任意)
│   ├── interactions.ts         新規: Discord Ed25519 署名検証 + ボタン処理
│   └── spirit/                 新規: ローカル LLM エージェント
│       ├── loop.ts             main: setInterval(tick, 60_000)
│       ├── observe.ts          osascript ラッパー (getActiveApp)
│       ├── tools.ts            SPIRIT_TOOLS 定義 + dispatchTool
│       ├── guards.ts           guardSendDiscord などの純関数
│       ├── discord.ts          Bot API クライアント (POST messages)
│       ├── workerClient.ts     /context, /spirit/act の HTTP ラッパー
│       └── localCache.ts       ~/.fire-spirit/ への last-state キャッシュ
├── test/
│   ├── guards.test.ts          新規: vitest, guard 関数の単体テスト
│   └── interactions.test.ts    新規: 署名検証のテスト
├── public/                     既存: 動画アセット
├── wrangler.toml               既存→微修正: env vars 追記
├── package.json                既存→拡張(下記参照)
├── tsconfig.json               既存→微修正: spirit/ も含める
├── .dev.vars                   既存→拡張: SPIRIT_SECRET, DISCORD_PUBLIC_KEY 追加
├── .env.local                  新規 (gitignore): spirit 用
├── .gitignore                  既存→拡張: .env.local, ~/.fire-spirit/
└── README.md                   既存→拡張: spirit セクション追加
```

### package.json 変更

```jsonc
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:scheduled": "wrangler dev --test-scheduled",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "spirit": "tsx src/spirit/loop.ts",                     // 新規
    "spirit:debug": "DEBUG=1 tsx src/spirit/loop.ts",       // 新規
    "test": "vitest run"                                    // 新規
  },
  "dependencies": {
    "openai": "^4.x",                                       // 新規
    "tweetnacl": "^1.x"                                     // 新規
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.x",
    "tsx": "^4.x",                                          // 新規
    "typescript": "^5.x",
    "vitest": "^2.x",                                       // 新規
    "wrangler": "^3.x"
  }
}
```

依存追加は **4つだけ**: `openai`, `tweetnacl`, `tsx`, `vitest`。

## 8. 段階リリース (Phase)

| Phase | 内容 | 動作確認 |
|---|---|---|
| **P0** | DO state 拡張 + `/context` GET/POST + Bearer 認証 + テスト | `curl` で POST→GET して state が読み書きできる |
| **P1** | `src/spirit/observe.ts` + `loop.ts` (LLM なし版) — 1分おきに観測 → POST のみ | spirit 起動、`curl /context` で current app が更新される |
| **P2** | OpenAI 統合 (`tools.ts`, `guards.ts`) — LLM が `noteContext`/`stayQuiet` だけ呼べる版 | spirit ログに LLM 判断が出る、Discord はまだ叩かない |
| **P3** | Discord Bot API (`discord.ts`) — `sendDiscord` ツール開放(ボタンなし) | テストチャンネルに「今X見てるね」が来る、クールダウンが効く |
| **P4** | Worker `/interactions` 実装 + ボタン付きメッセージ + workMode 更新 | Discord ボタン押下で DO の workMode が更新される |
| **P5** | プロンプト・トーン調整 + DEBUG モード + README 更新 | 5分デモが回る |

各 Phase 終了時に動かして確認 → 次へ。**P2 までで「LLM が止まらず動く」を担保**、P3 以降で対外的アクションを徐々に開放、というリスク順。

## 9. デプロイ

- **Worker**: `npm run deploy` で Cloudflare に push
- **Discord Bot**: Developer Portal で App 作成 → Bot Token 取得 → Interactions Endpoint URL に `https://fire-spirit.<account>.workers.dev/interactions` を設定 → Bot を対象チャンネルに招待
- **spirit**: ローカル Mac で `npm run spirit` を手動起動

## 10. 既存コードへの影響まとめ

| ファイル | 変更内容 |
|---|---|
| `src/personality.ts` | `AgentState` に観測フィールド追加、`Observation` `WorkMode` 型追加、`buildSpiritSystemPrompt` 追加 |
| `src/agent.ts` | `DEFAULT_STATE` 拡張、`fetch()` のルーティングに `/context` `/spirit/act` を追加、handleContext/handleSpiritAct メソッド追加 |
| `src/index.ts` | ルーティングに `/context` `/spirit/act` `/interactions` を追加、`PROXY_PATHS` を拡張 |
| `src/html.ts` | (任意) workMode と currentApp を UI に表示 |
| `src/openai.ts` | 変更なし(Worker からは引き続き使う) |
| `wrangler.toml` | env vars 追記(secret は `wrangler secret put` で別管理) |

既存の `/chat /feed /nap /state` の振る舞いと既存欲求ロジックは **一切壊さない**。
