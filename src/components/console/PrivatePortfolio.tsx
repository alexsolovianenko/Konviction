import { useEffect, useState } from "react";
import { workerTrading, tradingRequest } from "../../browserTrading";
import { Empty, Panel } from "./ui";

type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { as_of: string; orders: Rows; positions: Rows; history: Rows };
export function PrivatePortfolio({ showPositions = true }: { showPositions?: boolean }) {
  const [message, setMessage] = useState("Loading order history…");
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      const availability = await tradingRequest("availability");
      if (!active) return;
      if (!availability.ok || !availability.voice_authorized) {
        setMessage(!availability.ok ? "Order history unavailable." : workerTrading
          ? "Order history is available in the paired local app."
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
      {account && (
        <>
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
