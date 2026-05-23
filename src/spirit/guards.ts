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

export function guardSendDiscord(
  args: { text: string; attachWorkButtons: boolean },
  _ctx: GuardCtx,
): GuardResult {
  const text = args.text.length > MAX_TEXT ? args.text.slice(0, MAX_TEXT) : args.text;
  return { action: "allow", text };
}
