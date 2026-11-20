import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex } from "viem";
import { ARC_MAINNET, ARC_TESTNET, ARC_USDC, DEFAULT_PAYTO, type ResearchConfig } from "./config";
import { parsePaymentRequired, selectRequirement, parseSettlementResponse } from "./x402";
import { buildAuthorization, signAuthorization, TRANSFER_WITH_AUTHORIZATION } from "./eip3009";
import { verifyTransfer } from "./verify";
import { compare, extractMarkets, spokenSummary, type GeminiSide } from "./compare";
import { blobIO, memoryIO, researchStore } from "./store";

/**
 * TEST-ONLY stand-in for Vercel Blob: the in-memory backend already enforces the same ETag
 * conditional writes; marking it durable lets payment-path tests run without a real Blob store.
 * Production code never builds this; the server only treats blobIO as durable.
 */
const durableTestIO = () => ({ ...memoryIO(), durable: true });
import { researchService, geminiSide } from "./service";

// Captured verbatim from the unpaid probe of arc.blockrun.ai/api/v1/pm/markets/search on 2026-11-19.
const LIVE_PAYMENT_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjUwNDIiLCJhbW91bnQiOiI4NTAwIiwiYXNzZXQiOiIweDM2MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJwYXlUbyI6IjB4NjM0RDI3NGU2N0RhZmFGNzZDNTQxNTNhYTExMzkwNmE2MDZlMUUwQiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIiLCJhc3NldFRyYW5zZmVyTWV0aG9kIjoiZWlwMzAwOSJ9fV0sInJlc291cmNlIjp7InVybCI6Imh0dHBzOi8vYXJjLmJsb2NrcnVuLmFpL2FwaS92MS9wbS9tYXJrZXRzL3NlYXJjaCIsImRlc2NyaXB0aW9uIjoiU2VhcmNoIG1hcmtldHMgYWNyb3NzIFBvbHltYXJrZXQsIEthbHNoaSwgTGltaXRsZXNzLCBPcGluaW9uLCBhbmQgUHJlZGljdC5GdW4gaW4gYSBzaW5nbGUgY2FsbC4gTm90IGNoYXJnZWQgd2hlbiBubyBtYXJrZXQgbWF0Y2hlcyIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9fQ==";

// Throwaway test key (well-known anvil key #0). Never funded on Arc.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_KEY);

const cfg = (over: Partial<ResearchConfig> = {}): ResearchConfig => ({
  url: "https://arc.blockrun.ai/api/v1/pm/markets/search",
  networks: [ARC_MAINNET],
  asset: ARC_USDC.toLowerCase(),
  payTo: [DEFAULT_PAYTO.toLowerCase()],
  maxPerCallAtomic: 10_000n,
  maxPerDayAtomic: 250_000n,
  rpcUrl: () => "https://rpc.test",
  explorerTx: (_n, h) => "https://explorer.arc.io/tx/" + h,
  paymentsEnabled: true,
  ...over,
});

const liveHeaders = () => new Headers({ "payment-required": LIVE_PAYMENT_REQUIRED });

