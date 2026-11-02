import { describe, expect, test } from "bun:test";
import { dropForgedTailscaleIdentity } from "../src/core/tailscale-identity";

describe("Tailscale identity header", () => {
  const req = () => new Request("http://mac:3456/mobile/projects", { headers: { "tailscale-user-login": "someone@example.com", "x-other": "1" } });
  test("kept when the request comes through Tailscale Serve (loopback)", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(dropForgedTailscaleIdentity(req(), ip).headers.get("tailscale-user-login")).toBe("someone@example.com");
  });
  test("dropped from any other address (forged on the LAN) or an unknown one", () => {
    for (const ip of ["192.168.1.50", "100.64.0.9", "10.0.0.2", undefined]) {
      const r = dropForgedTailscaleIdentity(req(), ip);
      expect(r.headers.get("tailscale-user-login")).toBeNull();
      expect(r.headers.get("x-other")).toBe("1");
    }
  });
});
