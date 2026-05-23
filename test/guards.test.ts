import { describe, expect, it } from "vitest";
import { guardSendDiscord, type GuardCtx } from "../src/spirit/guards";

function ctx(overrides: Partial<GuardCtx> = {}): GuardCtx {
  return {
    now: 1717000000000,
    currentApp: "Code",
    lastNotifiedApp: null,
    lastNotifiedAt: 0,
    pendingButtonMsgId: null,
    recentNotifyTimestamps: [],
    hourOfDay: 14,
    ...overrides,
  };
}

describe("guardSendDiscord", () => {
  it("allows a normal notification", () => {
    const r = guardSendDiscord({ text: "今 Code を書いてるね", attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
  });

  it("blocks repeat for same app within 5min", () => {
    const r = guardSendDiscord(
      { text: "Code 続けてるね", attachWorkButtons: false },
      ctx({ lastNotifiedApp: "Code", lastNotifiedAt: 1717000000000 - 3 * 60_000 }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/cooldown/i);
  });

  it("allows after cooldown elapsed", () => {
    const r = guardSendDiscord(
      { text: "Code またやってるね", attachWorkButtons: false },
      ctx({ lastNotifiedApp: "Code", lastNotifiedAt: 1717000000000 - 6 * 60_000 }),
    );
    expect(r.action).toBe("allow");
  });

  it("blocks new buttoned message while one is pending", () => {
    const r = guardSendDiscord(
      { text: "今は仕事？", attachWorkButtons: true },
      ctx({ pendingButtonMsgId: "abc123" }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/pending button/i);
  });

  it("allows buttoned message when no button is pending", () => {
    const r = guardSendDiscord(
      { text: "今は仕事？", attachWorkButtons: true },
      ctx({ pendingButtonMsgId: null }),
    );
    expect(r.action).toBe("allow");
  });

  it("blocks during night hours (0-7)", () => {
    const r = guardSendDiscord({ text: "起きてる？", attachWorkButtons: false }, ctx({ hourOfDay: 3 }));
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/night/i);
  });

  it("blocks when 8 notifications already sent this hour", () => {
    const now = 1717000000000;
    const ts = Array.from({ length: 8 }, (_, i) => now - i * 5 * 60_000);
    const r = guardSendDiscord(
      { text: "もう一個", attachWorkButtons: false },
      ctx({ now, recentNotifyTimestamps: ts }),
    );
    expect(r.action).toBe("block");
    expect(r.reason).toMatch(/rate/i);
  });

  it("does not count timestamps older than 1 hour", () => {
    const now = 1717000000000;
    const ts = Array.from({ length: 8 }, (_, i) => now - (60 * 60_000 + 1000) - i * 60_000);
    const r = guardSendDiscord(
      { text: "ok", attachWorkButtons: false },
      ctx({ now, recentNotifyTimestamps: ts }),
    );
    expect(r.action).toBe("allow");
  });

  it("cuts text longer than 200 chars and allows", () => {
    const long = "あ".repeat(250);
    const r = guardSendDiscord({ text: long, attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
    if (r.action === "allow") expect(r.text.length).toBe(200);
  });

  it("allows normal text untouched", () => {
    const r = guardSendDiscord({ text: "短い", attachWorkButtons: false }, ctx());
    expect(r.action).toBe("allow");
    if (r.action === "allow") expect(r.text).toBe("短い");
  });
});