// The recorded markets close at 22:00 UTC on 2026-11-19. Pin only Date (timers stay real) so the
// suite gives the same answer whenever it runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("x402 requirement from the live BlockRun probe", () => {
  it("parses and accepts Arc mainnet USDC at $0.0085", () => {
    const pr = parsePaymentRequired(liveHeaders(), "");
    expect(pr?.x402Version).toBe(2);
    const v = selectRequirement(pr!, cfg());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.requirement.network).toBe("eip155:5042");
      expect(v.requirement.amount).toBe("8500");
      expect(v.requirement.extra).toMatchObject({ name: "USDC", version: "2" });
    }
  });
  it("refuses a network, recipient or price outside the allowlist", () => {
    const pr = parsePaymentRequired(liveHeaders(), "")!;
    expect(selectRequirement(pr, cfg({ networks: [ARC_TESTNET] }))).toMatchObject({ ok: false });
    expect(
      selectRequirement(pr, cfg({ payTo: ["0x0000000000000000000000000000000000000001"] })),
    ).toMatchObject({ ok: false });
    expect(selectRequirement(pr, cfg({ maxPerCallAtomic: 8_499n }))).toMatchObject({ ok: false });
    const tampered = {
      ...pr,
      accepts: [{ ...pr.accepts[0]!, asset: "0x1111111111111111111111111111111111111111" }],
    };
    expect(selectRequirement(tampered, cfg())).toMatchObject({ ok: false });
  });
  it("accepts the 2026-11-19 evening live probe, which adds an extensions.bazaar block", () => {
    // Captured from an unpaid GET (no payment header) during the hardening session.
    const LIVE_EVENING = "eyJ4NDAyVmVyc2lvbiI6MiwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjUwNDIiLCJhbW91bnQiOiI4NTAwIiwiYXNzZXQiOiIweDM2MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJwYXlUbyI6IjB4NjM0RDI3NGU2N0RhZmFGNzZDNTQxNTNhYTExMzkwNmE2MDZlMUUwQiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIiLCJhc3NldFRyYW5zZmVyTWV0aG9kIjoiZWlwMzAwOSJ9fV0sInJlc291cmNlIjp7InVybCI6Imh0dHBzOi8vYXJjLmJsb2NrcnVuLmFpL2FwaS92MS9wbS9tYXJrZXRzL3NlYXJjaCIsImRlc2NyaXB0aW9uIjoiU2VhcmNoIG1hcmtldHMgYWNyb3NzIFBvbHltYXJrZXQsIEthbHNoaSwgTGltaXRsZXNzLCBPcGluaW9uLCBhbmQgUHJlZGljdC5GdW4gaW4gYSBzaW5nbGUgY2FsbC4gTm90IGNoYXJnZWQgd2hlbiBubyBtYXJrZXQgbWF0Y2hlcyIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJleHRlbnNpb25zIjp7ImJhemFhciI6eyJzY2hlbWEiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsiaW5wdXQiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsicXVlcnkiOnsidHlwZSI6Im9iamVjdCIsInJlcXVpcmVkIjpbXSwicHJvcGVydGllcyI6e319fX0sIm91dHB1dCI6eyJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJleGFtcGxlIjp7InR5cGUiOiJvYmplY3QiLCJwcm9wZXJ0aWVzIjp7ImRhdGEiOnsidHlwZSI6Im9iamVjdCJ9fX19fX19LCJpbmZvIjp7ImlucHV0Ijp7InR5cGUiOiJodHRwIiwibWV0aG9kIjoiR0VUIiwiZGlzY292ZXJhYmxlIjp0cnVlLCJxdWVyeVBhcmFtcyI6e319LCJvdXRwdXQiOm51bGx9fX19";
    const pr = parsePaymentRequired(new Headers({ "payment-required": LIVE_EVENING }), "");
    const v = selectRequirement(pr!, cfg());
    expect(v).toMatchObject({ ok: true, requirement: { network: ARC_MAINNET, amount: "8500", asset: ARC_USDC, payTo: DEFAULT_PAYTO,
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } } });
    expect((pr as unknown as { extensions?: unknown }).extensions).toBeTruthy();
  });
  it("reads the settlement header", () => {
    const h = new Headers({
      "payment-response": btoa(
        JSON.stringify({
          success: true,
          transaction: "0x" + "ab".repeat(32),
          network: ARC_MAINNET,
        }),
      ),
    });
    expect(parseSettlementResponse(h)?.transaction).toBe("0x" + "ab".repeat(32));
  });
});

describe("EIP-3009 authorization", () => {
  it("signs a typed message that recovers to the research wallet on chain 5042", async () => {
    const req = selectRequirement(parsePaymentRequired(liveHeaders(), "")!, cfg());
    if (!req.ok) throw new Error("bad");
    const nonce = ("0x" + "11".repeat(32)) as Hex;
    const auth = buildAuthorization(account, req.requirement, nonce, 1_000);
    expect(auth.validBefore).toBe("1300");
    const signature = await signAuthorization(account, req.requirement, auth);
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "USDC", version: "2", chainId: 5042, verifyingContract: ARC_USDC },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: 8500n,
        validAfter: 0n,
        validBefore: 1300n,
        nonce,
      },
      signature,
    });
    expect(ok).toBe(true);
  });
});

const pad = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const receipt = (over: Record<string, unknown> = {}) => ({
  status: "0x1",
  blockNumber: "0x10",
  logs: [
    {
      address: ARC_USDC,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        pad(account.address),
        pad(DEFAULT_PAYTO),
      ],
      data: "0x" + (8500).toString(16).padStart(64, "0"),
      logIndex: "0x0",
    },
  ],
  ...over,
});
const rpc = (result: unknown) =>
  vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result })) as unknown as typeof fetch;

