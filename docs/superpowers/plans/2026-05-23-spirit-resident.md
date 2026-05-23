# 火神 PC 常駐エージェント化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存の火神 (Cloudflare Workers + DO) を、Mac 常駐の能動 LLM エージェントに拡張する。1分おきにアクティブアプリを観測し、gpt-4o-mini が Discord 通知/欲求調整/沈黙を自分で選んで実行する。

**Architecture:** ローカル Node.js プロセス (spirit loop) が観測+LLM 判断+アクション実行を担当、Cloudflare 側 (Worker+DO) が永続状態と Discord interaction 受け口になる。spirit loop はステートレス、DO が単一の真実源。

**Tech Stack:** Cloudflare Workers + Durable Objects, Node.js + tsx, OpenAI gpt-4o-mini (Function Calling), Discord Bot API (Interactions v10), tweetnacl (Ed25519), vitest

**Spec:** `docs/superpowers/specs/2026-05-23-spirit-resident-design.md`

**Phase順:** P0 (DO 拡張) → P1 (観測ループ) → P2 (LLM ループ無害版) → P3 (Discord 出力) → P4 (ボタン双方向) → P5 (Polish)

---

## File Structure

新規/変更ファイルと役割:

| ファイル | 役割 |
|---|---|
| `src/personality.ts` | 既存型を拡張: `Observation`, `WorkMode`, `AgentState` に観測フィールド追加、`buildSpiritSystemPrompt` 追加 |
| `src/agent.ts` | DO の `DEFAULT_STATE` 拡張、`/context` `/spirit/act` のハンドラ追加 |
| `src/index.ts` | Worker のルーティングに `/context` `/spirit/act` `/interactions` 追加 (Bearer 認証 + 署名検証) |
| `src/auth.ts` (新規) | `checkBearer(req, secret)` の小さな共通関数 |
| `src/interactions.ts` (新規) | Discord Ed25519 署名検証 + ボタンハンドラ |
| `src/spirit/observe.ts` (新規) | macOS osascript ラッパー、`getActiveApp()` |
| `src/spirit/workerClient.ts` (新規) | `/context` GET/POST と `/spirit/act` POST の HTTP ラッパー |
| `src/spirit/tools.ts` (新規) | OpenAI tools 定義 + dispatchTool |
| `src/spirit/guards.ts` (新規) | `guardSendDiscord` などの純関数 |
| `src/spirit/discord.ts` (新規) | Discord Bot API クライアント |
| `src/spirit/localCache.ts` (新規) | `~/.fire-spirit/last-state.json` への永続化 |
| `src/spirit/loop.ts` (新規) | `tick()` メイン + setInterval |
| `test/guards.test.ts` (新規) | vitest, guard 関数の単体テスト |
| `test/interactions.test.ts` (新規) | nacl 署名検証のテスト |
| `package.json` | scripts と deps 追加 |
| `wrangler.toml` | env var の追記 |
| `.dev.vars` | SPIRIT_SECRET, DISCORD_PUBLIC_KEY 追加 |
| `.env.local` (新規, gitignore) | spirit プロセス用環境変数 |
| `.gitignore` | `.env.local`, `~/.fire-spirit/` 追加 |

---

## Phase P0: DO state 拡張 と `/context` `/spirit/act` API

### Task 1: 型と DEFAULT_STATE の拡張

**Files:**
- Modify: `src/personality.ts` (型追加)
- Modify: `src/agent.ts` (DEFAULT_STATE 拡張)

- [ ] **Step 1.1: `src/personality.ts` に型を追加**

`Message` 型の直後に追加:

```ts
export type Observation = {
  app: string;
  title: string;
  ts: number;
};

export type WorkMode = "work" | "break" | "off";
```

`AgentState` 型を以下に置き換え (既存フィールドはそのまま、新規追加):

```ts
export type AgentState = {
  hunger: number;
  sleepiness: number;
  loneliness: number;
  history: Message[];
  pendingPush: string | null;
  lastUserMsgAt: number;
  lastPushAt: number;

  // 観測
  currentApp: string | null;
  currentTitle: string | null;
  lastSwitchAt: number;
  recentObservations: Observation[];

  // workMode
  workMode: WorkMode;
  workModeUntil: number;

  // 通知抑制
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;
};
```

- [ ] **Step 1.2: `src/agent.ts` の `DEFAULT_STATE` を拡張**

```ts
const DEFAULT_STATE: AgentState = {
  hunger: 50,
  sleepiness: 50,
  loneliness: 50,
  history: [],
  pendingPush: null,
  lastUserMsgAt: 0,
  lastPushAt: 0,

  currentApp: null,
  currentTitle: null,
  lastSwitchAt: 0,
  recentObservations: [],

  workMode: "off",
  workModeUntil: 0,

  lastNotifiedApp: null,
  lastNotifiedAt: 0,
  pendingButtonMsgId: null,
};
```

- [ ] **Step 1.3: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 1.4: Commit**

```bash
git add src/personality.ts src/agent.ts
git commit -m "feat(do): extend AgentState with observation and workMode fields"
```

---

### Task 2: Bearer 認証ヘルパー

**Files:**
- Create: `src/auth.ts`

- [ ] **Step 2.1: `src/auth.ts` を作成**

```ts
export function checkBearer(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare to avoid timing leaks (length differs → still false fast)
  const got = m[1];
  if (got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}
```

- [ ] **Step 2.2: Commit**

```bash
git add src/auth.ts
git commit -m "feat(auth): add Bearer token helper for spirit endpoints"
```

---

### Task 3: DO に `/context` GET ハンドラ追加

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 3.1: `Env` を拡張**

`type Env` を以下に置き換え:

```ts
type Env = {
  OPENAI_API_KEY: string;
  AGENT: DurableObjectNamespace;
  SPIRIT_SECRET: string;
};
```

- [ ] **Step 3.2: `AgentSoul.fetch()` のスイッチに `/context` ケースを追加**

`switch (url.pathname)` ブロックに以下を追加:

```ts
      case "/context":
        if (req.method === "GET") return this.handleContextGet();
        if (req.method === "POST") return this.handleContextPost(req);
        return new Response("method not allowed", { status: 405 });
      case "/spirit/act":
        return this.handleSpiritAct(req);
```

- [ ] **Step 3.3: `handleContextGet()` を実装**

`handleState()` の直前に追加:

```ts
  private async handleContextGet(): Promise<Response> {
    return Response.json({
      desire: {
        hunger: this.state.hunger,
        sleepiness: this.state.sleepiness,
        loneliness: this.state.loneliness,
      },
      workMode: this.state.workMode,
      workModeUntil: this.state.workModeUntil,
      currentApp: this.state.currentApp,
      currentTitle: this.state.currentTitle,
      lastSwitchAt: this.state.lastSwitchAt,
      lastNotifiedApp: this.state.lastNotifiedApp,
      lastNotifiedAt: this.state.lastNotifiedAt,
      pendingButtonMsgId: this.state.pendingButtonMsgId,
      recentObservations: this.state.recentObservations,
      recentHistory: this.state.history.slice(-5).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  }
```

- [ ] **Step 3.4: typecheck**

Run: `npm run typecheck`
Expected: エラーなし (handleContextPost と handleSpiritAct 未定義のため別エラー出る → 次のステップで実装)

