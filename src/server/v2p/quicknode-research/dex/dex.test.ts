// @vitest-environment node
// Pure decoder/aggregation tests for DEX buy vs sell research. No network, no payments.
import { describe, expect, it, vi } from "vitest";
import { researchConfig } from "../config";
import { runPaidSession, type SdkFactory } from "../paid-request";
import { bodyAllowed, DEX_MARKETS, runDex } from ".";
import { buildReport } from "./report";
import { makeRpc, RpcFailure } from "./rpc";
import { decodeSolanaTx, SOL_POOL } from "./solana";
import {
  BTC_MARKET,
  decodeSwapLog,
  ETH_MARKET,
  evmAllowed,
  evmMaxCalls,
  SWAP_TOPIC,
} from "./uniswap";
import { aggregate, int256, timeframeForSeries, units, type SwapLeg } from "./volume";
import { decodeXrplEntry, RIPPLE_EPOCH, XRPL_AMM } from "./xrpl";

const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const data = (a0: bigint, a1: bigint) =>
  "0x" + word(a0) + word(a1) + word(1n) + word(1n) + word(0n);
const log = (address: string, a0: bigint, a1: bigint, o: Record<string, unknown> = {}) => ({
  address,
  topics: [SWAP_TOPIC],
  data: data(a0, a1),
  blockNumber: "0x10",
  transactionHash: "0x" + "aa".repeat(32),
  logIndex: "0x1",
  removed: false,
  ...o,
});
const ethPools = new Map(ETH_MARKET.pools.map((p) => [p.address, p]));
const btcPools = new Map(BTC_MARKET.pools.map((p) => [p.address, p]));
const at = () => 1_000;
const USDC_WETH = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"; // token0 USDC(6) token1 WETH(18)
const WETH_USDT = "0x11b815efb8f581194ae79006d24e0d814b7697f6"; // token0 WETH(18) token1 USDT(6)
const WBTC_USDC = "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35"; // token0 WBTC(8) token1 USDC(6)

describe("exact integer decoding", () => {
  it("decodes two's-complement int256 and token decimals exactly", () => {
    expect(int256(word(-1n))).toBe(-1n);
    expect(int256(word(-(10n ** 18n)))).toBe(-(10n ** 18n));
    expect(int256(word((1n << 255n) - 1n))).toBe((1n << 255n) - 1n);
    expect(units(1_234_567n, 6)).toBe(1.234567);
    expect(units(-(15n * 10n ** 17n), 18)).toBe(-1.5);
    expect(units(12_345_678n, 8)).toBe(0.12345678);
  });
});

describe("Uniswap V3 swap direction, decimals and USD", () => {
  it("token1 = WETH: pool sends WETH and receives USDC → trader BUY", () => {
    const l = decodeSwapLog(log(USDC_WETH, 3_100_250_000n, -(10n ** 18n)), ethPools, at)!;
    expect(l).toMatchObject({ asset: 1, usd: 3100.25 });
  });
  it("token0 = WETH: pool receives WETH and sends USDT → trader SELL", () => {
    const l = decodeSwapLog(log(WETH_USDT, 2n * 10n ** 18n, -6_000_000_000n), ethPools, at)!;
    expect(l).toMatchObject({ asset: -2, usd: 6000 });
  });
  it("WBTC uses 8 decimals: 0.5 WBTC into the pool for 45,000 USDC is a SELL", () => {
    const l = decodeSwapLog(log(WBTC_USDC, 50_000_000n, -45_000_000_000n), btcPools, at)!;
    expect(l).toMatchObject({ asset: -0.5, usd: 45000 });
  });
  it("ignores unsupported pools, other events, removed logs and one-sided amounts", () => {
    expect(decodeSwapLog(log("0x" + "12".repeat(20), 1n, -1n), ethPools, at)).toBeNull();
    expect(decodeSwapLog(log(WBTC_USDC, 1n, -1n), ethPools, at)).toBeNull(); // BTC pool in ETH set
    expect(
      decodeSwapLog(log(USDC_WETH, 1n, -1n, { topics: ["0x" + "0".repeat(64)] }), ethPools, at),
    ).toBeNull();
    expect(decodeSwapLog(log(USDC_WETH, 1n, -1n, { removed: true }), ethPools, at)).toBeNull();
    expect(decodeSwapLog(log(USDC_WETH, 5n, 5n), ethPools, at)).toBeNull(); // both into pool: not a swap
    expect(decodeSwapLog(log(USDC_WETH, 0n, -5n), ethPools, at)).toBeNull();
    expect(decodeSwapLog(log(USDC_WETH, 1n, -1n, { data: "0x1234" }), ethPools, at)).toBeNull();
  });
});

