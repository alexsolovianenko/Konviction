import { useEffect, useState } from "react";
import { usd } from "../../lib/format";
import { tradingRequest } from "../../browserTrading";
import { Empty, Panel } from "./ui";

type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { usd_available?: number | null; balance_error?: string; as_of: string; orders: Rows; positions: Rows; history: Rows };
export function PrivatePortfolio({ showPositions = true, showBalance = false }: { showPositions?: boolean; showBalance?: boolean }) {
  const [message, setMessage] = useState("Loading order history…");
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    let active = true;
    let next: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.visibilityState !== "hidden") {
        const result = await tradingRequest("portfolio", {});
        if (!active) return;
        if (result.ok) setAccount(result);
        setMessage(result.ok ? "" : result.message || "Order history unavailable.");
      }
      if (active) next = setTimeout(() => { void load(); }, 15000);
    }
    void load();
    return () => { active = false; clearTimeout(next); };
  }, []);
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
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
