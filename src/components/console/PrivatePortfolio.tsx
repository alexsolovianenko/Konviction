import { useEffect, useState } from "react";
import { usd } from "../../lib/format";
import { PIN_PATTERN, workerTrading, tradingRequest } from "../../browserTrading";
import { Empty, Panel } from "./ui";

type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { usd_available?: number | null; balance_error?: string; as_of: string; orders: Rows; positions: Rows; history: Rows };
export function PrivatePortfolio({ showPositions = true, showBalance = false }: { showPositions?: boolean; showBalance?: boolean }) {
  const [message, setMessage] = useState("Loading order history…");
  const [account, setAccount] = useState<Account | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  async function unlock() {
    if (!PIN_PATTERN.test(pin) || busy) return;
    setBusy(true);
    setPin("");
    try {
      const result = await tradingRequest("portfolio", { pin });
      if (result.ok) {
        setAccount(result);
        setShowUnlock(false);
        setMessage("");
      } else {
        setMessage(result.message || "Account access unavailable.");
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    async function load() {
      const availability = await tradingRequest("availability");
      if (!active) return;
      if (!availability.ok || !availability.voice_authorized) {
        setShowUnlock(Boolean(availability.ok && workerTrading));
        setMessage(!availability.ok ? "Order history unavailable." : workerTrading
          ? "Enter your sandbox PIN to view balances, orders and positions."
          : "Pair this browser to see order history.");
        return;
      }
      const result = await tradingRequest("portfolio", {});
      if (!active) return;
      if (result.ok) setAccount(result);
      setMessage(result.ok ? "" : result.error === "DEVICE_REQUIRED"
        ? "Pair this browser to see order history." : "Order history unavailable.");
    }
    void load();
    return () => { active = false; };
  }, []);
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      {showUnlock && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void unlock(); }}>
        <label className="grid gap-1 text-sm">Sandbox PIN
          <input type="password" className="field" autoComplete="off" inputMode="numeric" maxLength={8} value={pin} onChange={e => setPin(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !PIN_PATTERN.test(pin)}>{busy ? "Opening…" : "View account"}</button>
      </form>}
      {account && (
        <>
          {showBalance && <section className="balance-card">
            <div className="text-sm text-muted-foreground">USD available</div>
            <div className="tnum mt-1 text-4xl font-semibold">{usd(account.usd_available)}</div>
            {account.balance_error && <p className="text-sm text-destructive">{account.balance_error}</p>}
          </section>}
          <p className="tnum text-xs text-muted-foreground">Updated {new Date(account.as_of).toLocaleString()}</p>
          {(
            [
              ["Open orders", account.orders],
              ["Positions", account.positions],
              ["Recent orders and fills", account.history],
            ] as const
          ).filter(([title]) => showPositions || title !== "Positions").map(([title, data]) => {
            const headers = [...new Set(data.rows.flatMap((row) => Object.keys(row)))];
            return (
              <Panel key={title} title={title} right={<span className="tnum text-xs text-muted-foreground">{data.error ? "Unavailable" : `${data.rows.length} records`}</span>}>
                {data.error ? (
                  <Empty>{data.error}</Empty>
                ) : data.rows.length === 0 ? (
                  <Empty>No records returned.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data">
                      <thead>
                        <tr>
                          {headers.map((k) => (
                            <th key={k} scope="col">
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r, i) => (
                          <tr key={i}>
                            {headers.map((k) => (
                              <td key={k} className="tnum whitespace-nowrap">
                                {r[k] ?? "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            );
          })}
        </>
      )}
    </div>
  );
}