describe("aggregation from the asset's perspective", () => {
  const leg = (tx: string, asset: number, usd: number, time = 100, l = "0"): SwapLeg => ({
    tx,
    leg: l,
    time,
    asset,
    usd,
    pool: "p",
  });
  it("returns exactly bought, sold, net buy and buy share", () => {
    const t = aggregate([leg("a", 1, 3000), leg("b", -0.5, 1000), leg("c", 2, 6000)], 0, 1000);
    expect(t).toMatchObject({
      buy_usd: 9000,
      sell_usd: 1000,
      net_buy_usd: 8000,
      buy_pct: 90,
      trade_count: 3,
    });
  });
  it("filters to the time window (inclusive) and drops duplicate legs", () => {
    const t = aggregate(
      [
        leg("a", 1, 100, 99),
        leg("b", 1, 200, 100),
        leg("b", 1, 200, 100),
        leg("c", -1, 50, 200),
        leg("d", -1, 70, 201),
      ],
      100,
      200,
    );
    expect(t).toMatchObject({ buy_usd: 200, sell_usd: 50, trade_count: 2 });
  });
  it("nets router hops and round trips per transaction so they are not counted twice", () => {
    // USDT → WETH → USDC through two monitored pools: buy leg + sell leg in one tx.
    const hop = aggregate([leg("x", 1, 3000, 100, "1"), leg("x", -1, 3000.5, 100, "2")], 0, 1000);
    expect(hop).toMatchObject({ buy_usd: 0, sell_usd: 0, trade_count: 0, passthrough_count: 1 });
    const exact = aggregate([leg("y", 1, 3000, 100, "1"), leg("y", -1, 3000, 100, "2")], 0, 1000);
    expect(exact).toMatchObject({
      buy_usd: 0,
      sell_usd: 0,
      trade_count: 0,
      passthrough_count: 1,
      buy_pct: null,
    });
    // Direction must follow net ETH received/paid. A 50-cent arbitrage spread doesn't
    // magically turn a zero-net-ETH round trip into selling pressure.
    expect(aggregate([leg("arb", 0.5, 1000, 100, "1"), leg("arb", -1, 2000, 100, "2")], 0, 1000))
      .toMatchObject({ buy_usd: 0, sell_usd: 1000, trade_count: 1 });
    // Contradictory net asset and quote movement is not a plain directional trade.
    expect(aggregate([leg("complex", 1, 1000, 100, "1"), leg("complex", -0.9, 2000, 100, "2")], 0, 1000))
      .toMatchObject({ buy_usd: 0, sell_usd: 0, inconsistent_count: 1 });
    // Two buys in one tx are one trade of the summed size.
    expect(
      aggregate([leg("z", 1, 10, 100, "1"), leg("z", 2, 20, 100, "2")], 0, 1000),
    ).toMatchObject({ buy_usd: 30, trade_count: 1 });
  });
  it("ignores zero, negative and non-finite legs", () => {
    const t = aggregate(
      [leg("a", 0, 5), leg("b", 1, 0), leg("c", 1, Number.NaN), leg("d", 1, -5)],
      0,
      1000,
    );
    expect(t.trade_count).toBe(0);
  });
});

