# 火神 — 三大欲求から派生する人間らしいAIエージェント

OpenClaw ハッカソン提出作品 (6h / 個人 / OpenAI クレジット $15)。

## コンセプト

「人間らしいAIエージェント」を、後付けの感情パラメータの寄せ集めではなく、**人間の三大欲求を根源ドライバー**に据えて実現する。

食欲・睡眠欲・社会的欲求（性欲を社会的欲求へ翻訳）の3つのステートを Durable Objects で持ち、Cron Triggers で時間経過に応じて減衰させる。エージェントの口調や自発的な振る舞いは、すべてこの3ステートから演繹的に派生する。

ポジショニング: **Tamagotchi × パーソナル AI エージェント**。

## アーキテクチャ

```
[Browser]
   │ POST /chat /feed /nap, GET /state (3秒ポーリング)
   ▼
[Worker: src/index.ts]
   ├─ fetch()      通常リクエストを DO へフォワード
   └─ scheduled()  Cron Trigger (毎分) → DO の /tick
   │
   ▼ env.AGENT.idFromName("demo").get()
[Durable Object: AgentSoul]
   state: { hunger, sleepiness, loneliness, history[10],
            pendingPush, lastUserMsgAt, lastPushAt }
   ├─ /chat   loneliness減 / OpenAI 呼び出し / history 更新
   ├─ /feed   hunger = 0
   ├─ /nap    sleepiness = 0
   ├─ /state  現在ステート + pendingPush を返却（取得と同時にnull）
   └─ /tick   3欲求の減衰 + 自発push 判定（Cron 専用）
```

DO の transactional storage のみ使用。D1/KV は未使用。state は単一キー `"s"` に put/get。

## 減衰スピード (Cron 毎分発火)

| 欲求 | 毎分増分 | 0→100 到達 | 振る舞い変化の閾値 |
|---|---|---|---|
| hunger | +20 | 5分 | 40で軽い、70で強い空腹 |
| sleepiness | +12 | 8.3分 | 40でうとうと、70で強い眠気 |
| loneliness | +25 | 4分 | **70で自発push トリガー** |

自発push 発火条件: `loneliness >= 70 && silentFor > 2分 && sincePush > 3分`

## ファイル構成

```
src/
  index.ts        Worker エントリ (fetch + scheduled)
  agent.ts        Durable Object: AgentSoul
  personality.ts  口調・hints・名前（チューニング箇所）
  openai.ts       OpenAI Chat Completions ラッパー
  html.ts         フロント HTML をテンプレ文字列で返す
wrangler.toml
package.json
tsconfig.json
```

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. OpenAI API キーを secret に登録

```bash
npx wrangler secret put OPENAI_API_KEY
# 本番デプロイ用。ローカル開発は .dev.vars に書く:
echo 'OPENAI_API_KEY="sk-..."' > .dev.vars
```

### 3. ローカル開発

```bash
# 通常起動（Cron は手動発火モード）
npm run dev

# Cron テスト用: 別ターミナルで curl http://localhost:8787/__scheduled?cron=*+*+*+*+*
npm run dev:scheduled
```

ブラウザで http://localhost:8787 を開く。

### 4. デプロイ

```bash
npm run deploy
```

## 動作確認

1. ブラウザでトップを開く
2. 「こんにちは」など話しかける → 火神が返答
3. 4〜5分放置 → loneliness が 70 超え、自発push が `/state` ポーリングで表示される
4. 「🍖 ごはん」「💤 寝かせる」ボタンで欲求をリセット

`wrangler dev --test-scheduled` を使う場合は、

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

で Cron を手動発火できる。これで /tick が呼ばれて欲求が一段進む。

## デモ尺

3〜5分で全欲求が high バンドに達して振る舞いが変化するように調整済み。

## PC 常駐エージェント機能 (spirit loop)

Mac 上で `npm run spirit` を実行すると、火神がローカルプロセスとして常駐し、1分おきにアクティブアプリを観測しながら Discord で能動的に話しかけてくる。

