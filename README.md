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

## 拡張余地（未実装）

- ステート連動アニメーション: `updateVisualState(state)` フックは用意済み
- 睡眠中の記憶整理: 別 Cron で history 要約 → 圧縮
- 欲求の相互作用
- マルチユーザー (DO ID を userId に)
- Discord webhook 連携で外部 push