describe("Solana Orca Whirlpool vault decoding", () => {
  const bal = (idx: number, mint: string, amount: bigint, decimals: number) => ({
    accountIndex: idx,
    mint,
    uiTokenAmount: { amount: amount.toString(), decimals },
  });
  const tx = (sol: [bigint, bigint], usd: [bigint, bigint], o: Record<string, unknown> = {}) => ({
    blockTime: 500,
    meta: {
      err: null,
      preTokenBalances: [
        bal(1, SOL_POOL.assetMint, sol[0], 9),
        bal(2, SOL_POOL.stableMint, usd[0], 6),
      ],
      postTokenBalances: [
        bal(1, SOL_POOL.assetMint, sol[1], 9),
        bal(2, SOL_POOL.stableMint, usd[1], 6),
      ],
      loadedAddresses: { writable: [] as string[], readonly: [] as string[] },
      ...o,
    },
    transaction: { message: { accountKeys: ["Payer", SOL_POOL.assetVault, SOL_POOL.stableVault] } },
  });
  it("vault SOL down and USDT up is a BUY; SOL up and USDT down is a SELL (9 and 6 decimals)", () => {
    expect(
      decodeSolanaTx("s", tx([10_000_000_000n, 7_500_000_000n], [0n, 375_120_000n])),
    ).toMatchObject({ asset: 2.5, usd: 375.12 });
    expect(
      decodeSolanaTx("s", tx([0n, 1_000_000_000n], [200_000_000n, 50_000_000n])),
    ).toMatchObject({ asset: -1, usd: 150 });
  });
  it("liquidity adds/removes, failed txs and untouched vaults are not swaps", () => {
    expect(decodeSolanaTx("s", tx([1n, 2n], [1n, 2n]))).toBeNull(); // both up: liquidity add
    expect(decodeSolanaTx("s", tx([2n, 1n], [2n, 1n]))).toBeNull(); // both down: removal
    expect(decodeSolanaTx("s", tx([2n, 1n], [2n, 2n]))).toBeNull(); // one side only (fees)
    expect(
      decodeSolanaTx("s", tx([2n, 1n], [1n, 2n], { err: { InstructionError: [0, "x"] } })),
    ).toBeNull();
    expect(decodeSolanaTx("s", null)).toBeNull();
  });
  it("matches vaults by address (including lookup-table addresses) and mint, not by owner alone", () => {
    const viaAlt = {
      ...tx([10n ** 9n, 0n], [0n, 100_000_000n]),
      transaction: { message: { accountKeys: ["Payer"] } },
    };
    viaAlt.meta.loadedAddresses = {
      writable: [SOL_POOL.assetVault, SOL_POOL.stableVault],
      readonly: [],
    };
    expect(decodeSolanaTx("s", viaAlt)).toMatchObject({ asset: 1, usd: 100 });
    const wrongMint = tx([10n ** 9n, 0n], [0n, 1n]);
    wrongMint.meta.postTokenBalances[1]!.mint = "OtherMint1111111111111111111111111111111111";
    expect(decodeSolanaTx("s", wrongMint)).toBeNull();
  });
});