### 仕組み

```
[Mac] tsx src/spirit/loop.ts (Node.js)
  ↓ 1分おき
  1. osascript で active app/title 取得
  2. Worker /context にPOST、最新ステート取得
  3. gpt-4o-mini にコンテキスト + 4ツール (sendDiscord / nudgeDesire / stayQuiet / noteContext) を渡す
  4. LLM が選んだツールを実行 (ガード通過したものだけ Discord に送信)
  ↑
  Discord ボタン押下 → /interactions → DO の workMode 更新
```

### セットアップ

#### 1. Discord アプリと Bot を作る

- https://discord.com/developers/applications で新規アプリ作成
- "Bot" タブで Bot 作成、トークンをコピー (DISCORD_BOT_TOKEN)
- "OAuth2" → "URL Generator" で scope=`bot`、permissions=`Send Messages` を選び、生成URLでテストサーバに招待
- "General Information" の Public Key をコピー (DISCORD_PUBLIC_KEY)

#### 2. Worker 側の secrets

```bash
npx wrangler secret put OPENAI_API_KEY     # 既存
npx wrangler secret put SPIRIT_SECRET      # 任意のランダム文字列
npx wrangler secret put DISCORD_PUBLIC_KEY # Discord アプリの Public Key
```

ローカル開発時は `.dev.vars` に同じものを書く:
```
OPENAI_API_KEY="sk-..."
SPIRIT_SECRET="local-dev-spirit-secret"
DISCORD_PUBLIC_KEY="<discord public key>"
```

#### 3. spirit プロセス側の `.env.local`

```
WORKER_URL=https://fire-spirit.<account>.workers.dev
SPIRIT_SECRET=<上と同じ>
OPENAI_API_KEY=sk-...
DISCORD_BOT_TOKEN=<bot token>
DISCORD_CHANNEL_ID=<対象チャンネル ID>
```

#### 4. Discord の Interactions Endpoint URL 設定

Discord Developer Portal の "General Information" → "INTERACTIONS ENDPOINT URL" に
`https://fire-spirit.<account>.workers.dev/interactions` を設定。

#### 5. 起動

```bash
npm run deploy            # Worker をデプロイ
npm run spirit            # Mac で火神を起こす (本番モード、1分tick)
# または
DEBUG=1 npm run spirit:debug   # 10秒tick、デモ用
```

### 動作確認

1. `npm run spirit` 起動 → ログに `spirit loop start` が出る
2. アクティブアプリを切り替える (Code → Chrome → X など)
3. 数分以内に Discord チャンネルに「今 X 見てるんだね。仕事中？休憩中？」みたいなメッセージが来る
4. ボタンを押す → ✅ 反映メッセージに置き換わる → 以後 workMode に応じて火神の反応が変わる
5. workMode="work" 中に YouTube を開く → 火神が「あれ、仕事中じゃないの？」と茶化す

### コスト

gpt-4o-mini を1分間隔で叩いて、1tick あたりおよそ
入力500トークン + 出力100トークン → **約 $0.00014/tick** = 1日16時間で **約 $0.13/日**, **月 $4 程度**。

### ガードレール

`src/spirit/guards.ts` に純関数として実装、`test/guards.test.ts` で10ケース。

- 同じアプリへの再通知は5分クールダウン
- ボタン待ち中はボタン付き通知を出さない
- 深夜帯 (0:00-7:00) は通知しない
- 1時間に最大8件まで
- メッセージは200字でカット

`src/interactions.ts` の Discord 署名検証も4ケースでテスト済み。

## 拡張余地（未実装）

- ステート連動アニメーション: `updateVisualState(state)` フックは用意済み
- 睡眠中の記憶整理: 別 Cron で history 要約 → 圧縮
- 欲求の相互作用
- マルチユーザー (DO ID を userId に)
- Discord webhook 連携で外部 push
