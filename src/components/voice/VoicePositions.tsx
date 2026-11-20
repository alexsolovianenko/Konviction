import { hms } from "../../lib/format";
import type { VoiceView } from "../../voice";
import { cents, usd } from "../../lib/format";

export function VoicePositions({ snapshot }: { snapshot: VoiceView["positionSnapshot"] }) {
  if (!snapshot) return null;
  return (
    <section aria-label="Voice position lookup" className="min-w-0 rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Sandbox positions</h2>
        <time className="text-xs text-muted-foreground" dateTime={snapshot.as_of}>
          {hms(snapshot.as_of)}
        </time>
      </header>
      {snapshot.positions.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="data">
            <thead>
              <tr>{["Contract", "Qty", "Avg", "Bid", "Mark", "Value", "Unreal. P&L", "Net profit"].map(label => <th key={label}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {snapshot.positions.map((position, index) => (
                <tr key={index}>
                  <td>{[position.event_title, position.contract_label, position.outcome?.toUpperCase()].filter(Boolean).join(" · ") || "Contract"}</td>
                  <td>{position.quantity ?? "—"}</td><td>{cents(position.average_price)}</td>
                  <td>{cents(position.current_bid)}</td><td>{cents(position.mark_price)}</td>
                  <td>{usd(position.market_value_usd)}</td><td>{usd(position.unrealized_pnl_usd)}</td>
                  <td>{usd(position.net_profit_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-sm text-muted-foreground">{snapshot.positions_available ? "Gemini reports no open positions." : "Positions unavailable."}</p>}
      {snapshot.settlements.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <h3 className="text-sm font-medium">Recent settlements</h3>
          <table className="data">
            <thead><tr>{["Contract", "Qty", "Result", "Payout", "Net profit"].map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{snapshot.settlements.map((settled, index) => (
              <tr key={index}>
                <td>{[settled.event_title, settled.contract_label, settled.outcome?.toUpperCase()].filter(Boolean).join(" · ") || "Contract"}</td>
                <td>{settled.quantity ?? "—"}</td><td>{settled.resolution?.toUpperCase() ?? "—"}</td>
                <td>{usd(settled.payout_usd)}</td><td>{usd(settled.net_profit_usd)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
