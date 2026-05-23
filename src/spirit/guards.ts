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

  const text = args.text.length > MAX_TEXT ? args.text.slice(0, MAX_TEXT) : args.text;
  return { action: "allow", text };
}