実際にはまだ未定義なので `Property 'handleContextPost' does not exist` 等のエラーが出る想定。次の Task でまとめて実装する流れにするため、ここでは typecheck をスキップし、コミットも次の Task と合体させても良い。

- [ ] **Step 3.5: 中間コミットは打たず、Task 4 に進む**

---

### Task 4: DO に `/context` POST ハンドラ追加 (アプリ切替検知 + observation 追記)

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 4.1: 定数を追加**

ファイル先頭の `const HISTORY_LIMIT = 10;` の下に追加:

```ts
const OBS_LIMIT = 20;
```

- [ ] **Step 4.2: `handleContextPost()` を実装**

`handleContextGet()` の直後に追加:

```ts
  private async handleContextPost(req: Request): Promise<Response> {
    let body: { app?: unknown; title?: unknown; ts?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const app = typeof body.app === "string" ? body.app : "";
    const title = typeof body.title === "string" ? body.title : "";
    const ts = typeof body.ts === "number" ? body.ts : Date.now();
    if (!app) return new Response("missing app", { status: 400 });

    const switched = this.state.currentApp !== app;
    if (switched) {
      this.state.currentApp = app;
      this.state.currentTitle = title;
      this.state.lastSwitchAt = ts;
      this.state.recentObservations.push({ app, title, ts });
      while (this.state.recentObservations.length > OBS_LIMIT) {
        this.state.recentObservations.shift();
      }
    } else {
      // タイトル変化だけは更新するが履歴には残さない (ノイズ防止)
      this.state.currentTitle = title;
    }

    // workMode の自動リセット
    if (this.state.workMode !== "off" && this.state.workModeUntil > 0 && ts > this.state.workModeUntil) {
      this.state.workMode = "off";
      this.state.workModeUntil = 0;
    }

    await this.save();
    const get = await this.handleContextGet();
    const stateJson = await get.json();
    return Response.json({ switched, state: stateJson });
  }
```

- [ ] **Step 4.3: typecheck**

Run: `npm run typecheck`
Expected: `handleSpiritAct` 未定義のみエラー (次 Task で解消)

---

### Task 5: DO に `/spirit/act` ハンドラ追加

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 5.1: `handleSpiritAct()` を実装**

`handleContextPost()` の直後に追加:

```ts
  private async handleSpiritAct(req: Request): Promise<Response> {
    let body: { kind?: unknown; payload?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const kind = typeof body.kind === "string" ? body.kind : "";
    const payload = (body.payload ?? {}) as Record<string, unknown>;

    const now = Date.now();
    switch (kind) {
      case "sentDiscord": {
        const msgId = typeof payload.discordMsgId === "string" ? payload.discordMsgId : null;
        this.state.lastNotifiedApp = this.state.currentApp;
        this.state.lastNotifiedAt = now;
        if (payload.attachedButtons === true && msgId) {
          this.state.pendingButtonMsgId = msgId;
        }
        break;
      }
      case "nudgedDesire": {
        const delta = (payload.delta ?? {}) as Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
        for (const k of ["hunger", "sleepiness", "loneliness"] as const) {
          const d = delta[k];
          if (typeof d === "number") {
            this.state[k] = clamp(this.state[k] + d);
          }
        }
        break;
      }
      case "stayedQuiet":
        // ログ目的のみ
        break;
      default:
        return new Response("unknown kind", { status: 400 });
    }

    await this.save();
    return Response.json({ ok: true });
  }
```

- [ ] **Step 5.2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 5.3: Commit (Task 3-5 をまとめて)**

```bash
git add src/agent.ts
git commit -m "feat(do): add /context GET/POST and /spirit/act handlers"
```

---

### Task 6: Worker のルーティングに `/context` `/spirit/act` を追加 (Bearer 認証)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 6.1: `Env` を拡張**

```ts
type Env = {
  OPENAI_API_KEY: string;
  AGENT: DurableObjectNamespace;
  SPIRIT_SECRET: string;
  DISCORD_PUBLIC_KEY: string;  // P4 で使う、今は宣言だけ
};
```

- [ ] **Step 6.2: import に auth ヘルパーを追加**

`import { renderHTML } from "./html";` の下に追加:

```ts
import { checkBearer } from "./auth";
```

- [ ] **Step 6.3: `PROXY_PATHS` を拡張、認証付きパス集合を追加**

```ts
const PROXY_PATHS = new Set(["/chat", "/feed", "/nap", "/state"]);
const SPIRIT_PATHS = new Set(["/context", "/spirit/act"]);
```

- [ ] **Step 6.4: `fetch()` を更新**

`if (PROXY_PATHS.has(url.pathname))` ブロックの直後に追加:

```ts
    if (SPIRIT_PATHS.has(url.pathname)) {
      if (!checkBearer(req, env.SPIRIT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = getStub(env);
      return stub.fetch(new Request("https://do" + url.pathname, req));
    }
```

- [ ] **Step 6.5: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6.6: Commit**

```bash
git add src/index.ts
git commit -m "feat(worker): route /context and /spirit/act with Bearer auth"
```

---

### Task 7: 環境変数の追加 (`.dev.vars`, `wrangler.toml`)

**Files:**
- Modify: `.dev.vars`
- Modify: `wrangler.toml`

- [ ] **Step 7.1: `.dev.vars` を確認・拡張**

現状を表示: `cat .dev.vars`

追記 (既存の `OPENAI_API_KEY` の下):

```
SPIRIT_SECRET="local-dev-spirit-secret"
DISCORD_PUBLIC_KEY="placeholder-set-after-discord-app-created"
```

- [ ] **Step 7.2: `wrangler.toml` には書かない (Secret は `wrangler secret put` で本番管理)**

本番では:
```bash
npx wrangler secret put SPIRIT_SECRET
npx wrangler secret put DISCORD_PUBLIC_KEY
```
これは README に書く (Task 26)。今は touch しない。

- [ ] **Step 7.3: Commit (.dev.vars は gitignore に入っていないか確認)**

```bash
cat .gitignore | grep -i dev.vars
```

入っていなければ、追加:

```bash
echo ".dev.vars" >> .gitignore
git add .gitignore
git commit -m "chore: ignore .dev.vars"
```

(入っていればスキップ)

---

### Task 8: P0 動作確認 — wrangler dev で `/context` を curl

**Files:** なし (検証のみ)

- [ ] **Step 8.1: ローカルサーバ起動 (バックグラウンド)**

別ターミナルで `npm run dev` を起動。

- [ ] **Step 8.2: 認証失敗を確認**

```bash
curl -i http://localhost:8787/context
```
Expected: `HTTP/1.1 401 Unauthorized`

- [ ] **Step 8.3: 認証成功で初期 state 取得**

```bash
curl -s -H "Authorization: Bearer local-dev-spirit-secret" http://localhost:8787/context | python3 -m json.tool
```
Expected: `desire`, `workMode: "off"`, `currentApp: null`, `recentObservations: []` を含む JSON

- [ ] **Step 8.4: POST で observation を書く**

```bash
curl -s -X POST \
  -H "Authorization: Bearer local-dev-spirit-secret" \
  -H "Content-Type: application/json" \
  -d '{"app":"Code","title":"agent.ts","ts":1716999700000}' \
  http://localhost:8787/context | python3 -m json.tool
```
Expected: `{"switched": true, "state": {... currentApp: "Code" ...}}`

