import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { tradingRequest } from "../browserTrading";
export const Route = createFileRoute("/open-trades")({ component: OpenTrades });
type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { as_of: string; orders: Rows; positions: Rows; history: Rows };
function OpenTrades() {
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [account, setAccount] = useState<Account | null>(null);
  return (
    <main className="voice-panel panel mx-auto max-w-5xl p-5">
      <a href="/">← Console</a> · <a href="/voice">Browser voice</a>
      <h1>Open trades and positions</h1>
      <p>Enter the local account PIN to refresh private Gemini Sandbox data.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setPin("");
          setAccount(null);
          setMessage("");
          try {
            const r = await tradingRequest("portfolio", { pin });
            if (r.ok) setAccount(r);
            else setMessage(r.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Account PIN{" "}
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            pattern="[0-9]{4}"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <button disabled={busy || pin.length !== 4}>Refresh account</button>
      </form>
      {busy && <p>Reading Gemini Sandbox…</p>}
      {message && <p role="alert">{message}</p>}
      {account && (
        <>
          <p>Updated {new Date(account.as_of).toLocaleString()}</p>
          {(
            [
              ["Open orders", account.orders],
              ["Positions", account.positions],
              ["Recent orders and fills", account.history],
            ] as const
          ).map(([title, data]) => {
            const headers = [...new Set(data.rows.flatMap((row) => Object.keys(row)))];
            return (
              <section key={title}>
                <h2>{title}</h2>
                {data.error ? (
                  <p>{data.error}</p>
                ) : data.rows.length === 0 ? (
                  <p>No records returned.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table>
                      <thead>
                        <tr>
                          {headers.map((k) => (
                            <th key={k} className="p-2">
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r, i) => (
                          <tr key={i}>
                            {headers.map((k) => (
                              <td key={k} className="p-2">
                                {r[k] ?? "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}
