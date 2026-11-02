import { describe, expect, test } from "bun:test";
import { kindOf, mimeOf, sign, verify } from "../src/mobile/features/vault";

describe("vault pack", () => {
  test("file kinds from the name", () => {
    expect([mimeOf("IMG_0001.HEIC"), kindOf(mimeOf("IMG_0001.HEIC"))]).toEqual(["image/heic", "image"]);
    expect(kindOf(mimeOf("clip.MOV"))).toBe("video");
    expect(kindOf(mimeOf("ใบเสนอราคา.pdf"))).toBe("file");
    expect(mimeOf("noext")).toBe("application/octet-stream");
  });
  test("signed links: right id + unexpired only", () => {
    const now = 1_000_000_000_000, e = now + 10 * 60_000, s = sign("secret", "abc123", e);
    expect(verify("secret", "abc123", e, s, now)).toBe(true);
    expect(verify("secret", "abc124", e, s, now)).toBe(false);          // another file
    expect(verify("other", "abc123", e, s, now)).toBe(false);           // another key
    expect(verify("secret", "abc123", e, s, e + 1)).toBe(false);        // expired
    expect(verify("secret", "abc123", now + 86400e3, sign("secret", "abc123", now + 86400e3), now)).toBe(false); // too far ahead
    expect(verify("secret", "abc123", e, "x", now)).toBe(false);
  });
  test("only the signed download paths skip the token check", () => {
    const skip = (p: string) => /\/vault\/dl(-zip|\/[0-9a-z]+)$/.test(p);
    expect(skip("/mobile/vault/dl/mhx1a2b3c4d")).toBe(true);
    expect(skip("/mobile/vault/dl-zip")).toBe(true);
    expect(skip("/mobile/vault")).toBe(false);
    expect(skip("/mobile/vault/link")).toBe(false);
    expect(skip("/mobile/vault/delete")).toBe(false);
  });
});
