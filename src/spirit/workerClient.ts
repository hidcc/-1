export type ContextState = {
  desire: { hunger: number; sleepiness: number; loneliness: number };
  workMode: "work" | "break" | "off";
  workModeUntil: number;
  currentApp: string | null;
  currentTitle: string | null;
  lastSwitchAt: number;
  lastNotifiedApp: string | null;
  lastNotifiedAt: number;
  pendingButtonMsgId: string | null;
  recentObservations: { app: string; title: string; ts: number }[];
  recentHistory: { role: string; content: string }[];
};

export type WorkerConfig = {
  workerUrl: string;
  spiritSecret: string;
};

function authHeaders(cfg: WorkerConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.spiritSecret}` };
}

export async function getContext(cfg: WorkerConfig): Promise<ContextState> {
  const res = await fetch(`${cfg.workerUrl}/context`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`getContext ${res.status}`);
  return (await res.json()) as ContextState;
}

export async function postContext(
  cfg: WorkerConfig,
  obs: { app: string; title: string; ts: number },
): Promise<{ switched: boolean; state: ContextState }> {
  const res = await fetch(`${cfg.workerUrl}/context`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(obs),
  });
  if (!res.ok) throw new Error(`postContext ${res.status}`);
  return (await res.json()) as { switched: boolean; state: ContextState };
}

export type SpiritAct =
  | { kind: "sentDiscord"; payload: { discordMsgId?: string; attachedButtons?: boolean } }
  | {
      kind: "nudgedDesire";
      payload: {
        delta: Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
        reason: string;
      };
    }
  | { kind: "stayedQuiet"; payload: { reason: string } };

export async function postAct(cfg: WorkerConfig, act: SpiritAct): Promise<void> {
  const res = await fetch(`${cfg.workerUrl}/spirit/act`, {
    method: "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(act),
  });
  if (!res.ok) throw new Error(`postAct ${res.status}`);
}
