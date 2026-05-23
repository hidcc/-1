import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { getActiveApp } from "./observe";
import { postContext, postAct } from "./workerClient";
import { saveLastState, loadLastState } from "./localCache";
import { SPIRIT_TOOLS, parseToolCalls, type ToolCall } from "./tools";
import { buildSpiritSystemPrompt, type SpiritContext } from "../personality";
import { postDiscord } from "./discord";
import { guardSendDiscord, type GuardCtx } from "./guards";

const here = dirname(fileURLToPath(import.meta.url));
const watcherConfigPath = join(here, "..", "..", "tools", "openclaw-watcher", "config.json");
type WatcherConfig = { workApps?: string[]; reportEveryMs?: number };
let watcherConfig: WatcherConfig = {};
try {
  watcherConfig = JSON.parse(readFileSync(watcherConfigPath, "utf-8")) as WatcherConfig;
} catch {
  // watcher config absent → workApps undefined, allowlist guidance skipped
}

const DEBUG = process.env.DEBUG === "1";
const TICK_MS = DEBUG ? 10_000 : 60_000;
const MODEL = "gpt-4o-mini";

const cfg = {
  workerUrl: process.env.WORKER_URL ?? "",
  spiritSecret: process.env.SPIRIT_SECRET ?? "",
  discordChannelId: process.env.DISCORD_CHANNEL_ID ?? "",
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

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

function logTs(): string {
  return new Date().toISOString().slice(11, 19);
}

async function dispatchTool(call: ToolCall, ctx: SpiritContext): Promise<void> {
  switch (call.name) {
    case "stayQuiet":
      console.log(`[${logTs()}]   stayQuiet: ${(call.args.reason as string) ?? ""}`);
      await postAct(cfg, { kind: "stayedQuiet", payload: { reason: String(call.args.reason ?? "") } });
      break;
    case "noteContext":
      console.log(`[${logTs()}]   noteContext: ${(call.args.observation as string) ?? ""}`);
      // observation is log-only for now; not persisted to DO state
      break;
    case "nudgeDesire": {
      const delta = (call.args.delta ?? {}) as Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
      const reason = String(call.args.reason ?? "");
      console.log(`[${logTs()}]   nudgeDesire: ${JSON.stringify(delta)} (${reason})`);
      await postAct(cfg, { kind: "nudgedDesire", payload: { delta, reason } });
      break;
    }
    case "sendDiscord": {
      const text = String(call.args.text ?? "");
      const attachWorkButtons = call.args.attachWorkButtons === true;
      const now = Date.now();
      const guardCtx = buildGuardCtx(ctx, now);
      const result = guardSendDiscord({ text, attachWorkButtons }, guardCtx);
      if (result.action === "block") {
        console.log(`[${logTs()}]   sendDiscord BLOCKED: ${result.reason}`);
        return;
      }
      if (!cfg.discordChannelId) {
        console.log(`[${logTs()}]   sendDiscord (no DISCORD_CHANNEL_ID): "${result.text}"`);
        return;
      }
      // OpenClaw CLI cannot send interactive components; encode the work/break
      // question as a text affordance instead.
      const finalText = attachWorkButtons
        ? `${result.text}\n仕事なら \`!work\`、休憩なら \`!break\` と返信してね`
        : result.text;
      try {
        const msg = await postDiscord(
          { channelId: cfg.discordChannelId },
          { text: finalText },
        );
        notifyHistory.push(now);
        while (notifyHistory.length > 0 && now - notifyHistory[0] > 60 * 60_000) {
          notifyHistory.shift();
        }
        // OpenClaw delivers button replies as inbound text (!work/!break), not via
        // webhook. We can't track pending state reliably, so always pass false to
        // skip pendingButtonMsgId. The text suffix in finalText is the affordance.
        await postAct(cfg, {
          kind: "sentDiscord",
          payload: { discordMsgId: msg.id, attachedButtons: false },
        });
        console.log(`[${logTs()}]   sendDiscord OK (${msg.id}): "${finalText.replace(/\n/g, " | ")}"`);
      } catch (e) {
        console.error(`[${logTs()}]   sendDiscord failed:`, (e as Error).message);
      }
      break;
    }
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

  const enrichedCtx: SpiritContext = {
    ...ctx,
    workApps: watcherConfig.workApps,
    reportEveryMs: watcherConfig.reportEveryMs,
  };
  const system = buildSpiritSystemPrompt(enrichedCtx);
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
      console.log(
        `[${logTs()}]   (no tool call — content: ${res.choices[0].message.content?.slice(0, 60) ?? ""})`,
      );
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
