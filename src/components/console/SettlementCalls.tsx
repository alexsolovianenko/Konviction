import { useEffect, useState } from "react";
import { workerTrading } from "../../browserTrading";

type Preference = {configured:boolean; enabled:boolean; ending:string | null};
async function preference(enabled?: boolean): Promise<Preference | null> {
  const response = await fetch("/api/trading/settlement-callback", {
    method: enabled === undefined ? "GET" : "POST",
    cache:"no-store",
    ...(enabled !== undefined && {headers:{"Content-Type":"application/json"}, body:JSON.stringify({enabled})}),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.ok && data.configured ? data : null;
}
export function SettlementCalls() {
  const [state,setState] = useState<Preference | null>(null);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState("");
  useEffect(() => {
    if (workerTrading) return;
    let active = true;
    preference().then(value => {if (active) setState(value);}).catch(() => {});
    return () => {active=false;};
  }, []);
  if (!state) return null;
  return <section aria-label="Settlement calls">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.enabled} disabled={saving} onChange={async event => {
      const enabled=event.currentTarget.checked;
      setSaving(true); setError("");
      try {
        const saved=await preference(enabled);
        if (saved) setState(saved);
        else setError("Could not update callback consent.");
      } catch {setError("Could not update callback consent.");}
      finally {setSaving(false);}
    }} /> Call my number ending in {state.ending} when a sandbox position settles</label>
    {error && <p role="alert">{error}</p>}
  </section>;
}
