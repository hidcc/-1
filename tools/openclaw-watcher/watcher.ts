// observe-only watcher: posts the active app to the fire-spirit /context endpoint.
// The LLM-driven 火神 (spirit loop) is the one that talks to Discord via OpenClaw.

import { config as loadEnv } from "dotenv";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, "..", "..", ".env.local") });

const execFileP = promisify(execFile);

type Config = {
  tickMs: number;
};

const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf-8")) as Config;
const DEBUG = process.env.DEBUG === "1";
const TICK = DEBUG ? 10_000 : cfg.tickMs;

const WORKER_URL = process.env.WORKER_URL ?? "";
const SPIRIT_SECRET = process.env.SPIRIT_SECRET ?? "";

const OSASCRIPT = `
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

async function getActiveApp(): Promise<{ app: string; title: string }> {
  try {
    const { stdout } = await execFileP("osascript", ["-e", OSASCRIPT], { timeout: 3000 });
    const [app, ...rest] = stdout.trim().split("\t");
    return { app: app ?? "", title: rest.join("\t") };
  } catch {
    return { app: "", title: "" };
  }
}

function logTs(): string {
  return new Date().toISOString().slice(11, 19);
}

async function postContext(app: string, title: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${WORKER_URL}/context`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPIRIT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ app, title, ts: Date.now() }),
    });
    if (!res.ok) {
      console.error(`[${logTs()}]   POST /context failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { switched?: boolean };
    return data.switched ?? null;
  } catch (e) {
    console.error(`[${logTs()}]   POST /context error:`, (e as Error).message);
    return null;
  }
}

let lastApp: string | null = null;

async function tick(): Promise<void> {
  const { app, title } = await getActiveApp();
  if (!app) {
    console.log(`[${logTs()}] no app`);
    return;
  }
  const switched = app !== lastApp;
  lastApp = app;

  const result = await postContext(app, title);
  const arrow = result === true || switched ? "→" : "·";
  console.log(`[${logTs()}] ${arrow} ${app} | ${title}`);
}

if (!WORKER_URL || !SPIRIT_SECRET) {
  console.error("WORKER_URL or SPIRIT_SECRET missing in .env.local");
  process.exit(1);
}

console.log(`watcher start (observe-only) — tick=${TICK}ms, worker=${WORKER_URL}`);
tick().catch((e) => console.error("first tick error:", e));
setInterval(() => {
  tick().catch((e) => console.error("tick error:", e));
}, TICK);