- [ ] **Step 8.5: 同じ app を再 POST → switched: false**

```bash
curl -s -X POST \
  -H "Authorization: Bearer local-dev-spirit-secret" \
  -H "Content-Type: application/json" \
  -d '{"app":"Code","title":"html.ts","ts":1716999800000}' \
  http://localhost:8787/context | python3 -m json.tool
```
Expected: `{"switched": false, "state": {... currentTitle: "html.ts", recentObservations長さ変わらず ...}}`

- [ ] **Step 8.6: P0 完了の Phase 区切りコミット (空コミット)**

```bash
git commit --allow-empty -m "chore(p0): verified /context and /spirit/act endpoints work"
```

`npm run dev` は停止。

---

## Phase P1: ローカル観測ループ (LLM なし版)

### Task 9: 依存追加と script 追加

**Files:**
- Modify: `package.json`

- [ ] **Step 9.1: 依存パッケージをインストール**

```bash
npm install openai tweetnacl
npm install --save-dev tsx vitest
```

- [ ] **Step 9.2: `package.json` の scripts セクションに追加**

`"typecheck": "tsc --noEmit"` の下に追加:

```jsonc
    "spirit": "tsx src/spirit/loop.ts",
    "spirit:debug": "DEBUG=1 tsx src/spirit/loop.ts",
    "test": "vitest run"
```

- [ ] **Step 9.3: 型確認**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 9.4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add openai, tweetnacl, tsx, vitest for spirit loop"
```

---

### Task 10: `src/spirit/observe.ts` — osascript ラッパー

**Files:**
- Create: `src/spirit/observe.ts`

- [ ] **Step 10.1: ファイル作成**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  try
    set winTitle to name of first window of frontApp
  end try
  return appName & "\\t" & winTitle
end tell
`;

export type ActiveApp = { app: string; title: string };

export async function getActiveApp(): Promise<ActiveApp> {
  try {
    const { stdout } = await execFileP("osascript", ["-e", SCRIPT], { timeout: 3000 });
    const [app, ...rest] = stdout.trim().split("\t");
    return { app: app ?? "", title: rest.join("\t") };
  } catch (e) {
    return { app: "", title: "" };
  }
}
```

- [ ] **Step 10.2: 手動テスト**

Run: `npx tsx -e 'import("./src/spirit/observe.ts").then(m => m.getActiveApp().then(console.log))'`
Expected: `{ app: "Terminal", title: "..." }` のような出力

- [ ] **Step 10.3: Commit**

```bash
git add src/spirit/observe.ts
git commit -m "feat(spirit): add macOS active app observer via osascript"
```

---

### Task 11: `src/spirit/workerClient.ts` — HTTP ラッパー

**Files:**
- Create: `src/spirit/workerClient.ts`

- [ ] **Step 11.1: ファイル作成**

```ts
export type ContextState = {
  desire: { hunger: number; sleepiness: number; loneliness: number };
  workMode: "work" | "break" | "off";
  workModeUntil: number;
  currentApp: string | null;
  currentTitle: string | null;
  lastSwitchAt: number;
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;
  recentObservations: { app: string; title: string; ts: number }[];
  recentHistory: { role: string; content: string }[];
};

type Config = {
  workerUrl: string;
  spiritSecret: string;
};

function authHeaders(cfg: Config): Record<string, string> {
  return { Authorization: `Bearer ${cfg.spiritSecret}` };
}

export async function getContext(cfg: Config): Promise<ContextState> {
  const res = await fetch(`${cfg.workerUrl}/context`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`getContext ${res.status}`);
  return (await res.json()) as ContextState;
}

export async function postContext(
  cfg: Config,
  obs: { app: string; title: string; ts: number },
): Promise<{ switched: boolean; state: ContextState }> {
  const res = await fetch(`${cfg.workerUrl}/context`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(obs),
  });
  if (!res.ok) throw new Error(`postContext ${res.status}`);
  return (await res.json()) as { switched: boolean; state: ContextState };
}

export type SpiritAct =
  | { kind: "sentDiscord"; payload: { discordMsgId?: string; attachedButtons?: boolean } }
  | { kind: "nudgedDesire"; payload: { delta: Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>; reason: string } }
  | { kind: "stayedQuiet"; payload: { reason: string } };

export async function postAct(cfg: Config, act: SpiritAct): Promise<void> {
  const res = await fetch(`${cfg.workerUrl}/spirit/act`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(act),
  });
  if (!res.ok) throw new Error(`postAct ${res.status}`);
}
```

- [ ] **Step 11.2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 11.3: Commit**

```bash
git add src/spirit/workerClient.ts
git commit -m "feat(spirit): add worker HTTP client for /context and /spirit/act"
```

---

### Task 12: `.env.local` と `src/spirit/loop.ts` スケルトン (LLM なし)

**Files:**
- Create: `.env.local`
- Modify: `.gitignore`
- Create: `src/spirit/loop.ts`

- [ ] **Step 12.1: `.gitignore` に追記**

```bash
echo ".env.local" >> .gitignore
echo "node_modules" >> .gitignore   # 既にあればスキップ可
```

- [ ] **Step 12.2: `.env.local` を作成 (実値は本人が後で書き換える)**

```
WORKER_URL=http://localhost:8787
SPIRIT_SECRET=local-dev-spirit-secret
OPENAI_API_KEY=sk-...
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
```

- [ ] **Step 12.3: `src/spirit/loop.ts` 作成 (P1: 観測 → POST のみ)**

```ts
import "dotenv/config";  // 次の Step で dotenv 追加
import { getActiveApp } from "./observe";
import { postContext } from "./workerClient";

const DEBUG = process.env.DEBUG === "1";
const TICK_MS = DEBUG ? 10_000 : 60_000;

const cfg = {
  workerUrl: process.env.WORKER_URL ?? "",
  spiritSecret: process.env.SPIRIT_SECRET ?? "",
};

function logTs(): string {
  return new Date().toISOString().slice(11, 19);
}

async function tick(): Promise<void> {
  const obs = await getActiveApp();
  if (!obs.app) {
    console.log(`[${logTs()}] no app, skip`);
    return;
  }
  try {
    const { switched } = await postContext(cfg, { ...obs, ts: Date.now() });
    console.log(`[${logTs()}] ${switched ? "→" : "·"} ${obs.app} | ${obs.title}`);
  } catch (e) {
    console.error(`[${logTs()}] postContext failed:`, (e as Error).message);
  }
}

