import { describe, expect, it } from "vitest";
import { cents, countdown, sha256Hex } from "./format";

describe("format", () => {
  it("shows contract prices as cents", () => {
    expect(cents(0.47)).toBe("47¢");
    expect(cents(0.95)).toBe("95¢");
    expect(cents(null)).toBe("—");
  });
  it("counts down to expiry", () => {
    expect(countdown(new Date(90_000).toISOString(), 0)).toBe("1:30");
    expect(countdown(new Date(0).toISOString(), 1000)).toBe("expired");
  });
  it("hashes like sha256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
