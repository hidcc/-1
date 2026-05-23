import {
  AgentState,
  buildFeedReactionPrompt,
  buildHungrySystemPrompt,
  buildNapReactionPrompt,
  buildPushPrompt,
  buildSleepReply,
  buildSystemPrompt,
  fallbackFeedReaction,
  fallbackNapReaction,
  HUNGRY_THRESHOLD,
  SLEEP_THRESHOLD,
} from "./personality";
import { chatCompletion, ChatMessage } from "./openai";

const HISTORY_LIMIT = 10;
const OBS_LIMIT = 20;  // keep last 20 app observations to bound state size

// JST 時刻ベースで欲求の増分を決める。
// hunger: 9時/12時/19時の食事時間帯 (1時間幅) だけ +20/分
// sleepiness: 22時～翌7時の夜だけ +12/分
// loneliness: 常時 +25/分 (社会的欲求は時間帯に依らない)
function getJstHour(now: Date = new Date()): number {
  const jstMs = now.getTime() + 9 * 3600 * 1000;
  return new Date(jstMs).getUTCHours();
}

function computeDecay(now: Date = new Date()): {
  hunger: number;
  sleepiness: number;
  loneliness: number;
} {
  const hr = getJstHour(now);
  const isMealHour = hr === 9 || hr === 12 || hr === 19;
  const isNight = hr >= 22 || hr < 7;
  return {
    hunger: isMealHour ? 20 : 0,
    sleepiness: isNight ? 12 : 0,
    loneliness: 25,
  };
}

const PUSH = {
  lonelinessThreshold: 70,
  minSilenceMs: 2 * 60 * 1000,
  minIntervalMs: 3 * 60 * 1000,
} as const;