describe("XRP Ledger AMM metadata decoding", () => {
  const entry = (
    dropsBefore: string,
    dropsAfter: string,
    rlBefore: string,
    rlAfter: string,
    o: Record<string, unknown> = {},
  ) => ({
    validated: true,
    hash: "ab".repeat(32),
    tx_json: { date: 1000 },
    meta: {
      TransactionResult: "tesSUCCESS",
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: "AccountRoot",
            FinalFields: { Account: XRPL_AMM.account, Balance: dropsAfter },
            PreviousFields: { Balance: dropsBefore },
          },
        },
        {
          ModifiedNode: {
            LedgerEntryType: "RippleState",
            FinalFields: {
              Balance: { currency: XRPL_AMM.currency, value: rlAfter },
              HighLimit: { currency: XRPL_AMM.currency, issuer: XRPL_AMM.issuer },
              LowLimit: { currency: XRPL_AMM.currency, issuer: XRPL_AMM.account },
            },
            PreviousFields: { Balance: { currency: XRPL_AMM.currency, value: rlBefore } },
          },
        },
        // An open offer being placed is never counted.
        {
          CreatedNode: {
            LedgerEntryType: "Offer",
            NewFields: { TakerPays: "1000", TakerGets: { value: "1" } },
          },
        },
      ],
      ...o,
    },
  });
  it("AMM XRP out + RLUSD in is a BUY; XRP in + RLUSD out is a SELL; ripple-epoch time", () => {
    expect(decodeXrplEntry(entry("2000000000", "1900000000", "1000", "1048.5"))).toMatchObject({
      asset: 100,
      usd: 48.5,
      time: 1000 + RIPPLE_EPOCH,
      tx: "AB".repeat(32),
    });
    expect(decodeXrplEntry(entry("1000000", "3500000", "10", "7.6"))).toMatchObject({
      asset: -2.5,
    });
    expect(decodeXrplEntry(entry("1000000", "3500000", "10", "7.6"))!.usd).toBeCloseTo(2.4, 9);
  });
  it("handles the AMM as the HIGH side of the trust line (balance sign flips)", () => {
    const e = entry("2000000", "1000000", "-10", "-12");
    const rs = (
      e.meta.AffectedNodes[1] as {
        ModifiedNode: {
          FinalFields: { HighLimit: { issuer: string }; LowLimit: { issuer: string } };
        };
      }
    ).ModifiedNode.FinalFields;
    rs.HighLimit.issuer = XRPL_AMM.account;
    rs.LowLimit.issuer = XRPL_AMM.issuer;
    expect(decodeXrplEntry(e)).toMatchObject({ asset: 1, usd: 2 });
  });
  it("deposits, withdrawals, failures and unvalidated transactions are ignored", () => {
    expect(decodeXrplEntry(entry("1000000", "2000000", "10", "20"))).toBeNull(); // deposit
    expect(decodeXrplEntry(entry("2000000", "1000000", "20", "10"))).toBeNull(); // withdrawal
    expect(
      decodeXrplEntry(
        entry("2000000", "1000000", "10", "20", { TransactionResult: "tecPATH_DRY" }),
      ),
    ).toBeNull();
    expect(
      decodeXrplEntry({ ...entry("2000000", "1000000", "10", "20"), validated: false }),
    ).toBeNull();
  });
});

describe("reports never present incomplete totals as complete", () => {
  const base = {
    asset: "ETH",
    assetNote: null,
    chain: "Ethereum",
    source: "s",
    method: "m",
    timeframe: "1h" as const,
    poolTxCount: null,
    pools: [{ dex: "Uniswap v3", pair: "WETH/USDC", address: "0x", url: "u" }],
    coverage: "c",
    txUrl: (h: string) => h,
    callsUsed: 3,
    warnings: [],
    observedAt: new Date(0),
  };
  const legs: SwapLeg[] = [{ tx: "a", leg: "0", time: 3500, asset: 1, usd: 10, pool: "p" }];
  it("labels a short measured span as partial even if every call succeeded", () => {
    const r = buildReport({ ...base, window: { from: 2000, to: 3600 }, complete: true, legs });
    expect(r.completeness).toBe("partial");
    expect(r.headline).toMatch(/partial; 1 hour requested/);
  });
  it("labels missing data as unavailable with null totals", () => {
    const r = buildReport({ ...base, window: null, complete: false, legs });
    expect(r).toMatchObject({
      completeness: "unavailable",
      buy_usd: null,
      sell_usd: null,
      net_buy_usd: null,
      buy_pct: null,
    });
  });
  it("complete only when the whole window was fetched", () => {
    const r = buildReport({ ...base, window: { from: 0, to: 3600 }, complete: true, legs });
    expect(r).toMatchObject({ completeness: "complete", buy_usd: 10, trade_count: 1 });
    expect(r.headline).toMatch(/1 trade;?|across 1 trade\./);
    expect(r.disclaimer).toMatch(/not a price forecast/);
  });
});

