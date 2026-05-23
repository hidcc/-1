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
    .filter(
      (c): c is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
        c.type === "function",
    )
    .map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments) as Record<string, unknown>;
      } catch {
        // malformed args → empty
      }
      return { name: c.function.name, args };
    });
}