describe("onchain verification", () => {
  const input = {
    rpcUrl: "https://rpc.test",
    txHash: "0x" + "cd".repeat(32),
    asset: ARC_USDC,
    from: account.address,
    to: DEFAULT_PAYTO,
    amount: "8500",
  };
  it("settles only on the exact USDC transfer", async () => {
    expect((await verifyTransfer(input, rpc(receipt()))).status).toBe("settled_onchain");
    expect((await verifyTransfer({ ...input, amount: "8501" }, rpc(receipt()))).status).toBe(
      "mismatch",
    );
    expect(
      (await verifyTransfer({ ...input, to: "0x" + "22".repeat(20) }, rpc(receipt()))).status,
    ).toBe("mismatch");
    expect((await verifyTransfer(input, rpc(receipt({ status: "0x0" })))).status).toBe("mismatch");
    expect((await verifyTransfer(input, rpc(null))).status).toBe("pending");
  });
});

// Real shapes observed on 2026-11-19: Gemini sandbox BTC daily and Kalshi KXBTCD (public API).
const geminiEvent = {
  ticker: "BTC2611192200",
  title: "BTC price on November 19",
  expiryDate: "2026-11-19T22:00:00.000Z",
  sourceDetails: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
  contracts: [
    {
      label: "$61,750 or above",
      instrumentSymbol: "GEMI-BTC2611192200-HI61750",
      strike: { value: "61750" },
      expiryDate: "2026-11-19T22:00:00.000Z",
      prices: { buy: { yes: "0.98" }, sell: { yes: "0.95" } },
    },
    {
      label: "$62,250 or above",
      instrumentSymbol: "GEMI-BTC2611192200-HI62250",
      strike: { value: "62250" },
      expiryDate: "2026-11-19T22:00:00.000Z",
      prices: { buy: { yes: "0.90" }, sell: { yes: "0.86" } },
    },
  ],
};
const providerPayload = {
  kalshi: [
    {
      ticker: "KXBTCD-26NOV1917-T61749.99",
      title: "Bitcoin price on Nov 19, 2026?",
      yes_sub_title: "$61,750 or above",
      floor_strike: 61749.99,
      yes_ask_dollars: "0.3600",
      yes_bid_dollars: "0.3500",
      volume_24h_fp: "311888.08",
      close_time: "2026-11-19T22:00:00Z",
      rules_primary:
        "If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is above 61749.99...",
    },
    {
      ticker: "KXBTCD-26NOV1917-T61999.99",
      title: "Bitcoin price on Nov 19, 2026?",
      yes_sub_title: "$62,000 or above",
      floor_strike: 61999.99,
      yes_ask_dollars: "0.1300",
      volume_24h_fp: "418593.87",
      close_time: "2026-11-19T22:00:00Z",
      rules_primary: "CF Benchmarks BRTI",
    },
  ],
  polymarket: [
    {
      question: "Bitcoin Up or Down - November 19, 4PM ET",
      slug: "btc-updown",
      yesPrice: 0.52,
      volume: 90000,
      endDate: "2026-11-19T21:00:00Z",
      resolutionSource: "Chainlink BTC/USD",
    },
  ],
};