describe("timeframes", () => {
  it("defaults to the Gemini prediction's duration", () => {
    expect(timeframeForSeries("BTC05M")).toBe("5m");
    expect(timeframeForSeries("ETH15M")).toBe("15m");
    expect(timeframeForSeries("SOL1H")).toBe("1h");
    expect(timeframeForSeries("XRP")).toBe("24h");
    expect(timeframeForSeries(null, "BTC05M2611201040")).toBe("5m");
  });
  it("estimates paid calls exactly per asset and timeframe, all under the 0.01 USDC cap", () => {
    expect(["5m", "15m", "1h", "24h"].map((t) => DEX_MARKETS.eth.maxCalls(t as "5m"))).toEqual([
      3, 3, 4, 27,
    ]);
    expect(["5m", "15m", "1h", "24h"].map((t) => DEX_MARKETS.btc.maxCalls(t as "5m"))).toEqual([
      3, 3, 3, 7,
    ]);
    expect(["5m", "15m", "1h", "24h"].map((t) => DEX_MARKETS.sol.maxCalls(t as "5m"))).toEqual([
      76, 76, 77, 78,
    ]);
    expect(["5m", "15m", "1h", "24h"].map((t) => DEX_MARKETS.xrp.maxCalls(t as "5m"))).toEqual([
      1, 1, 2, 10,
    ]);
    for (const m of Object.values(DEX_MARKETS))
      for (const t of ["5m", "15m", "1h", "24h"] as const)
        expect(m.maxCalls(t) * 100).toBeLessThanOrEqual(10_000);
    expect(evmMaxCalls(ETH_MARKET, "24h")).toBe(27);
  });
});

describe("allowlist and call budget", () => {
  it("allows only the fixed methods, pools and ranges", () => {
    const ok = evmAllowed(ETH_MARKET);
    const addrs = ETH_MARKET.pools.map((p) => p.address);
    expect(
      ok("eth_getLogs", [
        { fromBlock: "0x1", toBlock: "0x12c", address: addrs, topics: [SWAP_TOPIC] },
      ]),
    ).toBe(true);
    expect(
      ok("eth_getLogs", [
        { fromBlock: "0x1", toBlock: "0x12d", address: addrs, topics: [SWAP_TOPIC] },
      ]),
    ).toBe(false); // > chunk
    expect(
      ok("eth_getLogs", [
        {
          fromBlock: "0x1",
          toBlock: "0x2",
          address: [...addrs, "0x" + "1".repeat(40)],
          topics: [SWAP_TOPIC],
        },
      ]),
    ).toBe(false);
    expect(
      ok("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2", address: addrs, topics: [] }]),
    ).toBe(false);
    expect(ok("eth_sendRawTransaction", ["0x00"])).toBe(false);
    expect(ok("eth_getBlockByNumber", ["latest", true])).toBe(false);
    expect(
      bodyAllowed(
        DEX_MARKETS.sol,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["x", {}] }),
      ),
    ).toBe(false);
    expect(bodyAllowed(DEX_MARKETS.xrp, JSON.stringify({ method: "submit", params: [{}] }))).toBe(
      false,
    );
    expect(
      bodyAllowed(
        DEX_MARKETS.xrp,
        JSON.stringify({
          method: "account_tx",
          params: [
            {
              account: "rOther",
              limit: 200,
              forward: false,
              ledger_index_min: -1,
              ledger_index_max: -1,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("refuses calls beyond the plan before touching the transport", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    }));
    const { rpc, used } = makeRpc({ flavor: "jsonrpc", send, allowed: () => true, maxCalls: 2 });
    await rpc("a", []);
    await rpc("a", []);
    await expect(rpc("a", [])).rejects.toBeInstanceOf(RpcFailure);
    expect(send).toHaveBeenCalledTimes(2);
    expect(used()).toBe(2);
    const refused = makeRpc({ flavor: "jsonrpc", send, allowed: () => false, maxCalls: 5 });
    await expect(refused.rpc("a", [])).rejects.toMatchObject({ kind: "refused" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("a failed middle chunk yields a partial report covering only the contiguous recent span", async () => {
    const now = 2_000_000_000;
    let n = 0;
    const send = async (body: string) => {
      const j = JSON.parse(body);
      if (j.method === "eth_getBlockByNumber") {
        const num = j.params[0] === "latest" ? 10_000 : Number.parseInt(j.params[0], 16);
        return {
          status: 200,
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              number: "0x" + num.toString(16),
              timestamp: "0x" + (now - (10_000 - num) * 12).toString(16),
            },
          }),
        };
      }
      n++;
      return n === 1
        ? { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }) }
        : {
            status: 200,
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32005, message: "limit" },
            }),
          };
    };
    const { report } = await runDex(DEX_MARKETS.eth, "24h", send, now * 1000);
    expect(report.completeness).toBe("partial");
    expect(report.measured_seconds).toBeLessThan(86_400);
    expect(report.warnings.join(" ")).toMatch(/Only \d+ of 25 block ranges/);
  });
});

