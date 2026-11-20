// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON response bodies in assertions */
// All network, SDK, Gateway, Gemini and storage are mocked. These tests never contact QuickNode or
// Gemini and never spend.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ fixtures modeled on live Sandbox data
type Ev = any;
function cryptoEvent(
  sym: string,
  name: string,
  o: { ticker?: string; index?: string; event?: Ev; contract?: Ev; rulesSymbol?: string } = {},
): Ev {
  const ticker = o.ticker ?? `${sym}2611202300`;
  const index = o.index ?? `LS-LRRR-${sym}USD`;
  const contract = {
    instrumentSymbol: `GEMI-${ticker}-HI100`,
    ticker: "HI100",
    label: "$100 or above",
    strike: { type: "above", value: "100" },
    source: index,
    expiryDate: "2026-11-21T04:00:00.000Z",
    prices: { buy: { yes: "0.60", no: "0.42" }, sell: { yes: "0.58", no: "0.40" } },
    description: {
      nodeType: "document",
      content: [
        {
          nodeType: "text",
          value: `If the price of ${name} (${o.rulesSymbol ?? sym}) is $100 or above on November 20, 2026 at 10pm ET, this market will resolve to Yes. Outcome verified against the ${index} index.`,
        },
      ],
    },
    ...o.contract,
  };
  return {
    ticker,
    title: `${sym} price today at 10pm EST`,
    category: "Crypto",
    series: `${sym}1H`,
    subcategory: { name, path: ["Crypto", name] },
    source: index,
    sourceDetails: { agency: "lukka", index },
    expiryDate: "2026-11-21T04:00:00.000Z",
    contracts: [contract],
    ...o.event,
  };
}
const EVENTS: Record<string, Ev> = {};
const add = (e: Ev) => ((EVENTS[e.ticker] = e), e);
const BTC = add(cryptoEvent("BTC", "Bitcoin", { index: "LS-LRRR-XBTUSD" }));
const ETH = add(cryptoEvent("ETH", "Ether"));
const SOL = add(cryptoEvent("SOL", "Solana", { index: "LS-LRRR-SOLNUSD" }));
const XRP = add(cryptoEvent("XRP", "XRP"));
const HYPE = add(cryptoEvent("HYPE", "Hyperliquid", { index: "LS-LRRR-HYPE22USD" }));
const ZEC = add(cryptoEvent("ZEC", "Zcash"));
const FOO = add(cryptoEvent("FOO", "Foocoin")); // unfamiliar cryptocurrency
const BTC5 = add(
  cryptoEvent("BTC", "Bitcoin", {
    ticker: "BTC05M2611202300",
    index: "LS-LRRR-XBTUSD",
    event: { series: "BTC5M" },
  }),
);
const SOLAR = add(cryptoEvent("SOL", "Solar Token", { ticker: "SOL2611202301" })); // same symbol, different coin
const CONFLICT = add(cryptoEvent("SOL", "Solana", { ticker: "SOL2611202302", rulesSymbol: "BTC" }));
const OIL = add(
  cryptoEvent("WTI", "Crude oil", {
    event: { category: "Commodities", subcategory: { name: "Oil", path: ["Commodities", "Oil"] } },
  }),
);
const sym = (e: Ev) => e.contracts[0].instrumentSymbol as string;

const KLINES = Array.from({ length: 61 }, (_, i) => [
  1795161120000 + i * 60_000,
  100 + i * 0.1,
  100.2 + i * 0.1,
  99.9 + i * 0.1,
  100 + i * 0.1,
  0,
]);

const tradeEngine = vi.hoisted(() => ({
  prepareTrade: vi.fn(),
  executeTrade: vi.fn(),
  isValidBuySize: vi.fn(),
  classifyExchangeOrder: vi.fn(),
  remainderBuy: vi.fn(),
}));
const gemini = vi.hoisted(() => ({
  gPrivate: vi.fn(),
  gPublic: vi.fn(),
  getEvent: vi.fn(),
  findContract: (ev: { contracts?: Array<{ instrumentSymbol: string }> } | null, s: string) =>
    ev?.contracts?.find((c) => c.instrumentSymbol === s) ?? null,
}));
vi.mock("../trade-engine", () => tradeEngine);
vi.mock("../gemini", () => gemini);

import { mintSessionToken } from "../browser-session";
import { evmReport, solanaReport, utxoReport, xrplReport } from "./aggregate";
import { identifyMarket } from "./asset";
import { researchConfig } from "./config";
import { spotFromKlines } from "./context";
import { APPROVAL_PHRASE, handleQuicknodeResearch } from "./handler";
import type { SdkClient, SdkFactory } from "./paid-request";
import { routeBody, ROUTES } from "./routes";
import type { Deps } from "./service";
import { memoryIO, researchStore } from "./store";

