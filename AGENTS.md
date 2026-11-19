<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

- The console is read-only and renders only data from the `dashboard-state` server route; never add mock data (judges must see real sandbox state).
- Voice-to-Predict backend lives in src/server/v2p and is exposed only via server routes under src/routes/api/public (dynamic-imported in handlers so server code never enters the client bundle); no Supabase edge functions.
- Serve market listings through a cached public-field projection of the Gemini Sandbox feed in `dashboard-state` so polling does not expose upstream credentials or diagnostics.
- Hosted sandbox order submission uses the authenticated ElevenLabs call-confirm webhook and a server-signed voice session. Check the provider-supplied call history for the exact readback and explicit confirmation before claiming the stored proposal once. Keep the public browser result endpoint read-only. Expose only allowlisted read-only fields for the single shared sandbox account. Keep standalone execute_trade refused and Gemini requests on the sandbox origin with redirect set to manual. The local launcher uses SQLite.
