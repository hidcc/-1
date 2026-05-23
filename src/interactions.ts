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
  | {
      kind: "updateMessage";
      content: string;
      workMode: "work" | "break";
      workModeUntil: number;
      messageId: string | null;
    }
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
