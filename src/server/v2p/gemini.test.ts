import { createHmac, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { dashboardMarketsFrom } from "./dashboard-markets";
import { classifyFetchError, gPrivate, gPublic } from "./gemini";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("refuses production before sending a request", async () => {
  vi.stubEnv("GEMINI_API_BASE_URL", "https://api.gemini.com");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  expect((await gPublic("/v1/prediction-markets/events")).ok).toBe(false);
  expect((await gPrivate("/v1/balances")).ok).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("signs epoch seconds without a body and blocks redirects", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubEnv("GEMINI_API_BASE_URL", "https://api.sandbox.gemini.com/");
  vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
  vi.stubEnv("GEMINI_API_SECRET", "unit-test-secret");
  vi.spyOn(Date, "now").mockReturnValue(1776294447123);
  const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({ hasAcceptedLatest: true }));
  vi.stubGlobal("fetch", fetchSpy);
  await gPrivate("/v1/prediction-markets/terms/status", {}, { method: "GET" });
  const [url, init] = fetchSpy.mock.calls[0] ?? [];
  const headers = new Headers(init?.headers);
  const payload = headers.get("x-gemini-payload") ?? "";
  expect(String(url)).toBe("https://api.sandbox.gemini.com/v1/prediction-markets/terms/status");
  expect(JSON.parse(atob(payload))).toEqual({ request: "/v1/prediction-markets/terms/status", nonce: 1776294447 });
  expect(headers.get("x-gemini-signature")).toBe(createHmac("sha384", "unit-test-secret").update(payload).digest("hex"));
  expect(init?.body).toBeUndefined();
  // Cloudflare Workers throw on redirect: "error"; "manual" + refusing 3xx keeps redirects blocked.
  expect(init?.redirect).toBe("manual");
});

it("refuses to follow a redirect from Gemini", async () => {
  const fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await gPublic("/v1/prediction-markets/events", { limit: 1 });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(302);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it("reports the failure category and logs no secrets when fetch throws", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
  vi.stubEnv("GEMINI_API_SECRET", "unit-test-secret");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await gPrivate("/v1/balances");
  expect(r.status).toBe(0);
  expect(r.error).toContain("(client_config)");
  const logged = log.mock.calls.map((c) => c.join(" ")).join("\n");
  expect(logged).toContain('"category":"client_config"');
  expect(logged).toContain('"path":"/v1/balances"');
  expect(logged).not.toMatch(/unit-test-key|unit-test-secret|x-gemini|signature/i);
});

it("classifies common network failures", () => {
  expect(classifyFetchError(new Error("x"), true)).toBe("timeout");
  expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), false)).toBe("dns");
  expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), false)).toBe("tls");
  expect(classifyFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), false)).toBe("network");
});

it("does not invent missing prices or pass through unknown upstream fields", () => {
  const markets = dashboardMarketsFrom({ data: [{ ticker: "TEST", title: "Test event", upstreamField: "omit", contracts: [{
    instrumentSymbol: "TEST-1", status: "active", marketState: "open", prices: { buy: { yes: "0.47" } },
  }] }] });
  expect(markets?.[0]).not.toHaveProperty("upstreamField");
  expect(markets?.[0]?.contracts[0]).toMatchObject({ status: "active", market_state: "open", buy: { yes: 0.47, no: null }, sell: { yes: null, no: null } });
  expect(dashboardMarketsFrom({ reason: "NotFound" })).toBeNull();
});