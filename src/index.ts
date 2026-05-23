import { AgentSoul } from "./agent";
import { renderHTML } from "./html";
import { checkBearer } from "./auth";

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

    return new Response("not found", { status: 404 });
  },

  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const stub = getStub(env);
    await stub.fetch(new Request("https://do/tick"));
  },
};