describe("cross-venue comparison", () => {
  const g: GeminiSide = geminiSide(geminiEvent, "GEMI-BTC2611192200-HI61750");
  // Fixed clock: these recorded markets close at 22:00 UTC on 2026-11-19.
  const AT = Date.parse("2026-11-19T20:00:00Z");
  const rows = compare(g, extractMarkets(providerPayload), 6, AT);

  it("finds the same strike and expiry but labels the different settlement index", () => {
    const top = rows[0]!;
    expect(top.market.venue).toBe("kalshi");
    expect(top.match).toBe("same_strike_same_expiry");
    expect(top.priceGapCents).toBe(62);
    expect(top.differences.join(" ")).toMatch(/CF Benchmarks.*Lukka/);
  });
  it("never lines up an up-or-down market as the same bet", () => {
    const pm = rows.find((r) => r.market.venue === "polymarket")!;
    expect(pm.match).toBe("different_structure");
  });
  it("labels a nearby strike as nearby, not same", () => {
    expect(rows.find((r) => r.market.id.endsWith("T61999.99"))?.match).toBe("nearby_strike");
  });
  it("speaks honestly: no forecast, no 'identical', not fair value", () => {
    const s = spokenSummary(g, rows);
    expect(s).toMatch(/36 cents/);
    expect(s).toMatch(/Not the same bet/);
    expect(s).toMatch(/not a forecast/);
    expect(s).not.toMatch(/identical|will happen|fair value is/i);
    expect(s).toMatch(/not a sure profit/); // 98 vs 36 cents
  });
  it("drops markets that have already closed instead of comparing a stale price", () => {
    const after = Date.parse("2026-11-19T22:30:00Z");
    expect(compare(g, extractMarkets(providerPayload), 6, after).filter((r) => r.market.venue === "kalshi")).toHaveLength(0);
    expect(spokenSummary(g, compare(g, extractMarkets(providerPayload), 6, after))).not.toMatch(/36 cents/);
  });
  it("never lines up an opposite-direction contract as the same bet", () => {
    const below = extractMarkets({ kalshi: [{ ticker: "KXBTCD-B", title: "Bitcoin $61,750 or below", floor_strike: 61750,
      yes_ask_dollars: "0.40", close_time: "2026-11-19T22:00:00Z", rules_primary: "CF Benchmarks BRTI" }] });
    expect(compare(g, below, 6, AT)[0]?.match).toBe("different_structure");
    expect(spokenSummary(g, compare(g, below, 6, AT))).toMatch(/can't line the prices up/);
  });
  it("ignores other assets", () => {
    expect(
      compare(
        g,
        extractMarkets({
          m: [{ title: "Ethereum above $2,000", yes_ask: 0.4, close_time: "2026-11-19T22:00:00Z" }],
        }),
        6,
        AT,
      ),
    ).toHaveLength(0);
  });
});

// ---------- full flow with mocked network ----------

function harness(
  over: { paymentsEnabled?: boolean; paidResponse?: () => Response | Promise<Response> } = {},
) {
  const io = durableTestIO();
  const store = researchStore(io);
  const calls = { probe: 0, paid: 0, rpc: 0 };
  const tx = "0x" + "ef".repeat(32);
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://rpc.test")) {
      calls.rpc++;
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_call") return Response.json({ result: "0x" + "0".repeat(64) });
      return Response.json({ result: receipt() });
    }
    const h = new Headers(init?.headers);
    if (!h.get("PAYMENT-SIGNATURE")) {
      calls.probe++;
      return new Response("{}", { status: 402, headers: liveHeaders() });
    }
    calls.paid++;
    if (over.paidResponse) return over.paidResponse();
    return new Response(JSON.stringify(providerPayload), {
      status: 200,
      headers: { "payment-response": btoa(JSON.stringify({ success: true, transaction: tx })) },
    });
  }) as unknown as typeof fetch;
  const svc = researchService({
    store,
    cfg: cfg({ paymentsEnabled: over.paymentsEnabled ?? true }),
    fetchImpl,
    account: () => account,
    loadEvent: async () => ({ event: geminiEvent }),
  });
  return { svc, calls, io, store, tx };
}
const SID = "11111111-1111-4111-8111-111111111111";

