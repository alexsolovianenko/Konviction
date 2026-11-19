import { ClientOnly } from "@tanstack/react-router";
import { Disclaimer, MarketsTable } from "@/components/console/Console";
import { useVoice } from "@/components/voice/VoiceProvider";
import { Dashboard } from "./Dashboard";

// Markets first: the live listing is usable before voice starts, and "Quote" on a row runs the same
// read-only Gemini Sandbox lookup the voice assistant uses.
export function MarketWorkspace() {
  const { market } = useVoice();
  return (
    <ClientOnly>
      <Dashboard>
        <MarketsTable onQuote={(event_ticker, contract_symbol) => void market.run("get_orderbook", { event_ticker, contract_symbol })} />
        <Disclaimer />
      </Dashboard>
    </ClientOnly>
  );
}