const SENDER = "0x1111111111111111111111111111111111111111";
const FAKE_KEY = ("0x" + "11".repeat(32)) as `0x${string}`; // test-only placeholder, not a real key
const ARC_ACCEPT = {
  scheme: "exact",
  network: "eip155:5042002",
  amount: "100",
  payTo: "0xF46394adDdA95A3d5bCC1124605E3d15D204623C",
  maxTimeoutSeconds: 604900,
  asset: "0x3600000000000000000000000000000000000000",
  extra: {
    name: "GatewayWalletBatched",
    version: "1",
    verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
};
const BASE_SEPOLIA = {
  ...ARC_ACCEPT,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const LISTED = [
  "btc-mainnet",
  "ethereum-mainnet",
  "solana-mainnet",
  "xrp-mainnet",
  "hype-mainnet",
  "ltc-mainnet",
  "doge-mainnet",
  "bch-mainnet",
  "bsc-mainnet",
  "matic-mainnet",
];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

const RESULTS: Record<string, unknown> = {
  solana: Array.from({ length: 120 }, (_, i) => ({
    slot: 1_000_000 - i * 150,
    numTransactions: 180_000,
    numNonVoteTransactions: i < 60 ? 60_000 : 75_000,
    numSlots: 150,
    samplePeriodSecs: 60,
  })),
  evm: {
    oldestBlock: "0x10",
    baseFeePerGas: Array.from({ length: 121 }, () => "0x3b9aca00"),
    gasUsedRatio: Array.from({ length: 120 }, (_, i) => (i < 60 ? 0.4 : 0.5)),
  },
  utxo: {
    loaded: true,
    size: 12_345,
    bytes: 6_500_000,
    usage: 1,
    total_fee: 0.5,
    mempoolminfee: 0.00001,
  },
  xrpl: {
    current_ledger_size: "40",
    current_queue_size: "2",
    expected_ledger_size: "80",
    drops: { base_fee: "10", median_fee: "5000", open_ledger_fee: "10" },
    status: "success",
  },
};
const routeOf = (url: string) =>
  ROUTES.find((r) => url === `https://x402.quicknode.com/${r.network}`)!;
const resultFor = (url: string) => {
  const route = routeOf(url);
  const result = RESULTS[route.family];
  return route.family === "xrpl"
    ? JSON.stringify({ result })
    : JSON.stringify({ jsonrpc: "2.0", id: 1, result });
};

function probe(
  kind: { status: number; accepts?: unknown[]; resourceUrl?: string } = { status: 402 },
) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    expect(init?.body).toBe(routeBody(routeOf(u))); // fixed body for that route only
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(new Headers(init?.headers).get("payment-signature")).toBeNull();
    if (kind.status === 402) {
      const doc = {
        x402Version: 2,
        resource: { url: kind.resourceUrl ?? u },
        accepts: kind.accepts ?? [BASE_SEPOLIA, ARC_ACCEPT],
      };
      return new Response(JSON.stringify(doc), {
        status: 402,
        headers: { "payment-required": b64(doc) },
      });
    }
    return new Response(kind.status === 200 ? resultFor(u) : "nope", { status: kind.status });
  });
}

