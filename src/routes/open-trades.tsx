import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { PIN_PATTERN, tradingRequest } from "../browserTrading";
import { Empty, PageHeader, Panel, td, th } from "../components/console/ui";

export const Route = createFileRoute("/open-trades")({
  head: () => ({ meta: [{ title: "Private trades · Voice-to-Predict" }] }),
  component: OpenTrades,
});
type Rows = { error?: string; rows: Record<string, string | number>[] };
type Account = { as_of: string; orders: Rows; positions: Rows; history: Rows };
function OpenTrades() {
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [account, setAccount] = useState<Account | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Open trades and positions"
        lead="Enter the approval PIN to read private Gemini Sandbox orders, fills and positions. Data comes straight from Gemini."
      />
      <form
        className="panel flex flex-wrap items-end gap-3 p-4 sm:p-5"
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
        <span className="hidden size-11 shrink-0 place-items-center rounded-full bg-primary-soft text-primary sm:grid">
          <LockKeyhole className="size-5" aria-hidden />
        </span>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm font-medium sm:max-w-xs">
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
          Refresh account
        </button>
        {busy && (
          <p role="status" className="flex w-full items-center gap-2 text-sm text-muted-foreground">
            <span className="spinner spinner-ink" aria-hidden /> Reading Gemini Sandbox…
          </p>
        )}
        {message && (
          <p role="alert" className="w-full rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {message}
          </p>
        )}
      </form>
      {!account && !busy && !message && (
        <div className="panel">
          <Empty>Private account data stays hidden until you enter the PIN. It is never spoken or stored in the browser.</Empty>
        </div>
      )}
      {account && (
        <>
          <p className="tnum text-sm text-muted-foreground">Updated {new Date(account.as_of).toLocaleString()}</p>
          {(
            [
              ["Open orders", account.orders],
              ["Positions", account.positions],
              ["Recent orders and fills", account.history],
            ] as const
          ).map(([title, data]) => {
            const headers = [...new Set(data.rows.flatMap((row) => Object.keys(row)))];
            return (
              <Panel key={title} title={title} right={<span className="tnum text-xs text-muted-foreground">{data.rows.length} records</span>}>
                {data.error ? (
                  <Empty>{data.error}</Empty>
                ) : data.rows.length === 0 ? (
                  <Empty>No records returned.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="border-b border-border bg-muted/50">
                        <tr>
                          {headers.map((k) => (
                            <th key={k} scope="col" className={th}>
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.rows.map((r, i) => (
                          <tr key={i}>
                            {headers.map((k) => (
                              <td key={k} className={td}>
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
