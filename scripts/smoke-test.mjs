// Read-only smoke test for the deployed Voice-to-Predict backend. Never places an order.
// Usage:  node scripts/smoke-test.mjs https://your-app.lovable.app
// Reads TOOL_SHARED_SECRET from the environment (optional). Never prints it.
const base = (process.argv[2] ?? process.env.V2P_BASE_URL ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) {
  console.error("Pass the published https URL: node scripts/smoke-test.mjs https://your-app.lovable.app");
  process.exit(2);
}
const secret = process.env.TOOL_SHARED_SECRET ?? "";
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function call(path, { headers = {}, body } = {}) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// 1. Public dashboard state (no secret). Shows whether the Gemini Sandbox keys work.
const dash = await call("/api/public/dashboard-state");
record("dashboard-state reachable", dash.status === 200 && !!dash.json, `HTTP ${dash.status}`);
if (dash.json) {
  const a = dash.json.account ?? {};
  console.log(`      backend_revision=${dash.json.backend_revision ?? "(none: deployment predates the revision marker)"}`);
  record("Gemini public market data", Array.isArray(dash.json.markets?.events) && dash.json.markets.events.length > 0 && !dash.json.markets.error,
    dash.json.markets?.error ?? `${dash.json.markets?.events?.length ?? 0} events`);
  record("Gemini signed reads (terms, balance, positions)",
    a.configured === true && typeof a.terms_accepted === "boolean" && a.usd_available !== null && !a.positions_error,
    `terms=${a.terms_accepted} usd=${a.usd_available} positions_error=${a.positions_error ?? "none"}`);
  console.log(`      environment=${dash.json.environment}  execution_enabled=${dash.json.execution_enabled}`);
  console.log(`      gemini configured=${a.configured}  terms_accepted=${a.terms_accepted}  usd_available=${a.usd_available}`);
  if (a.balance_error || a.terms_error) console.log(`      gemini errors: ${a.balance_error ?? ""} ${a.terms_error ?? ""}`);
  record("execution is disabled", dash.json.execution_enabled === false, `execution_enabled=${dash.json.execution_enabled}`);
}

// 2. Tools reject unauthenticated calls.
const anon = await call("/api/public/agent-tools/find_market", { body: { query: "bitcoin" } });
record("find_market without secret is rejected", anon.status === 401, `HTTP ${anon.status}`);

if (!secret) {
  record("authenticated checks", null, "TOOL_SHARED_SECRET not set in this shell");
} else {
  const h = { "X-Tool-Secret": secret };
  // 3. Authenticated find_market against live Gemini Sandbox data.
  const fm = await call("/api/public/agent-tools/find_market", { headers: h, body: { query: "bitcoin", expiry_hint: "next" } });
  const m = fm.json?.matches ?? [];
  record("find_market with secret returns Gemini data", fm.status === 200 && fm.json?.ok === true,
    `HTTP ${fm.status} ${fm.json?.error ?? ""} matches=${m.length}${fm.json?.none_found ? " (none open)" : ""}`);
  for (const x of m) {
    console.log(`      ${x.instrument_symbol} | ${x.contract_label} | YES ask ${x.yes_buy_price} / NO ask ${x.no_buy_price} | ${x.minutes_to_expiry} min left`);
  }
  // execute_trade is deliberately never called here: on older deployments even a bogus call
  // writes PIN-failure rows. Deployment version is checked read-only in dashboard-state instead.
}

const failed = results.filter((r) => r.pass === false).length;
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll run checks passed.");
process.exit(failed ? 1 : 0);
