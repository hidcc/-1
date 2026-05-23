import {
  AgentState,
  buildPushPrompt,
  buildSystemPrompt,
} from "./personality";
import { chatCompletion, ChatMessage } from "./openai";

const HISTORY_LIMIT = 10;

const DECAY = {
  hunger: 20,
  sleepiness: 12,
  loneliness: 25,
} as const;

const PUSH = {
  lonelinessThreshold: 70,
  minSilenceMs: 2 * 60 * 1000,
  minIntervalMs: 3 * 60 * 1000,
} as const;

const DEFAULT_STATE: AgentState = {
  hunger: 0,
  sleepiness: 0,
  loneliness: 0,
  history: [],
  pendingPush: null,
  lastUserMsgAt: 0,
  lastPushAt: 0,
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

type Env = {
  OPENAI_API_KEY: string;
  AGENT: DurableObjectNamespace;
};

export class AgentSoul {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private state: AgentState = structuredClone(DEFAULT_STATE);
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<AgentState>("s");
    this.state = stored ?? structuredClone(DEFAULT_STATE);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("s", this.state);
  }

  private publicView(): {
    hunger: number;
    sleepiness: number;
    loneliness: number;
  } {
    return {
      hunger: this.state.hunger,
      sleepiness: this.state.sleepiness,
      loneliness: this.state.loneliness,
    };
  }

  async fetch(req: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/chat":
        return this.handleChat(req);
      case "/feed":
        return this.handleFeed();
      case "/nap":
        return this.handleNap();
      case "/state":
        return this.handleState();
      case "/tick":
        return this.handleTick();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleChat(req: Request): Promise<Response> {
    let body: { message?: unknown };
    try {
      body = (await req.json()) as { message?: unknown };
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return new Response("missing message", { status: 400 });

    const now = Date.now();
    this.state.loneliness = clamp(this.state.loneliness - 30);
    this.state.lastUserMsgAt = now;
    this.state.history.push({ role: "user", content: message, ts: now });

    const system = buildSystemPrompt(this.state);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...this.state.history.map((m) => ({ role: m.role, content: m.content })),
    ];

    let reply: string;
    try {
      reply = await chatCompletion(this.env.OPENAI_API_KEY, messages);
      if (!reply) reply = "...";
    } catch (e) {
      console.error("chat openai error", e);
      reply = "(返事に詰まった...)";
    }

    this.state.history.push({ role: "assistant", content: reply, ts: Date.now() });
    while (this.state.history.length > HISTORY_LIMIT) {
      this.state.history.shift();
    }
    await this.save();
    return Response.json({ reply, state: this.publicView() });
  }

  private async handleFeed(): Promise<Response> {
    this.state.hunger = 0;
    await this.save();
    return Response.json({ ok: true, state: this.publicView() });
  }

  private async handleNap(): Promise<Response> {
    this.state.sleepiness = 0;
    await this.save();
    return Response.json({ ok: true, state: this.publicView() });
  }

  private async handleState(): Promise<Response> {
    const out = {
      ...this.publicView(),
      pendingPush: this.state.pendingPush,
    };
    if (this.state.pendingPush) {
      this.state.pendingPush = null;
      await this.save();
    }
    return Response.json(out);
  }

  private async handleTick(): Promise<Response> {
    const now = Date.now();
    this.state.hunger = clamp(this.state.hunger + DECAY.hunger);
    this.state.sleepiness = clamp(this.state.sleepiness + DECAY.sleepiness);
    this.state.loneliness = clamp(this.state.loneliness + DECAY.loneliness);

    const silentFor = now - this.state.lastUserMsgAt;
    const sincePush = now - this.state.lastPushAt;
    const shouldPush =
      this.state.loneliness >= PUSH.lonelinessThreshold &&
      silentFor > PUSH.minSilenceMs &&
      sincePush > PUSH.minIntervalMs;

    if (shouldPush) {
      const minutes = Math.max(1, Math.floor(silentFor / 60000));
      const prompt = buildPushPrompt(this.state, minutes);
      try {
        const push = await chatCompletion(
          this.env.OPENAI_API_KEY,
          [{ role: "system", content: prompt }],
          60,
        );
        if (push) {
          this.state.pendingPush = push;
          this.state.lastPushAt = now;
        }
      } catch (e) {
        console.error("push openai error", e);
      }
    }

    await this.save();
    return Response.json({ ok: true, state: this.publicView() });
  }
}
