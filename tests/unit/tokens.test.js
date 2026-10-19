import { describe, it, expect } from "vitest";
import {
  signAccessToken,
  verifyAccessToken,
  createRefreshToken,
  hashRefreshToken,
} from "../../src/lib/tokens.js";

describe("tokens", () => {
  const admin = { id: "11111111-1111-4111-8111-111111111111", username: "root" };

  it("signs and verifies an access token", () => {
    const token = signAccessToken(admin);
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe(admin.id);
    expect(payload.username).toBe("root");
  });

  it("rejects a tampered access token", () => {
    const token = signAccessToken(admin);
    expect(() => verifyAccessToken(`${token}x`)).toThrow();
  });

  it("issues opaque refresh tokens stored by hash", () => {
    const a = createRefreshToken();
    const b = createRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashRefreshToken(a.token));
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.token).not.toContain(a.hash);
  });
});