describe("research purchase flow", () => {
  it("quotes without signing anything", async () => {
    const { svc, calls } = harness();
    const q = await svc.quote({
      sid: SID,
      eventTicker: "BTC2611192200",
      contractSymbol: "GEMI-BTC2611192200-HI61750",
    });
    expect(q.status).toBe("quoted");
    expect(q.price_usd).toBe("$0.0085");
    expect(q.query).toBe("bitcoin");
    expect(calls).toMatchObject({ probe: 1, paid: 0 });
  });

  it("refuses to pay when payments are switched off", async () => {
    const { svc, calls } = harness({ paymentsEnabled: false });
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    await expect(
      svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" }),
    ).rejects.toMatchObject({ code: "PAYMENTS_DISABLED" });
    expect(calls.paid).toBe(0);
  });

  it("refuses another session's quote and a lower approved max", async () => {
    const { svc, calls } = harness();
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    await expect(
      svc.approve({
        sid: "22222222-2222-4222-8222-222222222222",
        quoteId: q.quote_id,
        maxAtomic: "10000",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "8000" }),
    ).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect(calls.paid).toBe(0);
  });

  it("pays once, verifies the Arc transfer, then compares", async () => {
    const { svc, calls, tx } = harness();
    const q = await svc.quote({
      sid: SID,
      eventTicker: "BTC2611192200",
      contractSymbol: "GEMI-BTC2611192200-HI61750",
    });
    const r = await svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" });
    expect(calls.paid).toBe(1);
    expect(r.status).toBe("settled_onchain");
    expect(r.tx_hash).toBe(tx);
    expect(r.explorer_url).toContain(tx);
    expect(r.comparison?.rows[0]?.match).toBe("same_strike_same_expiry");
    expect(r.comparison?.disclaimer).toMatch(/separate approval/);
    // Re-approving never signs again.
    await svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" });
    expect(calls.paid).toBe(1);
  });

  it("concurrent approvals produce one payment", async () => {
    const { svc, calls } = harness();
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    await Promise.all(
      [1, 2, 3].map(() => svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" })),
    );
    expect(calls.paid).toBe(1);
  });

  it("a failure after signing is never retried and is checked onchain", async () => {
    const { svc, calls } = harness({
      paidResponse: () => {
        throw new Error("timeout");
      },
    });
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    const r = await svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" });
    expect(r.status).toBe("unknown_after_sign");
    expect(r.say).toMatch(/may have gone through/);
    await svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" });
    await svc.status({ sid: SID, quoteId: q.quote_id });
    expect(calls.paid).toBe(1);
  });

  it("enforces the daily budget", async () => {
    const { svc } = harness();
    const s = researchService({
      store: (svc as unknown as { store?: never }).store ?? researchStore(durableTestIO()),
      cfg: cfg({ maxPerDayAtomic: 8_500n }),
      fetchImpl: vi.fn(async (_u: string, init?: RequestInit) =>
        new Headers(init?.headers).get("PAYMENT-SIGNATURE")
          ? new Response("{}", { status: 200 })
          : new Response("{}", { status: 402, headers: liveHeaders() }),
      ) as unknown as typeof fetch,
      account: () => account,
      loadEvent: async () => ({ event: geminiEvent }),
    });
    const a = await s.quote({ sid: SID, eventTicker: "BTC2611192200" });
    const b = await s.quote({ sid: SID, eventTicker: "BTC2611192200" });
    await s.approve({ sid: SID, quoteId: a.quote_id, maxAtomic: "10000" });
    await expect(
      s.approve({ sid: SID, quoteId: b.quote_id, maxAtomic: "10000" }),
    ).rejects.toMatchObject({ code: "DAILY_CAP" });
  });
});

describe("isolation from Gemini trading", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  it("research code never imports the trade engine, ledgers or order paths", () => {
    const forbidden =
      /from\s+["'](?:\.\.\/|@\/server\/v2p\/)(trade-engine|ledger|blob-ledger|browser-trading|market-buy|browser-order-input|agent-tools|reconcile-open|portfolio|native-combo)["']/;
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(forbidden);
  });
  it("the private key is only read in wallet.ts", () => {
    for (const f of files)
      if (f !== "wallet.ts")
        expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/ARC_RESEARCH_PRIVATE_KEY"\)/);
  });
});

describe("HTTP handler security", () => {
  const secret = "x".repeat(40);
  const setup = async () => {
    process.env["VOICE_SESSION_SECRET"] = secret;
    const { mintSessionToken } = await import("../browser-session");
    const { handleArcResearch } = await import("./handler");
    const token = await mintSessionToken({
      v: 1,
      sid: SID,
      cid: null,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const h = harness();
    const deps = {
      store: h.store,
      cfg: cfg(),
      account: () => account,
      loadEvent: async () => ({ event: geminiEvent }),
      fetchImpl: (h.svc as unknown as Record<string, never>)["f"],
    };
    return { token, handleArcResearch, h, deps };
  };
  const post = (action: string, body: unknown, token?: string) =>
    new Request("https://x/api/public/arc-research/" + action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: "Bearer " + token }),
      },
      body: JSON.stringify(body),
    });

  it("rejects requests without a signed voice session", async () => {
    const { handleArcResearch } = await setup();
    const r = await handleArcResearch(post("quote", { event_ticker: "BTC2611192200" }), "quote");
    expect(r.status).toBe(401);
  });
  it("requires the explicit on-screen confirm phrase to pay", async () => {
    const { handleArcResearch, token } = await setup();
    const r = await handleArcResearch(
      post("approve", { quote_id: "q", max_atomic: "10000" }, token),
      "approve",
    );
    expect(r.status).toBe(400);
  });
  it("config never exposes the key and reports payments off by default", async () => {
    delete process.env["ARC_RESEARCH_PAYMENTS"];
    const { handleArcResearch } = await import("./handler");
    const r = await (
      await handleArcResearch(new Request("https://x/api/public/arc-research/config"), "config")
    ).json();
    expect(r.payments_enabled).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{64}/i);
  });
});

