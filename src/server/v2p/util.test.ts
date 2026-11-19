import { afterEach, describe, expect, it } from "vitest";
import { secretEqual, toolAuthorized } from "./util";

const SECRET = "test-secret-0123456789abcdefXYZ";
const req = (headers: Record<string, string> = {}, url = "https://x.test/api/public/agent-tools/find_market") =>
  new Request(url, { method: "POST", headers });

afterEach(() => {
  delete process.env["TOOL_SHARED_SECRET"];
});

describe("toolAuthorized", () => {
  it("accepts the correct X-Tool-Secret header", async () => {
    process.env["TOOL_SHARED_SECRET"] = SECRET;
    expect(await toolAuthorized(req({ "x-tool-secret": SECRET }))).toBe(true);
  });

  it("rejects a wrong or missing header", async () => {
    process.env["TOOL_SHARED_SECRET"] = SECRET;
    expect(await toolAuthorized(req({ "x-tool-secret": SECRET + "x" }))).toBe(false);
    expect(await toolAuthorized(req())).toBe(false);
  });

  it("no longer accepts the secret in the query string", async () => {
    process.env["TOOL_SHARED_SECRET"] = SECRET;
    expect(await toolAuthorized(req({}, `https://x.test/api/public/agent-tools/find_market?s=${SECRET}`))).toBe(false);
  });

  it("fails closed when the secret is unset or too short", async () => {
    expect(await toolAuthorized(req({ "x-tool-secret": "" }))).toBe(false);
    process.env["TOOL_SHARED_SECRET"] = "short";
    expect(await toolAuthorized(req({ "x-tool-secret": "short" }))).toBe(false);
  });
});

describe("secretEqual", () => {
  it("compares values and rejects an empty expected value", async () => {
    expect(await secretEqual("1234", "1234")).toBe(true);
    expect(await secretEqual("1235", "1234")).toBe(false);
    expect(await secretEqual("", "")).toBe(false);
  });
});