type SdkOpts = {
  accepts?: unknown[];
  status?: number;
  body?: string;
  throwAfterSign?: boolean;
  paymentResponse?: boolean;
  delayMs?: number;
};
function mockSdk(o: SdkOpts = {}) {
  const calls = {
    fetch: 0,
    signed: 0,
    urls: [] as string[],
    configs: [] as unknown[],
    spend: [] as unknown[],
  };
  let available = 999_900n;
  const factory: SdkFactory = vi.fn(async (config) => {
    calls.configs.push({
      ...config,
      evmPrivateKey: config.evmPrivateKey === FAKE_KEY ? "<fake>" : "<other>",
    });
    const policies: Array<
      (v: number, r: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    > = [];
    const before: Array<
      (c: {
        selectedRequirements: Record<string, unknown>;
      }) => Promise<void | { abort: true; reason: string }>
    > = [];
    const after: Array<(c: unknown) => Promise<void>> = [];
    const client: SdkClient = {
      x402Client: {
        setSpendControls: (c) => calls.spend.push(c),
        registerPolicy: (p) => policies.push(p),
        onBeforePaymentCreation: (h) => before.push(h),
        onAfterPaymentCreation: (h) => after.push(h),
      },
      gatewayClient: { getBalances: async () => ({ gateway: { available } }) },
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.fetch++;
        const u = String(url);
        calls.urls.push(u);
        expect(init?.body).toBe(routeBody(routeOf(u)));
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        let reqs = (o.accepts ?? [BASE_SEPOLIA, ARC_ACCEPT]) as Array<Record<string, unknown>>;
        for (const p of policies) {
          reqs = p(2, reqs);
          if (!reqs.length)
            throw new Error("All payment requirements were filtered out by policies");
        }
        for (const h of before) {
          const r = await h({ selectedRequirements: reqs[0]! });
          if (r && r.abort) throw new Error("Payment creation aborted: " + r.reason);
        }
        for (const h of after) await h({});
        calls.signed++;
        available -= BigInt(String(reqs[0]!["amount"]));
        if (o.throwAfterSign) throw new Error("socket hang up");
        return new Response(o.body ?? resultFor(u), {
          status: o.status ?? 200,
          headers:
            o.paymentResponse === false
              ? {}
              : {
                  "payment-response": b64({
                    success: true,
                    network: "eip155:5042002",
                    payer: SENDER,
                    transaction: "gw-ref-123",
                    extensions: { "quicknode-session": { info: { token: "SECRET.JWT.TOKEN" } } },
                  }),
                },
        });
      }) as typeof fetch,
    };
    return client;
  });
  return { factory, calls };
}

