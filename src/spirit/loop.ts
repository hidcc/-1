import { config } from "dotenv";
config({ path: ".env.local" });

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
