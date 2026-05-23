import { AgentSoul } from "./agent";
import { renderHTML } from "./html";
import { checkBearer } from "./auth";
import { handleInteraction, verifyDiscordSignature } from "./interactions";

export { AgentSoul };

type Env = {
  OPENAI_API_KEY: string;
  AGENT: DurableObjectNamespace;
  SPIRIT_SECRET: string;
  DISCORD_PUBLIC_KEY: string;  // used in Task 19+ (declared now)
};

const PROXY_PATHS = new Set(["/chat", "/feed", "/nap", "/state"]);
const SPIRIT_PATHS = new Set(["/context", "/spirit/act"]);

function getStub(env: Env) {
  const id = env.AGENT.idFromName("demo");
  return env.AGENT.get(id);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (PROXY_PATHS.has(url.pathname)) {
      const stub = getStub(env);
      return stub.fetch(new Request("https://do" + url.pathname, req));
    }

    if (SPIRIT_PATHS.has(url.pathname)) {
      if (!checkBearer(req, env.SPIRIT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = getStub(env);
      return stub.fetch(new Request("https://do" + url.pathname, req));
    }

    if (url.pathname === "/interactions" && req.method === "POST") {
      const signature = req.headers.get("x-signature-ed25519") ?? "";
      const timestamp = req.headers.get("x-signature-timestamp") ?? "";
      const bodyText = await req.text();
      if (!verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, timestamp, bodyText, signature)) {
        return new Response("invalid signature", { status: 401 });
      }
      let interaction: unknown;
      try {
        interaction = JSON.parse(bodyText);
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const result = handleInteraction(
        interaction as Parameters<typeof handleInteraction>[0],
        Date.now(),
      );
      if (result.kind === "pong") return Response.json({ type: 1 });
      if (result.kind === "ignore") {
        return Response.json({ type: 4, data: { content: "(無視)", flags: 64 } });
      }
      // updateMessage: reflect workMode to DO before responding
      const stub = getStub(env);
      await stub.fetch(
        new Request("https://do/workmode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: result.workMode,
            until: result.workModeUntil,
            clearPendingButton: true,
          }),
        }),
      );
      return Response.json({
        type: 7,
        data: { content: result.content, components: [] },
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const stub = getStub(env);
    await stub.fetch(new Request("https://do/tick"));
  },
};