async function main(): Promise<void> {
  if (!cfg.workerUrl || !cfg.spiritSecret) {
    console.error("WORKER_URL or SPIRIT_SECRET missing in .env.local");
    process.exit(1);
  }
  console.log(`spirit loop start (tick=${TICK_MS}ms, worker=${cfg.workerUrl})`);
  await tick();
  setInterval(() => {
    tick().catch((e) => console.error("tick error:", e));
  }, TICK_MS);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 12.4: dotenv を追加 (`.env.local` を読むため)**

```bash
npm install dotenv
```

`src/spirit/loop.ts` 先頭の `import "dotenv/config";` を以下に置き換え (`.env.local` から読みたいので):

```ts
import { config } from "dotenv";
config({ path: ".env.local" });
```

- [ ] **Step 12.5: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 12.6: 動作確認 (別ターミナルで `npm run dev` 起動済みの前提)**

```bash
npm run dev   # 別ターミナルで
# このターミナルで:
DEBUG=1 npm run spirit:debug
```

Expected (例):
```
spirit loop start (tick=10000ms, worker=http://localhost:8787)
[12:34:56] → Code | loop.ts — fire-spirit
[12:35:06] · Code | loop.ts — fire-spirit
[12:35:16] → Google Chrome | X / Twitter
```

別ターミナルで Code → Chrome に切り替えると、→ マークが出るのを確認。

`npm run spirit:debug` を Ctrl+C で止めて、`npm run dev` も止める。

- [ ] **Step 12.7: Commit**

```bash
git add .gitignore .env.local src/spirit/loop.ts package.json package-lock.json
```

ただし `.env.local` は gitignore したので add されない (`git add .env.local` を強制でやらないこと)。確認:
```bash
git status
```
`.env.local` が untracked のままなら正しい。

```bash
git add .gitignore src/spirit/loop.ts package.json package-lock.json
git commit -m "feat(spirit): add observation-only tick loop (P1)"
```

---

## Phase P2: LLM ループ (無害ツールのみ)

### Task 13: `src/spirit/tools.ts` — ツール定義 (sendDiscord はまだダミー)

**Files:**
- Create: `src/spirit/tools.ts`

- [ ] **Step 13.1: ファイル作成**

```ts
import type OpenAI from "openai";

export const SPIRIT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "sendDiscord",
      description: "Discordチャンネルにメッセージを投稿する。仕事中/休憩中の確認ボタンを添えるかも選べる。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "投稿本文 (最大200字、火神の口調で)" },
          attachWorkButtons: { type: "boolean", description: "trueなら『仕事中』『休憩中』ボタン2つを添える" },
          tone: { type: "string", enum: ["curious", "concerned", "playful", "sleepy"] },
        },
        required: ["text", "attachWorkButtons"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nudgeDesire",
      description: "自分の欲求を変動させる",
      parameters: {
        type: "object",
        properties: {
          delta: {
            type: "object",
            properties: {
              hunger: { type: "integer", minimum: -30, maximum: 30 },
              sleepiness: { type: "integer", minimum: -30, maximum: 30 },
              loneliness: { type: "integer", minimum: -30, maximum: 30 },
            },
          },
          reason: { type: "string" },
        },
        required: ["delta", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stayQuiet",
      description: "今回は何もしない",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "noteContext",
      description: "観測した状況に対する自分の解釈を記録する (Discordには出さない)",
      parameters: {
        type: "object",
        properties: { observation: { type: "string" } },
        required: ["observation"],
      },
    },
  },
];

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export function parseToolCalls(
  msg: OpenAI.Chat.Completions.ChatCompletionMessage,
): ToolCall[] {
  const calls = msg.tool_calls ?? [];
  return calls
    .filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } => c.type === "function")
    .map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments) as Record<string, unknown>;
      } catch {
        // 壊れた引数は空扱い
      }
      return { name: c.function.name, args };
    });
}
```

- [ ] **Step 13.2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 13.3: Commit**

```bash
git add src/spirit/tools.ts
git commit -m "feat(spirit): define LLM tools (sendDiscord/nudgeDesire/stayQuiet/noteContext)"
```

---

### Task 14: `buildSpiritSystemPrompt` を `src/personality.ts` に追加

**Files:**
- Modify: `src/personality.ts`

- [ ] **Step 14.1: ファイル末尾に追加**

```ts
function fmtAgo(ms: number): string {
  if (ms < 60_000) return "数秒";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60}m`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

export type SpiritContext = {
  desire: { hunger: number; sleepiness: number; loneliness: number };
  workMode: WorkMode;
  workModeUntil: number;
  currentApp: string | null;
  currentTitle: string | null;
  lastSwitchAt: number;
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;
  recentObservations: { app: string; title: string; ts: number }[];
};

export function buildSpiritSystemPrompt(ctx: SpiritContext): string {
  const now = Date.now();
  const hints: string[] = [];
  for (const k of ["hunger", "sleepiness", "loneliness"] as const) {
    const b = band(ctx.desire[k]);
    if (b !== "low") hints.push(`- ${BAND_HINTS[k][b]}`);
  }
  if (hints.length === 0) hints.push("- 全体的に元気。フラットで自然な振る舞い");

  const wmLine =
    ctx.workMode === "off"
      ? "off (仕事/休憩の区別なし)"
      : `${ctx.workMode} (あと ${fmtAgo(Math.max(0, ctx.workModeUntil - now))} 有効)`;

  const obsLines =
    ctx.recentObservations.length === 0
      ? "(まだ観測なし)"
      : ctx.recentObservations
          .slice(-10)
          .map((o) => `  - ${fmtClock(o.ts)} ${o.app} "${o.title}"`)
          .join("\n");

  const lastNotif =
    ctx.lastNotifiedAt === 0
      ? "(まだない)"
      : `${fmtAgo(now - ctx.lastNotifiedAt)}前 (${ctx.lastNotifiedApp ?? "?"} について)`;

  return `あなたはAIエージェント「${AGENT_NAME}」。ユーザーのPCに住み着いていて、1分おきに「今ユーザーが何をしているか」を観測しながら、自分の欲求と性格に従って能動的に振る舞う。

【現在の自分の欲求】
- 空腹: ${ctx.desire.hunger}/100 (${label(ctx.desire.hunger, "hunger")})
- 眠気: ${ctx.desire.sleepiness}/100 (${label(ctx.desire.sleepiness, "sleepiness")})
- 寂しさ: ${ctx.desire.loneliness}/100 (${label(ctx.desire.loneliness, "loneliness")})

【振る舞いの指針】
${hints.join("\n")}

【ユーザーの workMode】 ${wmLine}

【今ユーザーが見てるアプリ】
"${ctx.currentTitle ?? ""}" (${ctx.currentApp ?? "?"}) — ${fmtAgo(now - ctx.lastSwitchAt)}前に切り替わった

【直近の観測】
${obsLines}

【最後にDiscordで何か言ったの】 ${lastNotif}
${ctx.pendingButtonMsgId ? "【未押下のボタン待ちあり】 → 新しい attachWorkButtons=true は出さないこと" : ""}

【ガードレール】
- 同じappへの言及は5分以内に再送しない
- workMode="work" のときに非仕事アプリ (X, YouTube, Steam等) を見ていたら、優しく/茶化す感じで触れる。説教はしない
- workMode が "off" のときに新しい app に切り替わったら attachWorkButtons=true で確認問いを出して良い
- 眠気 high (>=70) なら "sleepy" トーン、Discord も控えめに
- 寂しさ high なら能動的に声をかけたい衝動を強く出す
- "私はAIなので〜" のような断りは入れない
- 1メッセージ最大200字、絵文字は1個まで

【あなたの選択肢】
sendDiscord / nudgeDesire / stayQuiet / noteContext のいずれか (複数同時呼びもOK)`;
}
```

- [ ] **Step 14.2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 14.3: Commit**

```bash
git add src/personality.ts
git commit -m "feat(personality): add buildSpiritSystemPrompt for LLM loop"
```

---

### Task 15: spirit loop に OpenAI 統合 (sendDiscord はまだ無効化)

**Files:**
- Modify: `src/spirit/loop.ts`
- Create: `src/spirit/localCache.ts` (失敗時の last-state 保存)

- [ ] **Step 15.1: `src/spirit/localCache.ts` 作成**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextState } from "./workerClient";

const CACHE_PATH = join(homedir(), ".fire-spirit", "last-state.json");

export async function saveLastState(state: ContextState): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

export async function loadLastState(): Promise<ContextState | null> {
  try {
    const txt = await readFile(CACHE_PATH, "utf-8");
    return JSON.parse(txt) as ContextState;
  } catch {
    return null;
  }
}
```

- [ ] **Step 15.2: `src/spirit/loop.ts` を全面更新**

ファイルを以下に置き換え:

```ts
import { config } from "dotenv";
config({ path: ".env.local" });

import OpenAI from "openai";
import { getActiveApp } from "./observe";
import { getContext, postContext, postAct } from "./workerClient";
import { saveLastState, loadLastState } from "./localCache";
import { SPIRIT_TOOLS, parseToolCalls, type ToolCall } from "./tools";
import { buildSpiritSystemPrompt, type SpiritContext } from "../personality";

const DEBUG = process.env.DEBUG === "1";
const TICK_MS = DEBUG ? 10_000 : 60_000;
const MODEL = "gpt-4o-mini";

const cfg = {
  workerUrl: process.env.WORKER_URL ?? "",
  spiritSecret: process.env.SPIRIT_SECRET ?? "",
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

function logTs(): string {
  return new Date().toISOString().slice(11, 19);
}

async function dispatchTool(call: ToolCall, _ctx: SpiritContext): Promise<void> {
  switch (call.name) {
    case "stayQuiet":
      console.log(`[${logTs()}]   stayQuiet: ${(call.args.reason as string) ?? ""}`);
      await postAct(cfg, { kind: "stayedQuiet", payload: { reason: String(call.args.reason ?? "") } });
      break;
    case "noteContext":
      console.log(`[${logTs()}]   noteContext: ${(call.args.observation as string) ?? ""}`);
      // observation はログのみ。DO に書き戻さない (recentObservations は観測の事実、これは解釈)
      break;
    case "nudgeDesire": {
      const delta = (call.args.delta ?? {}) as Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
      const reason = String(call.args.reason ?? "");
      console.log(`[${logTs()}]   nudgeDesire: ${JSON.stringify(delta)} (${reason})`);
      await postAct(cfg, { kind: "nudgedDesire", payload: { delta, reason } });
      break;
    }
    case "sendDiscord":
      // P3 で実装。今は呼ばれてもログのみ。
      console.log(`[${logTs()}]   sendDiscord (disabled in P2): "${String(call.args.text ?? "").slice(0, 60)}"`);
      break;
    default:
      console.warn(`[${logTs()}]   unknown tool: ${call.name}`);
  }
}

async function tick(): Promise<void> {
  const obs = await getActiveApp();
  if (!obs.app) {
    console.log(`[${logTs()}] no app, skip`);
    return;
  }

  let ctx: SpiritContext;
  try {
    const posted = await postContext(cfg, { ...obs, ts: Date.now() });
    ctx = posted.state as SpiritContext;
    await saveLastState(posted.state);
    console.log(`[${logTs()}] ${posted.switched ? "→" : "·"} ${obs.app} | ${obs.title}`);
  } catch (e) {
    console.error(`[${logTs()}] worker offline:`, (e as Error).message);
    const cached = await loadLastState();
    if (!cached) return;
    ctx = cached as SpiritContext;
  }

  const system = buildSpiritSystemPrompt(ctx);
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: system }],
      tools: SPIRIT_TOOLS,
      tool_choice: "auto",
      temperature: 0.7,
    });
    const calls = parseToolCalls(res.choices[0].message);
    if (calls.length === 0) {
      console.log(`[${logTs()}]   (no tool call — content: ${res.choices[0].message.content?.slice(0, 60) ?? ""})`);
    }
    for (const call of calls) {
      await dispatchTool(call, ctx);
    }
  } catch (e) {
    console.error(`[${logTs()}] openai failed:`, (e as Error).message);
  }
}

async function main(): Promise<void> {
  if (!cfg.workerUrl || !cfg.spiritSecret) {
    console.error("WORKER_URL or SPIRIT_SECRET missing in .env.local");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY missing in .env.local");
    process.exit(1);
  }
  console.log(`spirit loop start (tick=${TICK_MS}ms, model=${MODEL})`);
  await tick();
  setInterval(() => {
    tick().catch((e) => console.error("tick error:", e));
  }, TICK_MS);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 15.3: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 15.4: 動作確認**

別ターミナルで `npm run dev` 起動。
`.env.local` の `OPENAI_API_KEY` を実値に書き換える。
このターミナル:

```bash
DEBUG=1 npm run spirit:debug
```

Expected:
```
spirit loop start (tick=10000ms, model=gpt-4o-mini)
[12:34:56] → Code | loop.ts — fire-spirit
[12:34:58]   noteContext: ユーザーは fire-spirit のコード書いてる
[12:35:08] · Code | loop.ts
[12:35:10]   stayQuiet: さっき言ったばかり、集中しているので静かに見守る
[12:35:18] → Google Chrome | X / Twitter
[12:35:20]   sendDiscord (disabled in P2): "Xかー、息抜き？それともリサーチ？"
```

(LLM がどのツールを呼ぶかはタイミング次第。少なくとも1回 sendDiscord ログが出れば成功 = LLM が反応している)

Ctrl+C で止める。`npm run dev` も止める。

- [ ] **Step 15.5: Commit**

```bash
git add src/spirit/loop.ts src/spirit/localCache.ts
git commit -m "feat(spirit): add LLM tick loop with stayQuiet/noteContext/nudgeDesire (P2)"
```

---

## Phase P3: Discord Bot 出力 (ボタンなし)

### Task 16: `src/spirit/guards.ts` を TDD で作成

**Files:**
- Create: `src/spirit/guards.ts`
- Create: `test/guards.test.ts`

- [ ] **Step 16.1: テストファースト — `test/guards.test.ts` 作成**

```ts
import { describe, expect, it } from "vitest";
import { guardSendDiscord, type GuardCtx } from "../src/spirit/guards";

function ctx(overrides: Partial<GuardCtx> = {}): GuardCtx {
  return {
    now: 1717000000000,
    currentApp: "Code",
    lastNotifiedApp: null,
    lastNotifiedAt: 0,
    pendingButtonMsgId: null,
    recentNotifyTimestamps: [],
    hourOfDay: 14,
    ...overrides,
  };
}

describe("guardSendDiscord", () => {
  it("allows a normal notification", () => {
    const r = guardSendDiscord({ text: "今 Code を書いてるね", attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
  });

  it("blocks repeat for same app within 5min", () => {
    const r = guardSendDiscord(
      { text: "Code 続けてるね", attachWorkButtons: false },
      ctx({ lastNotifiedApp: "Code", lastNotifiedAt: 1717000000000 - 3 * 60_000 }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/cooldown/i);
  });

  it("allows after cooldown elapsed", () => {
    const r = guardSendDiscord(
      { text: "Code またやってるね", attachWorkButtons: false },
      ctx({ lastNotifiedApp: "Code", lastNotifiedAt: 1717000000000 - 6 * 60_000 }),
    );
    expect(r.action).toBe("allow");
  });

  it("blocks new buttoned message while one is pending", () => {
    const r = guardSendDiscord(
      { text: "今は仕事？", attachWorkButtons: true },
      ctx({ pendingButtonMsgId: "abc123" }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/pending button/i);
  });

  it("allows buttoned message when no button is pending", () => {
    const r = guardSendDiscord(
      { text: "今は仕事？", attachWorkButtons: true },
      ctx({ pendingButtonMsgId: null }),
    );
    expect(r.action).toBe("allow");
  });

  it("blocks during night hours (0-7)", () => {
    const r = guardSendDiscord({ text: "起きてる？", attachWorkButtons: false }, ctx({ hourOfDay: 3 }));
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/night/i);
  });

  it("blocks when 8 notifications already sent this hour", () => {
    const now = 1717000000000;
    const ts = Array.from({ length: 8 }, (_, i) => now - i * 5 * 60_000);
    const r = guardSendDiscord(
      { text: "もう一個", attachWorkButtons: false },
      ctx({ now, recentNotifyTimestamps: ts }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/rate/i);
  });

  it("does not count timestamps older than 1 hour", () => {
    const now = 1717000000000;
    const ts = Array.from({ length: 8 }, (_, i) => now - (60 * 60_000 + 1000) - i * 60_000);
    const r = guardSendDiscord(
      { text: "ok", attachWorkButtons: false },
      ctx({ now, recentNotifyTimestamps: ts }),
    );
    expect(r.action).toBe("allow");
  });

  it("cuts text longer than 200 chars and allows", () => {
    const long = "あ".repeat(250);
    const r = guardSendDiscord({ text: long, attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
    expect(r.text.length).toBe(200);
  });

  it("allows normal text untouched", () => {
    const r = guardSendDiscord({ text: "短い", attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
    expect(r.text).toBe("短い");
  });
});
```

- [ ] **Step 16.2: テストが fail することを確認**

Run: `npm test`
Expected: 全テスト FAIL ("Cannot find module" 等)

- [ ] **Step 16.3: `src/spirit/guards.ts` を実装**

```ts
export type GuardCtx = {
  now: number;
  currentApp: string | null;
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;
  recentNotifyTimestamps: number[];
  hourOfDay: number;
};

export type GuardResult =
  | { action: "allow"; text: string }
  | { action: "block"; reason: string };

const COOLDOWN_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const RATE_LIMIT = 8;
const MAX_TEXT = 200;
const NIGHT_START = 0;
const NIGHT_END = 7;

export function guardSendDiscord(
  args: { text: string; attachWorkButtons: boolean },
  ctx: GuardCtx,
): GuardResult {
  if (ctx.hourOfDay >= NIGHT_START && ctx.hourOfDay < NIGHT_END) {
    return { action: "block", reason: "night quiet hours" };
  }

  if (args.attachWorkButtons && ctx.pendingButtonMsgId) {
    return { action: "block", reason: "pending button awaits user response" };
  }

  if (
    ctx.lastNotifiedApp &&
    ctx.lastNotifiedApp === ctx.currentApp &&
    ctx.now - ctx.lastNotifiedAt < COOLDOWN_MS
  ) {
    return { action: "block", reason: "same-app cooldown" };
  }

  const recent = ctx.recentNotifyTimestamps.filter((t) => ctx.now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    return { action: "block", reason: "hourly rate limit reached" };
  }

  const text = args.text.length > MAX_TEXT ? args.text.slice(0, MAX_TEXT) : args.text;
  return { action: "allow", text };
}
```

- [ ] **Step 16.4: テストが通ることを確認**

Run: `npm test`
Expected: 全 10 テスト PASS

- [ ] **Step 16.5: Commit**

```bash
git add src/spirit/guards.ts test/guards.test.ts
git commit -m "feat(spirit): add guardSendDiscord with tests (cooldown/rate/night/length)"
```

---

### Task 17: `src/spirit/discord.ts` — Bot API クライアント (ボタンなし版)

**Files:**
- Create: `src/spirit/discord.ts`

- [ ] **Step 17.1: ファイル作成**

```ts
type DiscordConfig = {
  botToken: string;
  channelId: string;
};

export type DiscordMessage = {
  text: string;
  buttons?: { label: string; customId: string; style: 1 | 2 | 3 | 4 }[];
};

type ApiMessage = {
  id: string;
};

export async function postDiscord(cfg: DiscordConfig, msg: DiscordMessage): Promise<{ id: string }> {
  const body: Record<string, unknown> = { content: msg.text };
  if (msg.buttons && msg.buttons.length > 0) {
    body.components = [
      {
        type: 1,
        components: msg.buttons.map((b) => ({
          type: 2,
          style: b.style,
          label: b.label,
          custom_id: b.customId,
        })),
      },
    ];
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${cfg.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discord ${res.status}: ${text}`);
  }
  const data = (await res.json()) as ApiMessage;
  return { id: data.id };
}
```

- [ ] **Step 17.2: typecheck**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 17.3: Commit**

```bash
git add src/spirit/discord.ts
git commit -m "feat(spirit): add Discord Bot API client for posting messages"
```

---

### Task 18: spirit loop に sendDiscord 統合 (ガード + Discord 投稿)

**Files:**
- Modify: `src/spirit/loop.ts`

- [ ] **Step 18.1: import 追加**

```ts
import { postDiscord } from "./discord";
import { guardSendDiscord, type GuardCtx } from "./guards";
```

- [ ] **Step 18.2: `cfg` を拡張**

```ts
const cfg = {
  workerUrl: process.env.WORKER_URL ?? "",
  spiritSecret: process.env.SPIRIT_SECRET ?? "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",
  discordChannelId: process.env.DISCORD_CHANNEL_ID ?? "",
};
```

- [ ] **Step 18.3: ガード用に recentNotifyTimestamps をローカル管理**

`const openai = ...` の下に追加:

```ts
const notifyHistory: number[] = [];

function buildGuardCtx(state: SpiritContext, now: number): GuardCtx {
  return {
    now,
    currentApp: state.currentApp,
    lastNotifiedApp: state.lastNotifiedApp,
    lastNotifiedAt: state.lastNotifiedAt,
    pendingButtonMsgId: state.pendingButtonMsgId,
    recentNotifyTimestamps: notifyHistory.slice(),
    hourOfDay: new Date(now).getHours(),
  };
}
```

- [ ] **Step 18.4: `dispatchTool` の sendDiscord 分岐を実装に置き換え**

```ts
    case "sendDiscord": {
      const text = String(call.args.text ?? "");
      const attachWorkButtons = call.args.attachWorkButtons === true;
      const now = Date.now();
      const guardCtx = buildGuardCtx(_ctx, now);
      const result = guardSendDiscord({ text, attachWorkButtons }, guardCtx);
      if (result.action === "block") {
        console.log(`[${logTs()}]   sendDiscord BLOCKED: ${result.reason}`);
        return;
      }
      if (!cfg.discordBotToken || !cfg.discordChannelId) {
        console.log(`[${logTs()}]   sendDiscord (no discord configured): "${result.text}"`);
        return;
      }
      try {
        const msg = await postDiscord(
          { botToken: cfg.discordBotToken, channelId: cfg.discordChannelId },
          {
            text: result.text,
            buttons: attachWorkButtons
              ? [
                  { label: "🏃 仕事中", customId: "work_mode_work", style: 1 },
                  { label: "☕ 休憩中", customId: "work_mode_break", style: 2 },
                ]
              : undefined,
          },
        );
        notifyHistory.push(now);
        while (notifyHistory.length > 0 && now - notifyHistory[0] > 60 * 60_000) {
          notifyHistory.shift();
        }
        await postAct(cfg, {
          kind: "sentDiscord",
          payload: { discordMsgId: msg.id, attachedButtons: attachWorkButtons },
        });
        console.log(`[${logTs()}]   sendDiscord OK (${msg.id}): "${result.text}"`);
      } catch (e) {
        console.error(`[${logTs()}]   sendDiscord failed:`, (e as Error).message);
      }
      break;
    }
```

(古い `case "sendDiscord":` ブロックを置き換え)

- [ ] **Step 18.5: typecheck + テスト**

Run: `npm run typecheck && npm test`
Expected: エラーなし、guard テスト通る

- [ ] **Step 18.6: 動作確認**

`.env.local` に `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` を実値で埋める (事前に Discord Developer Portal で Bot 作成 + テストサーバに招待しておく)。

```bash
npm run dev   # 別ターミナル
DEBUG=1 npm run spirit:debug
```

数分回して、テスト Discord チャンネルに「今 X 見てるんだね」みたいなメッセージが来ること、同じアプリで連投されないこと、ボタンはまだ付いていないこと (LLM はボタン true でも postDiscord 経由でボタン表示はする — それで OK) を確認。

Ctrl+C で止める。

- [ ] **Step 18.7: Commit**

```bash
git add src/spirit/loop.ts
git commit -m "feat(spirit): wire sendDiscord tool with guards and bot API (P3)"
```

---

## Phase P4: ボタン双方向 (`/interactions` 実装)

### Task 19: 署名検証ヘルパーを TDD で作成

**Files:**
- Create: `src/interactions.ts`
- Create: `test/interactions.test.ts`

- [ ] **Step 19.1: テストファースト — `test/interactions.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { verifyDiscordSignature } from "../src/interactions";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyDiscordSignature", () => {
  const keypair = nacl.sign.keyPair();
  const publicKeyHex = hex(keypair.publicKey);

  it("verifies a valid signature", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      keypair.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, body, hex(sig));
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      keypair.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, '{"type":2}', hex(sig));
    expect(ok).toBe(false);
  });

  it("rejects a wrong public key", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const other = nacl.sign.keyPair();
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      other.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, body, hex(sig));
    expect(ok).toBe(false);
  });

  it("rejects malformed hex", () => {
    expect(verifyDiscordSignature(publicKeyHex, "0", "", "ZZ")).toBe(false);
  });
});
```

- [ ] **Step 19.2: テストが fail することを確認**

Run: `npm test`
Expected: interactions テストが Module not found で fail

- [ ] **Step 19.3: `src/interactions.ts` を実装**

```ts
import nacl from "tweetnacl";

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export function verifyDiscordSignature(
  publicKeyHex: string,
  timestamp: string,
  body: string,
  signatureHex: string,
): boolean {
  const pub = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!pub || !sig || pub.length !== 32 || sig.length !== 64) return false;
  const msg = new TextEncoder().encode(timestamp + body);
  try {
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

// === Interaction payload types (subset) ===

export type DiscordInteraction = {
  type: number; // 1=PING, 3=MESSAGE_COMPONENT
  data?: { custom_id?: string };
  message?: { id?: string };
};

export type InteractionResponse = {
  type: number; // 1=PONG, 7=UPDATE_MESSAGE
  data?: { content?: string; components?: unknown[] };
};

const WORK_MODE_MS = 2 * 60 * 60_000;
const BREAK_MODE_MS = 30 * 60_000;

export type ButtonHandlerResult =
  | { kind: "pong" }
  | { kind: "updateMessage"; content: string; workMode: "work" | "break"; workModeUntil: number; messageId: string | null }
  | { kind: "ignore" };

export function handleInteraction(interaction: DiscordInteraction, now: number): ButtonHandlerResult {
  if (interaction.type === 1) return { kind: "pong" };
  if (interaction.type !== 3) return { kind: "ignore" };

  const id = interaction.data?.custom_id;
  const messageId = interaction.message?.id ?? null;
  if (id === "work_mode_work") {
    return {
      kind: "updateMessage",
      content: "✅ 仕事中モードを記録したよ (2時間有効)",
      workMode: "work",
      workModeUntil: now + WORK_MODE_MS,
      messageId,
    };
  }
  if (id === "work_mode_break") {
    return {
      kind: "updateMessage",
      content: "☕ 休憩中モードを記録したよ (30分有効)",
      workMode: "break",
      workModeUntil: now + BREAK_MODE_MS,
      messageId,
    };
  }
  return { kind: "ignore" };
}
```

- [ ] **Step 19.4: テストが通ることを確認**

Run: `npm test`
Expected: 全テスト PASS (guards 10 + interactions 4)

- [ ] **Step 19.5: Commit**

```bash
git add src/interactions.ts test/interactions.test.ts
git commit -m "feat(interactions): add Discord Ed25519 verify + button handler with tests"
```

---

### Task 20: Worker に `/interactions` ルート追加 + DO に workMode 更新エンドポイント追加

**Files:**
- Modify: `src/agent.ts` (workMode 更新ハンドラ追加)
- Modify: `src/index.ts` (/interactions ルート)

- [ ] **Step 20.1: `src/agent.ts` の switch に `/workmode` 追加**

```ts
      case "/workmode":
        return this.handleWorkMode(req);
```

- [ ] **Step 20.2: `handleWorkMode()` を実装**

`handleSpiritAct()` の直後:

```ts
  private async handleWorkMode(req: Request): Promise<Response> {
    let body: { mode?: unknown; until?: unknown; clearPendingButton?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const mode = body.mode === "work" || body.mode === "break" || body.mode === "off" ? body.mode : null;
    const until = typeof body.until === "number" ? body.until : 0;
    if (!mode) return new Response("invalid mode", { status: 400 });

    this.state.workMode = mode;
    this.state.workModeUntil = until;
    if (body.clearPendingButton === true) {
      this.state.pendingButtonMsgId = null;
    }
    await this.save();
    return Response.json({ ok: true });
  }
```

- [ ] **Step 20.3: `src/index.ts` の import と route 追加**

import:
```ts
import { handleInteraction, verifyDiscordSignature } from "./interactions";
```

`fetch()` の中、SPIRIT_PATHS の処理の後に追加:

```ts
    if (url.pathname === "/interactions" && req.method === "POST") {
      const signature = req.headers.get("x-signature-ed25519") ?? "";
      const timestamp = req.headers.get("x-signature-timestamp") ?? "";
      const bodyText = await req.text();
      if (!verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, timestamp, bodyText, signature)) {
        return new Response("invalid signature", { status: 401 });
      }
      let interaction: unknown;
      try {
        interaction = JSON.parse(bodyText);
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const result = handleInteraction(interaction as Parameters<typeof handleInteraction>[0], Date.now());
      if (result.kind === "pong") return Response.json({ type: 1 });
      if (result.kind === "ignore") return Response.json({ type: 7, data: { content: "(無視)" } });
      // updateMessage: DO に workMode 反映してから返答
      const stub = getStub(env);
      await stub.fetch(
        new Request("https://do/workmode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: result.workMode,
            until: result.workModeUntil,
            clearPendingButton: true,
          }),
        }),
      );
      return Response.json({
        type: 7,
        data: { content: result.content, components: [] },  // ボタン消す
      });
    }
```

- [ ] **Step 20.4: SPIRIT_PATHS に `/workmode` も追加するか?**

`/workmode` は内部呼び出しのみ。Worker から DO を直接叩くので SPIRIT_PATHS には入れない (= 外部公開しない)。これで OK。

- [ ] **Step 20.5: typecheck + テスト**

Run: `npm run typecheck && npm test`
Expected: エラーなし

- [ ] **Step 20.6: Commit**

```bash
git add src/agent.ts src/index.ts
git commit -m "feat(worker): handle Discord button interactions and update workMode"
```

---

### Task 21: ローカルで `/interactions` を手動テスト

**Files:** なし (検証のみ)

- [ ] **Step 21.1: `.dev.vars` に Discord Public Key を実値で書く**

Discord Developer Portal で対象アプリの "General Information" → "Public Key" をコピー、`.dev.vars` に貼る。

```
DISCORD_PUBLIC_KEY="<実際のpublic key>"
```

- [ ] **Step 21.2: cloudflared または ngrok でローカルWorkerを公開**

```bash
# 別ターミナル
npm run dev
# さらに別ターミナル
npx cloudflared tunnel --url http://localhost:8787
```

(あるいは ngrok http 8787)

公開された URL (例: `https://<random>.trycloudflare.com`) をメモ。

- [ ] **Step 21.3: Discord Developer Portal で Interactions Endpoint URL を設定**

"General Information" → "INTERACTIONS ENDPOINT URL" に `https://<random>.trycloudflare.com/interactions` を入れる。

Discord は保存時に PING を送って 200 + `{"type":1}` が返ってくるか検証する。

Expected: 保存に成功する (赤いエラーが出なければ OK)。

もし fail する場合: Worker のログを確認、`.dev.vars` の DISCORD_PUBLIC_KEY が正しいか、Worker が起動しているか確認。

- [ ] **Step 21.4: 手動でボタン付きメッセージを投稿**

別のターミナルから直接 Discord Bot API でテスト投稿:

```bash
TOKEN="<bot-token>" CHANNEL="<channel-id>" curl -X POST \
  -H "Authorization: Bot $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"テスト：今は仕事中？","components":[{"type":1,"components":[{"type":2,"style":1,"label":"🏃 仕事中","custom_id":"work_mode_work"},{"type":2,"style":2,"label":"☕ 休憩中","custom_id":"work_mode_break"}]}]}' \
  https://discord.com/api/v10/channels/$CHANNEL/messages
```

- [ ] **Step 21.5: Discord でボタンを押す → workMode が更新されることを確認**

```bash
curl -s -H "Authorization: Bearer local-dev-spirit-secret" http://localhost:8787/context | python3 -m json.tool | grep -E '(workMode|workModeUntil|pendingButtonMsgId)'
```

Expected: `workMode: "work"`, `workModeUntil` が将来時刻、`pendingButtonMsgId: null`

- [ ] **Step 21.6: P4 完了 (空コミット)**

```bash
git commit --allow-empty -m "chore(p4): verified Discord interactions end-to-end"
```

`npm run dev`, cloudflared, tunnel 全部止める。

---

## Phase P5: Polish — README、デプロイ準備

### Task 22: README に spirit セクションを追加

**Files:**
- Modify: `README.md`

- [ ] **Step 22.1: 末尾の「拡張余地（未実装）」の前に新セクション追加**

````markdown
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
````

- [ ] **Step 22.2: Commit**

```bash
git add README.md
git commit -m "docs: add spirit loop setup and operation guide to README"
```

---

### Task 23: 最終チェック — typecheck + test + ファイル一覧

**Files:** なし

- [ ] **Step 23.1: 全テストと型確認**

```bash
npm run typecheck && npm test
```

Expected: 全テスト PASS、型エラーなし

- [ ] **Step 23.2: 追加ファイルの確認**

```bash
git log --stat 52d3fe5..HEAD -- src/ test/
```

Expected: P0-P5 で書いたすべての変更が見える

- [ ] **Step 23.3: P5 完了の空コミット**

```bash
git commit --allow-empty -m "chore(p5): spirit loop implementation complete"
```

---

## 完了基準 (Done Definition)

このすべてが満たされたら完了:

- [ ] `npm run typecheck` がエラーなし
- [ ] `npm test` で guard 10件 + interactions 4件、全 PASS
- [ ] `npm run dev` + `npm run spirit:debug` を起動して 5分回し、Discord にボタン付き通知が届く
- [ ] Discord ボタンを押すと `/context` の workMode が変わる
- [ ] 同じアプリで連続通知が来ない (5分クールダウン効いてる)
- [ ] 深夜帯 (0-7時) に通知が出ない (ローカル時刻でテストするには NIGHT_END をいじって確認 → 戻す)
- [ ] README に spirit セクションが追記され、新規参入者が手順通りに動かせる

---

## Self-Review メモ

スペック (`docs/superpowers/specs/2026-05-23-spirit-resident-design.md`) との対応:

| 設計セクション | 対応 Task |
|---|---|
| 2. アーキテクチャ図 | 全体構造として全 Task で実現 |
| 3. DO state スキーマ | Task 1 |
| 4. API (`/context`) | Task 3, 4, 6 |
| 4. API (`/spirit/act`) | Task 5, 6 |
| 4. API (`/interactions`) | Task 19, 20 |
| 4. 認証 (Bearer) | Task 2, 6 |
| 5. ツール定義 | Task 13 |
| 5. system プロンプト | Task 14 |
| 5. ループフロー | Task 12 (P1) → Task 15 (P2) → Task 18 (P3) |
| 6. ガードレール (R1-R5) | Task 16 (TDD で全カバー) |
| 6. LLM 失敗ハンドリング | Task 15 (try/catch in tick) |
| 6. Worker /context 失敗 | Task 15 (localCache) |
| 6. Discord 冪等性 | Task 19 (pendingButtonMsgId クリア), Task 20 (clearPendingButton: true) |
| 6. テスト戦略 | Task 16 (guards), Task 19 (interactions), Task 8/12/15/18/21 (手動 E2E) |
| 7. ファイル構成 | "File Structure" 節と全 Task に分散 |
| 8. Phase | P0 (Task 1-8), P1 (Task 9-12), P2 (Task 13-15), P3 (Task 16-18), P4 (Task 19-21), P5 (Task 22-23) |
| 9. デプロイ手順 | Task 22 (README) |

カバレッジ確認 OK。Placeholder なし、関数名/型名は spec と一貫。
