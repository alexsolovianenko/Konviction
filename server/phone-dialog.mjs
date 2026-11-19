import { gPrivate, hasCredentials } from "../src/server/v2p/gemini.ts";
import { marketTool } from "../src/server/v2p/market-tools.ts";
import { prepareTrade, executeTrade } from "../src/server/v2p/trade-engine.ts";
import { LIMITS } from "../src/server/v2p/util.ts";
import { TradeError, TradingRepository } from "./trading-repository.mjs";

import { orderSize, safeName, executionSpeech } from "./phone-speech.mjs";

const end = (prompt) => ({ state: { step: "end" }, prompt });
const menu = (message = "") => ({
  state: { step: "menu" },
  prompt: message + " Say a market topic to search, positions, or hang up.",
});
const words = (s) => (s ?? "").trim().toLowerCase().replace(/[.!]$/, "");
export const pairPrompt = {
  state: { step: "pair" },
  prompt:
    "Gemini sandbox. Enter the eight digit one-time code from your trusted device using your keypad.",
};

export function phoneDialog(repo, calls) {
  const trades = new TradingRepository(repo);
  return async (sid, turn, state, form) => {
    const speech = words(form.SpeechResult);
    const digits = form.Digits ?? "";
    if (state.step === "pair") {
      return !form.SpeechResult && calls.redeem(digits)
        ? menu("Paired.")
        : end("Pairing failed. Goodbye.");
    }
    if (speech === "hang up" || ["goodbye", "done"].includes(speech)) return end("Goodbye.");
    if (state.step === "menu") {
      if (speech === "positions") {
        const pos = await gPrivate("/v1/prediction-markets/positions");
        if (!pos.ok || !Array.isArray(pos.data?.positions))
          return menu("Sandbox positions are unavailable.");
        const rows = pos.data.positions;
        const summary = rows
          .slice(0, 5)
          .map(
            (p) =>
              `${p.totalQuantity} ${p.outcome} on ${safeName(p.contractMetadata?.eventName, [p.symbol]) ?? "an open contract"}, ${safeName(p.contractMetadata?.contractName, [p.symbol]) ?? ""}.`,
          )
          .join(" ");
        return menu(
          rows.length
            ? `You have ${rows.length} sandbox positions. ${summary}`
            : "You have no open sandbox positions.",
        );
      }
      if (!speech || speech.length > 200) return menu();
      const response = await marketTool(
        "search_markets",
        new URLSearchParams({
          query: speech
            .replace(/^(?:search (?:for )?|pull up |find )/, "")
            .replace(/\bin (?=(?:five|5)[ -]?(?:minute|min))/g, ""),
        }),
      );
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.events)) return menu("Search unavailable.");
      const choices = data.events
        .flatMap((e) =>
          e.contracts
            .filter((c) => c.status === "active" && c.market_state === "open")
            .map((c) => ({
              event: e.ticker,
              symbol: c.symbol,
              title: safeName(e.title, [e.ticker, c.symbol]),
              label: safeName(c.label, [c.symbol]),
            }))
            .filter((c) => c.title && c.label),
        )
        .slice(0, 3);
      if (!choices.length) return menu("No matching open contracts.");
      return {
        state: { step: "select", choices },
        prompt: choices.map((c, i) => `Say option ${i + 1} for ${c.title}, ${c.label}.`).join(" "),
      };
    }
    if (state.step === "select") {
      const index = orderSize(speech.replace(/^option /, ""), "contracts")?.quantity;
      const selected = state.choices[(index ?? 0) - 1];
      if (!selected) return menu("Selection canceled.");
      const response = await marketTool(
        "get_orderbook",
        new URLSearchParams({ event_ticker: selected.event, contract_symbol: selected.symbol }),
      );
      const { contract } = await response.json();
      if (!response.ok || !contract) return menu("Quote unavailable.");
      const ask = (price) => (price == null ? "no ask" : Math.round(price * 100) + " cents");
      return {
        state: { step: "outcome", selected },
        prompt: `Current YES price: ${ask(contract.buy.yes)}. NO price: ${ask(contract.buy.no)}. Say buy ten dollars of yes, buy two contracts of no, or cancel.`,
      };
    }
    const owner = "phone:" + sid;
    if (state.step === "outcome" || state.step === "quantity") {
      let outcome = state.outcome;
      let size;
      if (state.step === "outcome") {
        const order = /^buy (?:(.+?) (?:of )?)?(yes|no)$/.exec(speech);
        if (!order) return menu("Order canceled.");
        outcome = order[2];
        if (!order[1])
          return {
            state: { step: "quantity", selected: state.selected, outcome },
            prompt: "How many contracts, or how many dollars?",
          };
        size = orderSize(order[1]);
      } else size = orderSize(speech, "contracts");
      if (!size) return menu("I could not determine the order size. Order canceled.");
      const terms = {
        event_ticker: state.selected.event,
        instrument_symbol: state.selected.symbol,
        side: "buy",
        outcome,
        ...size,
      };
      const response = await prepareTrade(terms, (proposal) => {
        const saved = trades.propose(
          owner,
          turn,
          JSON.stringify(terms),
          proposal,
          LIMITS.maxDailyUsd,
        );
        return Response.json({ ok: true, proposal: saved });
      });
      const quote = await response.json();
      if (!quote.ok) return menu("No order prepared at that size and price.");
      const p = quote.proposal;
      const maxCost = (p.notional_usd + p.est_fee_usd).toFixed(2);
      const title = safeName(p.title, [p.instrument_symbol, p.event_ticker]);
      const label = safeName(p.contract_label, [p.instrument_symbol]);
      if (!title || !label) return menu("A spoken market description is unavailable.");
      return {
        state: { step: "confirm", proposal: p.proposal_id },
        prompt: `Buy ${p.quantity} ${p.outcome.toUpperCase()} on ${title}, ${label}, up to ${Math.round(p.limit_price * 100)} cents each. Maximum cost including estimated fees, ${maxCost} dollars. Say confirm or cancel.`,
      };
    }
    if (state.step === "confirm") {
      if (digits || speech !== "confirm") return menu("Order canceled.");
      if (process.env.EXECUTION_ENABLED !== "true" || !hasCredentials())
        return menu("Sandbox execution is unavailable.");
      const claim = trades.claim(owner, state.proposal, LIMITS, () => {
        const row = calls.read(sid);
        if (row?.expires <= Date.now() || row?.previous !== turn)
          throw new TradeError("INACTIVE", "Call expired.");
      });
      if (claim.result) return menu(executionSpeech(claim.result));
      const audit = (kind, detail) => trades.audit(state.proposal, kind, detail);
      const response = await executeTrade(claim.terms, owner, {
        finish: (status) => audit("state", status),
        log: (kind) => audit("activity", kind),
        receipt: (_id, _code, kind, data) => audit(kind, data),
        saveOrder: (order) =>
          audit("exchange", { order_id: order.gemini_order_id, outcome: order.outcome_summary }),
      });
      const result = await response.json();
      delete result.exchange_error;
      delete result.detail;
      trades.finish(state.proposal, result);
      return menu(executionSpeech(result));
    }
    return end("Call ended.");
  };
}