const DEFAULT_STATE: AgentState = {
  hunger: 50,
  sleepiness: 50,
  loneliness: 50,
  history: [],
  pendingPush: null,
  lastUserMsgAt: 0,
  lastPushAt: 0,

  currentApp: null,
  currentTitle: null,
  lastSwitchAt: 0,
  recentObservations: [],

  workMode: "off",
  workModeUntil: 0,

  lastNotifiedApp: null,
  lastNotifiedAt: 0,
  pendingButtonMsgId: null,
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

type Env = {
  OPENAI_API_KEY: string;
  AGENT: DurableObjectNamespace;
  SPIRIT_SECRET: string;
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
    const stored = await this.ctx.storage.get<Partial<AgentState>>("s");
    // Merge defaults so newly-added fields (e.g. recentObservations) are present
    // even when the persisted state predates the schema extension.
    this.state = { ...structuredClone(DEFAULT_STATE), ...(stored ?? {}) };
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
      case "/context":
        if (req.method === "GET") return this.handleContextGet();
        if (req.method === "POST") return this.handleContextPost(req);
        return new Response("method not allowed", { status: 405 });
      case "/spirit/act":
        return this.handleSpiritAct(req);
      case "/workmode":
        return this.handleWorkMode(req);
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

    let reply: string;
    if (this.state.sleepiness >= SLEEP_THRESHOLD) {
      // Asleep: skip OpenAI entirely, return canned drowsy sound.
      reply = buildSleepReply();
    } else {
      const system =
        this.state.hunger >= HUNGRY_THRESHOLD
          ? buildHungrySystemPrompt(this.state)
          : buildSystemPrompt(this.state);
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...this.state.history.map((m) => ({ role: m.role, content: m.content })),
      ];
      try {
        reply = await chatCompletion(this.env.OPENAI_API_KEY, messages);
        if (!reply) reply = "...";
      } catch (e) {
        console.error("chat openai error", e);
        reply = "(返事に詰まった...)";
      }
    }

    this.state.history.push({ role: "assistant", content: reply, ts: Date.now() });
    while (this.state.history.length > HISTORY_LIMIT) {
      this.state.history.shift();
    }
    await this.save();
    return Response.json({ reply, state: this.publicView() });
  }

  private async handleFeed(): Promise<Response> {
    const prevHunger = this.state.hunger;
    this.state.hunger = 0;
    this.state.history.push({ role: "user", content: "（ごはんをあげた）", ts: Date.now() });

    let reply: string;
    try {
      reply = await chatCompletion(
        this.env.OPENAI_API_KEY,
        [{ role: "system", content: buildFeedReactionPrompt(prevHunger) }],
        60,
      );
      if (!reply) reply = fallbackFeedReaction();
    } catch (e) {
      console.error("feed openai error", e);
      reply = fallbackFeedReaction();
    }

    this.state.history.push({ role: "assistant", content: reply, ts: Date.now() });
    while (this.state.history.length > HISTORY_LIMIT) this.state.history.shift();
    await this.save();
    return Response.json({ ok: true, reply, state: this.publicView() });
  }

  private async handleNap(): Promise<Response> {
    const prevSleepiness = this.state.sleepiness;
    this.state.sleepiness = 0;
    this.state.history.push({ role: "user", content: "（寝かせてあげた）", ts: Date.now() });

    let reply: string;
    try {
      reply = await chatCompletion(
        this.env.OPENAI_API_KEY,
        [{ role: "system", content: buildNapReactionPrompt(prevSleepiness) }],
        60,
      );
      if (!reply) reply = fallbackNapReaction();
    } catch (e) {
      console.error("nap openai error", e);
      reply = fallbackNapReaction();
    }

    this.state.history.push({ role: "assistant", content: reply, ts: Date.now() });
    while (this.state.history.length > HISTORY_LIMIT) this.state.history.shift();
    await this.save();
    return Response.json({ ok: true, reply, state: this.publicView() });
  }

  private contextBody(): Record<string, unknown> {
    return {
      desire: {
        hunger: this.state.hunger,
        sleepiness: this.state.sleepiness,
        loneliness: this.state.loneliness,
      },
      workMode: this.state.workMode,
      workModeUntil: this.state.workModeUntil,
      currentApp: this.state.currentApp,
      currentTitle: this.state.currentTitle,
      lastSwitchAt: this.state.lastSwitchAt,
      lastNotifiedApp: this.state.lastNotifiedApp,
      lastNotifiedAt: this.state.lastNotifiedAt,
      pendingButtonMsgId: this.state.pendingButtonMsgId,
      recentObservations: this.state.recentObservations,
      recentHistory: this.state.history.slice(-5).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
  }

  private handleContextGet(): Response {
    return Response.json(this.contextBody());
  }

  private async handleContextPost(req: Request): Promise<Response> {
    let body: { app?: unknown; title?: unknown; ts?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const app = typeof body.app === "string" ? body.app : "";
    const title = typeof body.title === "string" ? body.title : "";
    const ts = typeof body.ts === "number" ? body.ts : Date.now();
    if (!app) return new Response("missing app", { status: 400 });

    const switched = this.state.currentApp !== app;
    if (switched) {
      this.state.currentApp = app;
      this.state.currentTitle = title;
      this.state.lastSwitchAt = ts;
      this.state.recentObservations.push({ app, title, ts });
      while (this.state.recentObservations.length > OBS_LIMIT) {
        this.state.recentObservations.shift();
      }
    } else {
      // Title-only change: update but don't pollute observation history
      this.state.currentTitle = title;
    }

    // workMode auto-reset
    if (this.state.workMode !== "off" && this.state.workModeUntil > 0 && ts > this.state.workModeUntil) {
      this.state.workMode = "off";
      this.state.workModeUntil = 0;
    }

    await this.save();
    return Response.json({ switched, state: this.contextBody() });
  }

  private async handleSpiritAct(req: Request): Promise<Response> {
    let body: { kind?: unknown; payload?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const kind = typeof body.kind === "string" ? body.kind : "";
    const payload = (body.payload ?? {}) as Record<string, unknown>;

    const now = Date.now();
    switch (kind) {
      case "sentDiscord": {
        const msgId = typeof payload.discordMsgId === "string" ? payload.discordMsgId : null;
        this.state.lastNotifiedApp = this.state.currentApp;
        this.state.lastNotifiedAt = now;
        // attachedButtons=true: this send is a question awaiting a button reply
        //                       → mark pending so we don't stack questions
        // attachedButtons=false: regular notification (incl. text-suffix "!work" affordance)
        //                       → clear any stale pending (no button-click loop possible here)
        if (payload.attachedButtons === true && msgId) {
          this.state.pendingButtonMsgId = msgId;
        } else {
          this.state.pendingButtonMsgId = null;
        }
        break;
      }
      case "nudgedDesire": {
        const delta = (payload.delta ?? {}) as Partial<Record<"hunger" | "sleepiness" | "loneliness", number>>;
        for (const k of ["hunger", "sleepiness", "loneliness"] as const) {
          const d = delta[k];
          if (typeof d === "number") {
            this.state[k] = clamp(this.state[k] + d);
          }
        }
        break;
      }
      case "stayedQuiet":
        // log-only; the spirit loop already logs locally
        break;
      default:
        return new Response("unknown kind", { status: 400 });
    }

    await this.save();
    return Response.json({ ok: true });
  }

  private async handleWorkMode(req: Request): Promise<Response> {
    let body: { mode?: unknown; until?: unknown; clearPendingButton?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const mode = body.mode === "work" || body.mode === "break" || body.mode === "off" ? body.mode : null;
    const until = typeof body.until === "number" ? body.until : 0;
    if (!mode) return new Response("invalid mode", { status: 400 });

    this.state.workMode = mode;
    this.state.workModeUntil = until;
    if (body.clearPendingButton === true) {
      this.state.pendingButtonMsgId = null;
    }
    await this.save();
    return Response.json({ ok: true });
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
    const decay = computeDecay();
    this.state.hunger = clamp(this.state.hunger + decay.hunger);
    this.state.sleepiness = clamp(this.state.sleepiness + decay.sleepiness);
    this.state.loneliness = clamp(this.state.loneliness + decay.loneliness);

    const silentFor = now - this.state.lastUserMsgAt;
    const sincePush = now - this.state.lastPushAt;
    const shouldPush =
      this.state.sleepiness < SLEEP_THRESHOLD &&
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
