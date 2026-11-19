import { createHmac, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { dashboardMarketsFrom } from "./dashboard-markets";
import { gPrivate, gPublic } from "./gemini";

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
  expect(init?.redirect).toBe("error");
});

it("does not invent missing prices or pass through unknown upstream fields", () => {
  const markets = dashboardMarketsFrom({ data: [{ ticker: "TEST", title: "Test event", upstreamField: "omit", contracts: [{
    instrumentSymbol: "TEST-1", status: "active", marketState: "open", prices: { buy: { yes: "0.47" } },
  }] }] });
  expect(markets?.[0]).not.toHaveProperty("upstreamField");
  expect(markets?.[0]?.contracts[0]).toMatchObject({ status: "active", market_state: "open", buy: { yes: 0.47, no: null }, sell: { yes: null, no: null } });
  expect(dashboardMarketsFrom({ reason: "NotFound" })).toBeNull();
});