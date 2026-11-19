import { useState } from "react";
import { PIN_PATTERN, tradingRequest } from "../../browserTrading";
import { Empty, Panel } from "./ui";

type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { as_of: string; orders: Rows; positions: Rows; history: Rows };
export function PrivatePortfolio({ showPositions = true }: { showPositions?: boolean }) {
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [account, setAccount] = useState<Account | null>(null);
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <form
        className="flex flex-wrap items-end gap-2"
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
        <label className="flex w-44 flex-col gap-1 text-xs text-muted-foreground">
          Approval PIN
          <input
            className="field tracking-[0.3em]"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            pattern="[0-9]{4,8}"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" disabled={busy || !PIN_PATTERN.test(pin)}>
          Read Gemini account
        </button>
        {busy && (
          <p role="status" className="flex w-full items-center gap-2 text-sm text-muted-foreground">
            <span className="spinner spinner-ink" aria-hidden /> Reading Gemini Sandbox…
          </p>
        )}
        {message && (
          <p role="alert" className="w-full text-sm text-destructive">
            {message}
          </p>
        )}
      </form>
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
