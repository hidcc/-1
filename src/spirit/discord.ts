type DiscordConfig = {
  botToken: string;
  channelId: string;
};

export type DiscordMessage = {
  text: string;
  buttons?: { label: string; customId: string; style: 1 | 2 | 3 | 4 }[];
};

type ApiMessage = {
  id: string;
};

export async function postDiscord(cfg: DiscordConfig, msg: DiscordMessage): Promise<{ id: string }> {
  const body: Record<string, unknown> = { content: msg.text };
  if (msg.buttons && msg.buttons.length > 0) {
    body.components = [
      {
        type: 1,
        components: msg.buttons.map((b) => ({
          type: 2,
          style: b.style,
          label: b.label,
          custom_id: b.customId,
        })),
      },
    ];
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${cfg.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discord ${res.status}: ${text}`);
  }
  const data = (await res.json()) as ApiMessage;
  return { id: data.id };
}
