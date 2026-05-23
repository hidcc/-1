import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { verifyDiscordSignature } from "../src/interactions";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyDiscordSignature", () => {
  const keypair = nacl.sign.keyPair();
  const publicKeyHex = hex(keypair.publicKey);

  it("verifies a valid signature", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      keypair.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, body, hex(sig));
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      keypair.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, '{"type":2}', hex(sig));
    expect(ok).toBe(false);
  });

  it("rejects a wrong public key", () => {
    const timestamp = "1717000000";
    const body = '{"type":1}';
    const other = nacl.sign.keyPair();
    const sig = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      other.secretKey,
    );
    const ok = verifyDiscordSignature(publicKeyHex, timestamp, body, hex(sig));
    expect(ok).toBe(false);
  });

  it("rejects malformed hex", () => {
    expect(verifyDiscordSignature(publicKeyHex, "0", "", "ZZ")).toBe(false);
  });
});