describe("payment hardening", () => {
  it("refuses a provider host outside the allowlist without contacting it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const s = researchService({
      store: researchStore(memoryIO()), fetchImpl, account: () => account,
      cfg: cfg({ url: "https://evil.example/api/v1/pm/markets/search" }),
      loadEvent: async () => ({ event: geminiEvent }),
    });
    await expect(s.quote({ sid: SID, eventTicker: "BTC2611192200" })).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const url of ["http://arc.blockrun.ai/x", "https://arc.blockrun.ai.evil.example/x", "https://u:p@arc.blockrun.ai/x", "https://arc.blockrun.ai:8443/x"])
      await expect(researchService({ store: researchStore(memoryIO()), fetchImpl, cfg: cfg({ url }), loadEvent: async () => ({ event: geminiEvent }) })
        .quote({ sid: SID, eventTicker: "BTC2611192200" })).rejects.toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
  });

  it("re-checks the stored quote against the current caps before signing", async () => {
    const { svc, store, calls } = harness();
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    const stricter = researchService({ store, cfg: cfg({ maxPerCallAtomic: 8_000n }), account: () => account,
      fetchImpl: vi.fn() as unknown as typeof fetch, loadEvent: async () => ({ event: geminiEvent }) });
    await expect(stricter.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" })).rejects.toMatchObject({ code: "REFUSED" });
    expect((await store.get(q.quote_id))?.status).toBe("quoted");
    expect(calls.paid).toBe(0);
  });

  it("an approval interrupted after reserving is resolved onchain and never signed again", async () => {
    const { svc, store, calls } = harness();
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    // Simulates a function killed between reserving the nonce and recording the paid request.
    await store.beginSigning(q.quote_id, SID, account.address, ("0x" + "42".repeat(32)) as Hex, "9999999999", 250_000n);
    expect((await svc.status({ sid: SID, quoteId: q.quote_id })).status).toBe("signing");
    const later = researchService({ store, cfg: cfg(), account: () => account, now: () => Date.now() + 3 * 60_000,
      fetchImpl: vi.fn(async () => Response.json({ result: "0x" + "0".repeat(64) })) as unknown as typeof fetch,
      loadEvent: async () => ({ event: geminiEvent }) });
    const r = await later.status({ sid: SID, quoteId: q.quote_id });
    expect(r.status).toBe("unknown_after_sign");
    expect(r.say).toMatch(/may have gone through/);
    await later.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" });
    expect(calls.paid).toBe(0);
  });

  it("a stale-signing check never overwrites a payment that finished meanwhile", async () => {
    const { store } = harness();
    const v = selectRequirement(parsePaymentRequired(liveHeaders(), "")!, cfg());
    if (!v.ok) throw new Error(v.reason);
    const id = await store.insertQuote({ sid: SID, expires_at: Date.now() + 60_000, gemini: geminiSide(geminiEvent),
      query: "bitcoin", resource_url: cfg().url, requirement: v.requirement });
    await store.beginSigning(id, SID, account.address, ("0x" + "43".repeat(32)) as Hex, "9999999999", 250_000n);
    await store.patch(id, { status: "paid" });
    expect(await store.patchIf(id, "signing", { status: "unknown_after_sign" })).toBeNull();
    expect((await store.get(id))?.status).toBe("paid");
  });

  it("many sessions approving at once cannot exceed the shared daily budget", async () => {
    const io = durableTestIO();
    const store = researchStore(io);
    let paid = 0;
    let nonce = 0;
    const s = (sid: string) => researchService({
      store, cfg: cfg(), account: () => account, loadEvent: async () => ({ event: geminiEvent }),
      randomNonce: () => ("0x" + (++nonce).toString(16).padStart(64, "0")) as Hex,
      fetchImpl: vi.fn(async (_u: string, init?: RequestInit) => {
        if (!new Headers(init?.headers).get("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: liveHeaders() });
        paid++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const sessions = Array.from({ length: 34 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const quotes = [];
    for (const sid of sessions) quotes.push({ sid, q: await s(sid).quote({ sid, eventTicker: "BTC2611192200" }) });
    const results = await Promise.allSettled(quotes.map(({ sid, q }) => s(sid).approve({ sid, quoteId: q.quote_id, maxAtomic: "10000" })));
    for (const r of results) if (r.status === "rejected") expect(["DAILY_CAP", "BUSY"]).toContain(r.reason.code);
    expect(paid).toBeLessThanOrEqual(29); // floor($0.25 / $0.0085)
    const state = (await io.read())!.state;
    const committed = Object.values(state.purchases).filter((p) => p.status !== "quoted" && p.status !== "expired")
      .reduce((sum, p) => sum + BigInt(p.requirement.amount), 0n);
    expect(committed).toBeLessThanOrEqual(250_000n);
    const nonces = Object.values(state.purchases).map((p) => p.eip3009_nonce).filter(Boolean);
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});

describe("payments fail closed without persistent storage", () => {
  it("only Vercel Blob storage counts as durable", () => {
    expect(blobIO.durable).toBe(true);
    expect(memoryIO().durable).toBe(false);
  });

  it("refuses to sign or pay with in-memory storage even when payments and the wallet are enabled", async () => {
    const calls = { probe: 0, paid: 0 };
    const store = researchStore(memoryIO());
    const svc = researchService({
      store, cfg: cfg({ paymentsEnabled: true }), account: () => account,
      loadEvent: async () => ({ event: geminiEvent }),
      fetchImpl: vi.fn(async (_u: string, init?: RequestInit) => {
        if (new Headers(init?.headers).get("PAYMENT-SIGNATURE")) { calls.paid++; return new Response("{}", { status: 200 }); }
        calls.probe++;
        return new Response("{}", { status: 402, headers: liveHeaders() });
      }) as unknown as typeof fetch,
    });
    const q = await svc.quote({ sid: SID, eventTicker: "BTC2611192200" });
    expect(q.status).toBe("quoted"); // quoting is free and still works
    expect(q.payments_enabled).toBe(false); // the card never offers a payment it would refuse
    for (let i = 0; i < 3; i++)
      await expect(svc.approve({ sid: SID, quoteId: q.quote_id, maxAtomic: "10000" })).rejects.toMatchObject({ code: "STORAGE_REQUIRED", status: 503 });
    const p = await store.get(q.quote_id);
    expect(p).toMatchObject({ status: "quoted", eip3009_nonce: null, payer: null }); // nothing reserved or signed
    expect(calls).toEqual({ probe: 1, paid: 0 });
  });

  it("the HTTP handler without a Blob store reports payments off and refuses approval, even with the flag and a key set", async () => {
    const saved = { ...process.env };
    try {
      process.env["VOICE_SESSION_SECRET"] = "y".repeat(40);
      process.env["ARC_RESEARCH_PAYMENTS"] = "true";
      process.env["ARC_RESEARCH_PRIVATE_KEY"] = TEST_KEY;
      delete process.env["BLOB_READ_WRITE_TOKEN"];
      delete process.env["BLOB_STORE_ID"];
      vi.resetModules();
      const { mintSessionToken } = await import("../browser-session");
      const { handleArcResearch } = await import("./handler");
      const token = await mintSessionToken({ v: 1, sid: SID, cid: null, iat: Date.now(), exp: Date.now() + 60_000 });
      const paid = vi.fn();
      const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
        if (new Headers(init?.headers).get("PAYMENT-SIGNATURE")) { paid(); return new Response("{}", { status: 200 }); }
        return new Response("{}", { status: 402, headers: liveHeaders() });
      }) as unknown as typeof fetch;
      const deps = { cfg: cfg({ paymentsEnabled: true }), fetchImpl, loadEvent: async () => ({ event: geminiEvent }) };
      const post = (action: string, body: unknown) => handleArcResearch(new Request("https://x/api/public/arc-research/" + action, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) }), action, deps);

      const config = await (await handleArcResearch(new Request("https://x/api/public/arc-research/config"), "config", deps)).json();
      expect(config).toMatchObject({ payments_enabled: false, persistent_storage: false });
      const quote = await (await post("quote", { event_ticker: "BTC2611192200" })).json();
      expect(quote).toMatchObject({ ok: true, status: "quoted", payments_enabled: false });
      const r = await post("approve", { quote_id: quote.quote_id, max_atomic: "10000", confirm: "APPROVE_RESEARCH_PAYMENT" });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ ok: false, error: "STORAGE_REQUIRED" });
      expect(paid).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});
