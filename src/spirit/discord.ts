import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

type OpenclawConfig = {
  channelId: string; // e.g. "1507610233894338710" (no "channel:" prefix)
};

export type DiscordMessage = {
  text: string;
  // OpenClaw CLI does not currently propagate components; loop should append
  // a text suffix when it wants the user to "answer" something (e.g. !work / !break).
  // The `buttons` field is kept for type compatibility but ignored.
  buttons?: { label: string; customId: string; style: 1 | 2 | 3 | 4 }[];
};

export async function postDiscord(cfg: OpenclawConfig, msg: DiscordMessage): Promise<{ id: string }> {
  await execFileP(
    "openclaw",
    [
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      `channel:${cfg.channelId}`,
      "--message",
      msg.text,
    ],
    { timeout: 15_000 },
  );
  // openclaw CLI doesn't expose the Discord message id in a parseable way here,
  // so return a synthetic id. We no longer rely on the real id for button tracking
  // because OpenClaw delivers button replies as inbound chat messages, not via webhook.
  return { id: `openclaw-${Date.now()}` };
}