const ENV_KEYS = [
  "VOICE_SESSION_SECRET",
  "QUICKNODE_RESEARCH_PAYMENTS",
  "QUICKNODE_RESEARCH_WALLET_ADDRESS",
  "QUICKNODE_RESEARCH_MAX_PER_REQUEST_ATOMIC",
  "QUICKNODE_RESEARCH_MAX_PER_SESSION_ATOMIC",
  "QUICKNODE_RESEARCH_MAX_PER_DAY_ATOMIC",
  "BLOB_READ_WRITE_TOKEN",
  "RESEARCH_WALLET_PRIVATE_KEY",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["VOICE_SESSION_SECRET"] = "s".repeat(40);
  process.env["QUICKNODE_RESEARCH_PAYMENTS"] = "true";
  process.env["QUICKNODE_RESEARCH_WALLET_ADDRESS"] = SENDER;
  gemini.getEvent.mockImplementation(async (t: string) => ({ event: EVENTS[t] ?? null }));
  gemini.gPublic.mockImplementation(async () => ({ ok: true, data: KLINES }));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function token(sid = crypto.randomUUID()) {
  const now = Date.now();
  return {
    sid,
    token: await mintSessionToken({ v: 1, sid, cid: null, iat: now, exp: now + 3600_000 }),
  };
}

type H = {
  sdk?: SdkOpts;
  probe?: Parameters<typeof probe>[0];
  durable?: boolean;
  wallet?: string | null;
  networks?: string[] | null;
  injectGemini?: boolean;
};
function harness(o: H = {}) {
  const store = researchStore(memoryIO({ durable: o.durable ?? true }));
  const sdk = mockSdk(o.sdk);
  const fetchImpl = probe(o.probe);
  const deps = (): Partial<Deps> => ({
    store,
    cfg: researchConfig(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sdk: sdk.factory,
    wallet: async () => (o.wallet === null ? null : { key: FAKE_KEY, address: o.wallet ?? SENDER }),
    networks: async () => (o.networks === undefined ? LISTED : o.networks),
    ...(o.injectGemini !== false && {
      market: async (t: string, s: string) => {
        const event = (EVENTS[t] ?? null) as any;
        return {
          event,
          contract: event?.contracts?.find((c: Ev) => c["instrumentSymbol"] === s) ?? null,
        };
      },
      klines: async () => KLINES,
    }),
  });
  const post = async (action: string, body: unknown, bearer?: string) => {
    const res = await handleQuicknodeResearch(
      new Request("https://app.test/api/public/quicknode-research/" + action, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer && { Authorization: "Bearer " + bearer }),
        },
        body: JSON.stringify(body),
      }),
      action,
      deps(),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const pick = (e: Ev, contract = sym(e)) => ({
    event_ticker: e.ticker as string,
    contract_symbol: contract,
  });
  const quote = (bearer: string, e: Ev = SOL, contract?: string) =>
    post("quote", pick(e, contract), bearer);
  const context = (e: Ev, contract?: string) => post("context", pick(e, contract));
  const approve = (
    bearer: string,
    q: Record<string, any>,
    key: string = crypto.randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    post(
      "approve",
      {
        quote_id: q["quote_id"],
        max_atomic: q["price_atomic"],
        confirm: APPROVAL_PHRASE,
        idempotency_key: key,
        ...extra,
      },
      bearer,
    );
  return { store, sdk, fetchImpl, post, quote, context, approve };
}

// ------------------------------------------------------------------ identification and routing
describe("market identification from Gemini metadata", () => {
  it.each([
    ["BTC", BTC, "Bitcoin", "btc-mainnet", "Bitcoin"],
    ["BTC 5-minute", BTC5, "Bitcoin", "btc-mainnet", "Bitcoin"],
    ["ETH", ETH, "Ether", "ethereum-mainnet", "Ethereum"],
    ["SOL", SOL, "Solana", "solana-mainnet", "Solana"],
    ["XRP", XRP, "XRP", "xrp-mainnet", "XRP Ledger"],
    ["HYPE", HYPE, "Hyperliquid", "hype-mainnet", "HyperEVM"],
  ])(
    "%s: identifies the asset and quotes its own chain only",
    async (_label, ev, name, network, chain) => {
      const h = harness();
      const q = await h.quote((await token()).token, ev);
      expect(q.status).toBe(200);
      expect(q.body["context"]["asset"]).toMatchObject({ symbol: ev.title.split(" ")[0], name });
      expect(q.body["context"]["asset"]["identified_from"].length).toBeGreaterThanOrEqual(2);
      expect(q.body["context"]["market"]).toMatchObject({
        event_ticker: ev.ticker,
        contract_symbol: sym(ev),
        strike: "100",
        strike_type: "above",
        settlement_index: ev.sourceDetails.index,
      });
      expect(q.body).toMatchObject({
        status: "quoted",
        quicknode_network: network,
        research_chain: chain,
        price_usdc: "0.0001",
      });
      expect(String(h.fetchImpl.mock.calls[0]![0])).toBe(`https://x402.quicknode.com/${network}`);
      expect(h.sdk.factory).not.toHaveBeenCalled();
    },
  );

  it("builds verified market context: prices, implied probability, index change, volatility, strike distance", async () => {
    const h = harness();
    const c = (await h.context(BTC)).body["context"];
    expect(c["implied_yes_pct"]).toBe(60);
    expect(c["spread"]).toBe(0.02);
    expect(c["market"]["prices"]).toEqual({
      yes_buy: 0.6,
      no_buy: 0.42,
      yes_sell: 0.58,
      no_sell: 0.4,
    });
    expect(c["spot"]).toMatchObject({
      last: 106,
      change_60m_pct: 6,
      minutes: 61,
      distance_to_strike_pct: -5.66,
    });
    expect(c["spot"]["source"]).toMatch(/settlement index lukka LS-LRRR-XBTUSD/);
    expect(c["spot"]["realized_vol_60m_pct"]).toBeGreaterThan(0);
  });

  it("an unfamiliar cryptocurrency is identified from metadata and gets context only, never a charge", async () => {
    const h = harness();
    const { token: t } = await token();
    const q = await h.quote(t, FOO);
    expect(q.body["context"]["asset"]).toMatchObject({ symbol: "FOO", name: "Foocoin" });
    expect(q.body).toMatchObject({
      status: "context_only",
      quote_id: "",
      price_atomic: "0",
      route_id: null,
    });
    expect(q.body["limitations"].join(" ")).toMatch(
      /No supported paid QuickNode x402 research source for Foocoin \(FOO\)/,
    );
    expect(q.body["say"]).toMatch(/Nothing was charged/);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect((await h.approve(t, q.body)).status).toBe(404);
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });

  it("a Gemini coin without a QuickNode network (ZEC) gets context only", async () => {
    const h = harness();
    const q = await h.quote((await token()).token, ZEC);
    expect(q.body).toMatchObject({ status: "context_only" });
    expect(q.body["context"]["spot"]).not.toBeNull();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("unsupported data providers: unlisted network, unavailable list, provider HTTP error", async () => {
    const t = (await token()).token;
    let h = harness({ networks: LISTED.filter((n) => n !== "btc-mainnet") });
    let q = await h.quote(t, BTC);
    expect(q.body["status"]).toBe("context_only");
    expect(q.body["limitations"].join(" ")).toMatch(/does not currently list btc-mainnet/);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h = harness({ networks: null });
    q = await h.quote(t, ETH);
    expect(q.body["limitations"].join(" ")).toMatch(/supported-network list is unavailable/);
    h = harness({ probe: { status: 404 } });
    q = await h.quote(t, SOL);
    expect(q.body["status"]).toBe("context_only");
    expect(q.body["limitations"].join(" ")).toMatch(/returned HTTP 404/);
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });

  it("never substitutes another coin's data: same symbol with a different name gets no paid route", async () => {
    const h = harness();
    const q = await h.quote((await token()).token, SOLAR);
    expect(q.body["status"]).toBe("context_only");
    expect(q.body["limitations"].join(" ")).toMatch(/does not match the Solana network/);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects mismatched contracts and conflicting asset metadata", async () => {
    const h = harness();
    const t = (await token()).token;
    expect((await h.quote(t, SOL, sym(BTC))).body["error"]).toBe("CONTRACT_MISMATCH"); // BTC contract under SOL event
    expect((await h.quote(t, SOL, "GEMI-SOL2611202300-NOPE")).body["error"]).toBe(
      "CONTRACT_MISMATCH",
    );
    expect((await h.quote(t, CONFLICT)).body["error"]).toBe("ASSET_CONFLICT"); // rules say BTC, title says SOL
    const wrongSource = { ...SOL, contracts: [{ ...SOL.contracts[0], source: "LS-LRRR-XBTUSD" }] };
    expect(() =>
      identifyMarket(wrongSource as any, wrongSource.contracts[0], SOL.ticker, sym(SOL)),
    ).toThrow(/different index/);
    expect((await h.quote(t, OIL)).body["error"]).toBe("NOT_CRYPTO");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses arbitrary URLs, methods and RPC bodies on context and quote", async () => {
    const h = harness();
    const { token: t } = await token();
    for (const extra of [
      { url: "https://evil.example" },
      { method: "sendTransaction" },
      { body: "{}" },
      { network: "zcash-mainnet" },
    ]) {
      expect(
        (
          await h.post(
            "quote",
            { event_ticker: SOL.ticker, contract_symbol: sym(SOL), ...extra },
            t,
          )
        ).status,
      ).toBe(400);
      expect(
        (await h.post("context", { event_ticker: SOL.ticker, contract_symbol: sym(SOL), ...extra }))
          .status,
      ).toBe(400);
    }
  });
});

// ------------------------------------------------------------------ quote validation
describe("quote validation", () => {
  it("requires a server-signed session for quotes (context is public and free)", async () => {
    const h = harness();
    expect((await h.quote("")).status).toBe(401);
    expect((await h.quote("forged.token")).status).toBe(401);
    const c = await h.context(SOL);
    expect(c.body).toMatchObject({ status: "context_only", route_id: "sol" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a 402 for a different resource", async () => {
    const h = harness({
      probe: { status: 402, resourceUrl: "https://x402.quicknode.com/zcash-mainnet" },
    });
    expect((await h.quote((await token()).token, ETH)).body["error"]).toBe("WRONG_RESOURCE");
  });

  it("refuses wrong network, wrong token, unexpected payee, verifier and over-cap prices", async () => {
    const cases: Array<[unknown[], string]> = [
      [[BASE_SEPOLIA], "WRONG_NETWORK"],
      [[{ ...ARC_ACCEPT, network: "eip155:5042" }], "WRONG_NETWORK"],
      [[{ ...ARC_ACCEPT, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }], "WRONG_TOKEN"],
      [
        [{ ...ARC_ACCEPT, payTo: "0x000000000000000000000000000000000000dEaD" }],
        "UNEXPECTED_PAYEE",
      ],
      [
        [
          {
            ...ARC_ACCEPT,
            extra: {
              ...ARC_ACCEPT.extra,
              verifyingContract: "0x000000000000000000000000000000000000dEaD",
            },
          },
        ],
        "UNEXPECTED_VERIFIER",
      ],
      [[{ ...ARC_ACCEPT, amount: "10001" }], "OVER_CAP"],
    ];
    for (const [accepts, code] of cases) {
      const h = harness({ probe: { status: 402, accepts } });
      const r = await h.quote((await token()).token, BTC);
      expect(r.status, code).toBe(422);
      expect(r.body["error"]).toBe(code);
    }
  });

  it("env can lower but never raise the per-request cap", async () => {
    process.env["QUICKNODE_RESEARCH_MAX_PER_REQUEST_ATOMIC"] = "99999999";
    expect(researchConfig().maxPerRequest).toBe(10_000n);
    process.env["QUICKNODE_RESEARCH_MAX_PER_REQUEST_ATOMIC"] = "50";
    expect((await harness().quote((await token()).token)).body["error"]).toBe("OVER_CAP");
  });

  it("shows a free response as free and never charges", async () => {
    const h = harness({ probe: { status: 200 } });
    const { token: t } = await token();
    const q = await h.quote(t, ETH);
    expect(q.body).toMatchObject({ status: "free", price_atomic: "0" });
    expect(q.body["report"]["comparison"]["change_pct"]).toBe(25);
    expect((await h.approve(t, q.body)).status).toBe(409);
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ approve
describe("approve", () => {
  it.each([
    [
      "SOL",
      SOL,
      "solana-mainnet",
      (r: any) =>
        expect(r.comparison).toMatchObject({ recent: 1000, previous: 1250, change_pct: -20 }),
    ],
    [
      "ETH",
      ETH,
      "ethereum-mainnet",
      (r: any) =>
        expect(r.comparison).toMatchObject({ recent: 50, previous: 40, change_pct: 25, unit: "%" }),
    ],
    [
      "BTC",
      BTC,
      "btc-mainnet",
      (r: any) =>
        expect(r.metrics[0]).toMatchObject({ label: "Pending transactions", value: 12345 }),
    ],
    [
      "XRP",
      XRP,
      "xrp-mainnet",
      (r: any) => expect(r.metrics[1]).toMatchObject({ value: 50, unit: "%" }),
    ],
    ["HYPE", HYPE, "hype-mainnet", (r: any) => expect(r.warnings.join(" ")).toMatch(/HyperCore/)],
  ])(
    "%s: pays once on the quote's own route with the proven SDK flow",
    async (label, ev, network, check) => {
      const h = harness();
      const { token: t } = await token();
      const a = await h.approve(t, (await h.quote(t, ev)).body);
      expect(a.status).toBe(200);
      expect(a.body["status"]).toBe("paid");
      expect(h.sdk.calls.urls).toEqual([`https://x402.quicknode.com/${network}`]);
      expect(h.sdk.calls.configs).toEqual([
        {
          baseUrl: "https://x402.quicknode.com",
          network: "eip155:5042002",
          evmPrivateKey: "<fake>",
          paymentModel: "nanopayment",
        },
      ]);
      expect(h.sdk.calls.spend).toEqual([
        {
          allowedAssets: [
            {
              network: "eip155:5042002",
              asset: "0x3600000000000000000000000000000000000000",
              maxAmountPerPayment: "100",
            },
          ],
        },
      ]);
      check(a.body["report"]);
      expect(a.body["context"]["asset"]["symbol"]).toBe(label);
      expect(a.body["evidence"]).toMatchObject({
        signed: true,
        http_status: 200,
        payment_response_present: true,
        gateway_deduction_atomic: "100",
      });
      expect(a.body["evidence"]["payment_response"]).toMatchObject({
        success: true,
        provider_reference: "gw-ref-123",
      });
      const text = JSON.stringify(a.body);
      expect(text).not.toContain("SECRET.JWT.TOKEN");
      expect(text).not.toContain("11".repeat(32));
      expect(a.body["say"]).toMatch(/not a price signal/);
    },
  );

  it("rejects an expired quote without touching the SDK", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    const { token: t } = await token();
    const q = await h.quote(t);
    vi.setSystemTime(Date.now() + 4 * 60 * 1000 + 1);
    const a = await h.approve(t, q.body);
    expect(a.status).toBe(410);
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });

  it("unauthorized payments: no session, other session, no phrase, wrong amount, context-only result", async () => {
    const h = harness();
    const owner = await token();
    const other = await token();
    const q = await h.quote(owner.token, BTC);
    expect((await h.approve("", q.body)).status).toBe(401);
    expect((await h.approve("forged.token", q.body)).status).toBe(401);
    expect((await h.approve(other.token, q.body)).body["error"]).toBe("NOT_FOUND");
    expect((await h.approve(owner.token, q.body, undefined, { confirm: "yes" })).status).toBe(400);
    expect(
      (
        await h.post(
          "approve",
          {
            quote_id: q.body["quote_id"],
            max_atomic: "200",
            confirm: APPROVAL_PHRASE,
            idempotency_key: crypto.randomUUID(),
          },
          owner.token,
        )
      ).body["error"],
    ).toBe("PRICE_MISMATCH");
    const ctx = await h.context(BTC);
    expect((await h.approve(owner.token, ctx.body)).status).toBe(404);
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });

  it("fails closed without durable storage, wallet, matching sender or the payments switch", async () => {
    const { token: t } = await token();
    let h = harness({ durable: false });
    expect((await h.approve(t, (await h.quote(t)).body)).body["error"]).toBe("STORAGE_UNAVAILABLE");
    h = harness({ wallet: null });
    expect((await h.approve(t, (await h.quote(t)).body)).body["error"]).toBe(
      "WALLET_NOT_CONFIGURED",
    );
    h = harness({ wallet: "0x2222222222222222222222222222222222222222" });
    expect((await h.approve(t, (await h.quote(t)).body)).body["error"]).toBe("WALLET_MISMATCH");
    process.env["QUICKNODE_RESEARCH_PAYMENTS"] = "false";
    h = harness();
    expect((await h.approve(t, (await h.quote(t)).body)).body["error"]).toBe("PAYMENTS_DISABLED");
    expect(h.sdk.factory).not.toHaveBeenCalled();
  });

  it("concurrent approvals of one quote send at most one paid request", async () => {
    const h = harness({ sdk: { delayMs: 20 } });
    const { token: t } = await token();
    const q = await h.quote(t, ETH);
    const same = crypto.randomUUID();
    const results = await Promise.all([
      h.approve(t, q.body, same),
      h.approve(t, q.body, same),
      h.approve(t, q.body),
      h.approve(t, q.body),
    ]);
    expect(h.sdk.calls.fetch).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(2);
    expect(results.filter((r) => r.status === 200).length).toBe(2);
  });

  it("an ambiguous payment becomes unknown_pending, is never resent, and still holds budget", async () => {
    const h = harness({ sdk: { throwAfterSign: true } });
    const { token: t } = await token();
    const q = await h.quote(t, BTC);
    const key = crypto.randomUUID();
    expect((await h.approve(t, q.body, key)).body["status"]).toBe("unknown_pending");
    expect((await h.approve(t, q.body, key)).body["status"]).toBe("unknown_pending");
    expect((await h.approve(t, q.body)).status).toBe(409);
    expect(h.sdk.calls.fetch).toBe(1);
    process.env["QUICKNODE_RESEARCH_MAX_PER_SESSION_ATOMIC"] = "100";
    expect((await h.approve(t, (await h.quote(t, ETH)).body)).body["error"]).toBe("SESSION_CAP");
  });

  it("refuses at signing time if the fresh 402 differs from the quote, and releases the budget", async () => {
    const h = harness({ sdk: { accepts: [{ ...ARC_ACCEPT, amount: "200" }] } });
    const { token: t } = await token();
    const a = await h.approve(t, (await h.quote(t)).body);
    expect(a.body["status"]).toBe("failed");
    expect(a.body["evidence"]["signed"]).toBe(false);
    expect(h.sdk.calls.signed).toBe(0);
  });

  it("enforces per-session and per-UTC-day budgets across assets", async () => {
    process.env["QUICKNODE_RESEARCH_MAX_PER_SESSION_ATOMIC"] = "200";
    process.env["QUICKNODE_RESEARCH_MAX_PER_DAY_ATOMIC"] = "300";
    const h = harness();
    const s1 = await token();
    expect((await h.approve(s1.token, (await h.quote(s1.token, BTC)).body)).body["status"]).toBe(
      "paid",
    );
    expect((await h.approve(s1.token, (await h.quote(s1.token, ETH)).body)).body["status"]).toBe(
      "paid",
    );
    expect((await h.approve(s1.token, (await h.quote(s1.token, SOL)).body)).body["error"]).toBe(
      "SESSION_CAP",
    );
    const s2 = await token();
    expect((await h.approve(s2.token, (await h.quote(s2.token, XRP)).body)).body["status"]).toBe(
      "paid",
    );
    expect((await h.approve(s2.token, (await h.quote(s2.token, HYPE)).body)).body["error"]).toBe(
      "DAILY_CAP",
    );
    expect(h.sdk.calls.fetch).toBe(3);
  });

  it("records paid-but-JSON-RPC-error honestly", async () => {
    const h = harness({
      sdk: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32005, message: "rate limited" },
        }),
      },
    });
    const { token: t } = await token();
    const a = await h.approve(t, (await h.quote(t, ETH)).body);
    expect(a.body["status"]).toBe("paid");
    expect(a.body["report"]).toBeNull();
    expect(a.body["error"]).toMatch(/-32005/);
  });

  it("a non-200 after signing is unknown_pending, never success", async () => {
    const h = harness({ sdk: { status: 502, paymentResponse: false } });
    const { token: t } = await token();
    expect((await h.approve(t, (await h.quote(t)).body)).body["status"]).toBe("unknown_pending");
  });

  it("research approval never invokes Gemini execution or the trade engine (default read-only Gemini path)", async () => {
    const h = harness({ injectGemini: false });
    const { token: t } = await token();
    const a = await h.approve(t, (await h.quote(t, BTC)).body);
    expect(a.body["status"]).toBe("paid");
    expect(gemini.getEvent).toHaveBeenCalledWith(BTC.ticker);
    expect(gemini.gPublic).toHaveBeenCalledWith(
      "/v2/klines",
      expect.objectContaining({ agency: "lukka", index: "LS-LRRR-XBTUSD" }),
    );
    expect(gemini.gPrivate).not.toHaveBeenCalled();
    for (const fn of Object.values(tradeEngine)) expect(fn).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ reports
describe("reports", () => {
  const at = new Date("2026-11-20T08:00:00Z");
  it("solana: weights by actual sample period, sorts newest-first and dedupes", () => {
    const mk = (i: number, nv: number, p: number) => ({
      slot: 1_000_000 - i * 150,
      numTransactions: nv * 3,
      numNonVoteTransactions: nv,
      numSlots: 150,
      samplePeriodSecs: p,
    });
    const recent = Array.from({ length: 60 }, (_, i) => mk(i, 60_000, 60));
    // Mixed periods: 30 x (30s, 15k) + 30 x (90s, 135k) = 4.5M / 3600s = 1250 TPS.
    const previous = Array.from({ length: 60 }, (_, i) =>
      i % 2 ? mk(60 + i, 135_000, 90) : mk(60 + i, 15_000, 30),
    );
    const r = solanaReport([...previous, recent[5]!, ...recent].reverse(), at);
    expect(r.comparison).toMatchObject({
      recent: 1000,
      previous: 1250,
      change_pct: -20,
      direction: "lower",
    });
    expect(r.warnings.join(" ")).toMatch(/Duplicate/);
    expect(r.disclaimer).toMatch(/does not predict price direction/);
  });
  it("guards empty, malformed and zero data for every family", () => {
    for (const input of [[], null, "x", [{ slot: 1 }], {}]) {
      expect(solanaReport(input, at).comparison).toBeNull();
      expect(evmReport(input, at, "Ethereum").comparison).toBeNull();
      expect(utxoReport(input, at, "Bitcoin").metrics[0]!.value).toBeNull();
      expect(xrplReport(input, at, "XRP Ledger").metrics[0]!.value).toBeNull();
    }
    const zeros = solanaReport(
      Array.from({ length: 120 }, (_, i) => ({
        slot: 1e6 - i,
        numTransactions: 10,
        numNonVoteTransactions: i < 60 ? 10 : 0,
        numSlots: 1,
        samplePeriodSecs: 60,
      })),
      at,
    );
    expect(zeros.comparison?.change_pct).toBeNull();
    const evm = evmReport(
      { gasUsedRatio: Array(20).fill(0), baseFeePerGas: Array(21).fill("0x0") },
      at,
      "Ethereum",
    );
    expect(evm.comparison?.change_pct).toBeNull();
  });
  it("spot context guards bad klines", () => {
    expect(spotFromKlines(null, "100", "x")).toBeNull();
    expect(spotFromKlines([[1, 0, 0, 0, 0]], "100", "x")).toBeNull();
    expect(spotFromKlines(KLINES, null, "x")?.distance_to_strike_pct).toBeNull();
  });
});

// ------------------------------------------------------------------ containment
describe("containment", () => {
  const root = path.resolve(__dirname, "../../../..");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)],
    );
  const research = walk(__dirname).filter((f) => !f.endsWith(".test.ts"));
  it("research server modules never import trading or order code", () => {
    for (const f of research)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /trade-engine|browser-trading|blob-ledger|agent-tools|gPrivate|executeTrade|prepareTrade/,
      );
  });
  it("the wallet key env is read only in wallet.ts, and the SDK never enters browser modules", () => {
    const all = walk(path.join(root, "src")).filter(
      (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"),
    );
    const keyReaders = all.filter((f) =>
      readFileSync(f, "utf8").includes("RESEARCH_WALLET_PRIVATE_KEY"),
    );
    expect(keyReaders.map((f) => path.relative(root, f))).toEqual([
      "src/server/v2p/quicknode-research/wallet.ts",
    ]);
    const browser = all.filter(
      (f) => !f.includes(path.join("src", "server")) && !f.endsWith("$action.ts"),
    );
    for (const f of browser)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /@quicknode\/x402|quicknode-research\/(wallet|paid-request|service|store)/,
      );
  });
  it("no voice tool can approve or spend", () => {
    const tools = JSON.parse(
      readFileSync(path.join(root, "agent/browser-client-tools.json"), "utf8"),
    ).tools.map((t: { name: string }) => t.name);
    expect(tools.filter((n: string) => /research/.test(n)).sort()).toEqual([
      "get_research_result",
      "request_research_quote",
    ]);
    const client = readFileSync(path.join(root, "src/quicknodeResearch.ts"), "utf8");
    const toolBlock = client.slice(
      client.indexOf("tools(current"),
      client.indexOf("private async refresh"),
    );
    expect(toolBlock).not.toMatch(/"approve"|call\("approve"/);
  });
});
