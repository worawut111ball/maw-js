import { describe, expect, test } from "bun:test";
import { SendLedger } from "../src/mobile/api";

// A message the phone queued while offline is retried when the link comes back. When the first try did reach
// the Mac but its reply was lost, the retry must not type the message into the room a second time.
describe("SendLedger — a retried phone message is typed once", () => {
  test("the same id within the ttl is a duplicate", () => {
    const l = new SendLedger(60_000);
    expect(l.claim("ws/room/a", 1_000)).toBe(true);
    expect(l.claim("ws/room/a", 30_000)).toBe(false);
    expect(l.claim("ws/room/b", 30_000)).toBe(true);
  });

  test("after the ttl the id is new again", () => {
    const l = new SendLedger(60_000);
    expect(l.claim("x", 0)).toBe(true);
    expect(l.claim("x", 60_001)).toBe(true);
  });

  test("release frees an id that was never typed (draft in the PC's box, typing failed)", () => {
    const l = new SendLedger(60_000);
    expect(l.claim("x", 0)).toBe(true);
    l.release("x");
    expect(l.claim("x", 10)).toBe(true);
  });

  test("old ids are swept and the ledger stays bounded", () => {
    const l = new SendLedger(1_000, 3);
    for (let i = 0; i < 10; i++) l.claim("id" + i, i);
    // over the cap → the oldest went, the newest are still remembered
    expect(l.claim("id9", 20)).toBe(false);
    expect(l.claim("id0", 20)).toBe(true);
  });
});