describe("paid session payment limits", () => {
  const cfg = () => ({ ...researchConfig(), maxPerRequest: 10_000n });
  const quoted = {
    scheme: "exact",
    network: "eip155:5042002",
    amount: "100",
    payTo: "0xf46394addda95a3d5bcc1124605e3d15d204623c",
    asset: "0x3600000000000000000000000000000000000000",
    maxTimeoutSeconds: 1,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    },
  };
  function sdk() {
    const state = { signed: 0, fetched: 0 };
    const factory: SdkFactory = async () => {
      let before: (c: {
        selectedRequirements: Record<string, unknown>;
      }) => Promise<void | { abort: true; reason: string }> = async () => undefined;
      let after: (c: unknown) => Promise<void> = async () => undefined;
      return {
        x402Client: {
          setSpendControls: () => undefined,
          registerPolicy: () => undefined,
          onBeforePaymentCreation: (h) => {
            before = h;
          },
          onAfterPaymentCreation: (h) => {
            after = h;
          },
        },
        fetch: (async () => {
          state.fetched++;
          const r = await before({
            selectedRequirements: quoted as unknown as Record<string, unknown>,
          });
          if (r && r.abort) throw new Error(r.reason);
          await after({});
          state.signed++;
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
            status: 200,
          });
        }) as typeof fetch,
      };
    };
    return { factory, state };
  }
  it("sends and signs at most maxCalls, and only allowlisted bodies", async () => {
    const { factory, state } = sdk();
    const out = await runPaidSession({
      cfg: cfg(),
      key: ("0x" + "11".repeat(32)) as `0x${string}`,
      quoted,
      url: "https://x402.quicknode.com/ethereum-mainnet",
      maxCalls: 2,
      allowBody: (b) => !b.includes("evil"),
      factory,
      beforeSend: async () => undefined,
      work: async (send) => {
        await expect(send("evil")).rejects.toThrow(/allowlisted/);
        await send("{}");
        await send("{}");
        await expect(send("{}")).rejects.toThrow(/budget/);
        return "done";
      },
    });
    expect(state).toEqual({ signed: 2, fetched: 2 });
    expect(out).toMatchObject({ signedCount: 2, callsSent: 2, callsOk: 2, result: "done" });
  });
  it("sends nothing if the durable 'sending' transition fails", async () => {
    const { factory, state } = sdk();
    await expect(
      runPaidSession({
        cfg: cfg(),
        key: ("0x" + "11".repeat(32)) as `0x${string}`,
        quoted,
        url: "u",
        maxCalls: 5,
        allowBody: () => true,
        factory,
        beforeSend: async () => {
          throw new Error("Reservation lost");
        },
        work: async (send) => send("{}"),
      }),
    ).rejects.toThrow(/Reservation lost/);
    expect(state.fetched).toBe(0);
  });
});
