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
      // observation is log-only for now; not persisted to DO state
      break;
    case "nudgeDesire": {
      const delta = (call.args.delta ?? {}) as Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
      const reason = String(call.args.reason ?? "");
      console.log(`[${logTs()}]   nudgeDesire: ${JSON.stringify(delta)} (${reason})`);
      await postAct(cfg, { kind: "nudgedDesire", payload: { delta, reason } });
      break;
    }
    case "sendDiscord":
      // P3 wires this up. P2 just logs.
      console.log(
        `[${logTs()}]   sendDiscord (disabled in P2): "${String(call.args.text ?? "").slice(0, 60)}"`,
      );
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
