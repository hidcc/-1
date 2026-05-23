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
