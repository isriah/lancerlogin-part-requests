// The Notion connection card, on Core's setup screen and on the Connection tab, and the setup screen itself. The token lives
// in Core (Settings > Integrations > Notion); this card shows Core's connection, places Core's picker for the `orders`
// binding, and verifies the chosen database's layout. Core keeps a module open once its setup is complete, so a problem
// later stops requests without closing these pages.
import { useEffect, useId, useState } from "react";
import { NotionBindingField, type DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";
import { errorText, recordSetupStep, request, setupRoute } from "./part-requests-http.ts";
import { connectionProblem, coreState, formatDateTime, integrationsLabel, integrationsPath, isConnected, neededCapabilities, offerPrevious, shareDatabaseText, type SetupStatus } from "./part-requests-model.ts";
import { LoadState, Notice, Pill, type NoticeValue } from "./part-requests-ui";

const settingsPath = "/settings/part-requests";
/** Core's route behind its own database picker, the one NotionBindingField uses. */
const ordersBindingPath = "/admin/integrations/notion/bindings/part-requests/orders";

export function useSetupStatus() {
  const [status, setStatus] = useState<SetupStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    setError(""); setLoading(true);
    try { setStatus(await request<SetupStatus>(`${setupRoute}/status`)); }
    catch (caught) { setError(errorText(caught, "Part Requests could not be loaded.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return { status, setStatus, error, loading, load };
}

export const setupSummary = (status: SetupStatus) => <div className="module-setup-summary" role="status"><strong>{isConnected(status) ? "Setup complete" : "Setup required"}</strong><span>Step 1 of 1</span></div>;

const layout: readonly (readonly [string, string])[] = [
  ["Item Description", "title"], ["Status", "status or select, with NORMAL Request and Incomplete Request"], ["Vendor", "select, with all 20 store names"],
  ["Team", "select or multi-select"], ["Orderer/Recipient", "people"], ["SKU", "rich text"], ["Product URL", "url"], ["Qty", "number"], ["Unit Price", "number"],
  ["Extension", "formula or rollup, never written"],
];

const integrationsLink = <a href={integrationsPath}>Open {integrationsLabel}</a>;

/** `openSetup` is given on the Connection tab only. There the card also puts any problem and its fix above itself, always lists its facts, and links to Core's setup screen. */
export function ConnectionCard({ status, onStatus, onVerified, openSetup }: { status: SetupStatus; onStatus: (status: SetupStatus) => void; onVerified?: () => Promise<void> | void; openSetup?: () => void }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [previousError, setPreviousError] = useState("");
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  // Core's picker reads Core's status once, when it mounts. A new key draws it again after this card changed the binding.
  const [pickerKey, setPickerKey] = useState(0);
  const connected = isConnected(status);
  const onTab = openSetup !== undefined;
  const name = status.binding?.name || status.dataSourceName || "the ordering database";

  async function reload() {
    try { onStatus(await request<SetupStatus>(`${setupRoute}/status`)); }
    catch (caught) { setFormError(errorText(caught, "Part Requests could not be loaded.")); }
  }

  async function verify() {
    if (busy) return;
    setBusy(true); setFormError(""); setResult(undefined);
    try {
      const next = await request<SetupStatus>(`${setupRoute}/verify`, "POST", {});
      await recordSetupStep();
      onStatus(next);
      setResult({ notice: { tone: "success", content: `Verified ${next.dataSourceName ?? "the ordering database"}.` }, key: Date.now() });
      await onVerified?.();
    } catch (caught) { setFormError(errorText(caught, "The connection could not be verified.")); }
    finally { setBusy(false); }
  }

  // Core checks that its own connection can open the database before it saves the choice, so this cannot bind a database
  // Core's token can't reach. Then the layout is verified at once, as the database is the one Part Requests already used.
  async function usePrevious() {
    if (busy || !status.databaseId || !status.dataSourceId) return;
    setBusy(true); setPreviousError(""); setFormError(""); setResult(undefined);
    try {
      await request(ordersBindingPath, "PUT", { database: status.databaseId, dataSourceId: status.dataSourceId });
      setPickerKey((key) => key + 1);
    } catch (caught) {
      setPreviousError(`${errorText(caught, "Core could not open the ordering database.")} ${shareDatabaseText}`);
      setBusy(false);
      return;
    }
    setBusy(false);
    await verify();
  }

  const problemText = onTab ? connectionProblem(status) : undefined;
  const canVerify = status.core.connected && Boolean(status.binding);
  const needsVerify = canVerify && (status.problem === "not_verified" || status.problem === "notion_schema_changed" || status.problem === "notion_access_lost");
  const verifyButton = <button className="ui-button ui-button--primary" type="button" disabled={busy || !canVerify} onClick={() => void verify()}>{busy ? "Verifying..." : connected ? "Verify again" : "Verify connection"}</button>;
  const fix = needsVerify ? verifyButton : !status.core.connected ? <a className="ui-button" href={integrationsPath}>Open Integrations</a> : undefined;
  const setupButton = openSetup && <button className="settings-setup-link" type="button" onClick={openSetup}>Open setup</button>;
  const facts = <dl className="pr-facts">
    <div><dt>Core's Notion connection</dt><dd>{coreState(status.core)}</dd></div>
    <div><dt>Ordering database</dt><dd>{status.binding ? status.binding.name || "Chosen" : "Not chosen"}</dd></div>
    <div><dt>Last verified</dt><dd>{status.verifiedMs ? formatDateTime(status.verifiedMs) : "Not verified"}</dd></div>
    <div><dt>Site address</dt><dd>{status.siteAddress ?? "Not saved"}</dd></div>
  </dl>;
  return <>
  {problemText && <Notice notice={{ tone: "error", content: problemText }} action={fix} />}
  <section className={onTab ? "ui-card pr-stack" : "module-setup-card"} aria-labelledby={`${ids}title`}>
    {onTab
      ? <div className="pr-card-heading"><h2 id={`${ids}title`}>Notion connection</h2><Pill badge={connected ? { label: "Connected", tone: "success" } : { label: "Needs attention", tone: "error" }} /></div>
      : <div className="module-setup-card-heading">
        <div><p className="kicker">Step 1 - Required</p><h2 id={`${ids}title`}>Notion connection</h2></div>
        <Pill badge={connected ? { label: "Connected", tone: "success" } : { label: "Not connected", tone: "neutral" }} />
      </div>}
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    {connected && <p className="ui-status settings-notice pr-notice" data-tone="success" role="status">Connected to {name}. Members can now run <code>/ordering-pin</code> in Discord to pair a device.</p>}
    {!onTab && status.problem && !connected && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{connectionProblem(status)}</p>}
    {status.legacyTokenSaved && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">The Notion token Part Requests 1.1 saved has not moved to Core yet, because credential encryption is unavailable on this installation. It moves by itself once encryption works again. Until then, requests stay stopped.</p>}

    <p className="field-help pr-notice">Part Requests uses Core's Notion connection. The token is saved in Core, never on this page. {integrationsLink}.</p>
    {!status.core.connected && <div className="oauth-walkthrough pr-stack">
      <ol>
        <li>Open Notion's connections page and create a connection for this team, or use the one Core already has.</li>
        <li>Give it these capabilities: {neededCapabilities.map(([, label]) => label).join(", ")}.</li>
        <li>Save its token in {integrationsLabel}, then share the ordering database with the connection in Notion.</li>
      </ol>
    </div>}

    {(connected || onTab) && facts}

    {status.core.connected && <>
      {/* Core's own picker for the `orders` binding: the Admin pastes the database's link and Core checks its connection can read it. */}
      <NotionBindingField key={pickerKey} moduleId="part-requests" bindingId="orders" onChanged={(bound) => { if (bound !== Boolean(status.binding)) void reload(); }} />
      {offerPrevious(status) && <div className="pr-stack">
        <p className="field-help pr-notice">Part Requests last used {status.dataSourceName ?? "an ordering database"}. Use it again with Core's connection:</p>
        <div className="module-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void usePrevious()}>{busy ? "Checking..." : "Use the previous ordering database"}</button></div>
        {previousError && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{previousError}</p>}
      </div>}
      {!status.binding && !offerPrevious(status) && <p className="field-help pr-notice">If Core can't open the database, {shareDatabaseText.charAt(0).toLowerCase()}{shareDatabaseText.slice(1)}</p>}
      <details className="settings-disclosure">
        <summary>Expected database layout</summary>
        <ul className="pr-layout">{layout.map(([field, kind]) => <li key={field}><strong>{field}</strong>: {kind}</li>)}</ul>
      </details>
    </>}

    {formError && (onTab
      ? <Notice notice={{ tone: "error", content: formError }} focusKey={formError} />
      : <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{formError}</p>)}
    {/* Shown while connected too: Core's picker can point the binding at another database, and only a new check notices. */}
    {(!connected || canVerify || setupButton) && <div className="module-actions">{(!connected || canVerify) && verifyButton}{setupButton}</div>}
  </section>
  </>;
}

/** Core's setup screen. Core shows it until setup is complete, and an Admin can reopen it from the Connection tab. */
export function PartRequestsSetup({ module, navigate, onReady }: DashboardSetupProps) {
  const { status, setStatus, error, loading, load } = useSetupStatus();
  // Core would reopen setup if it were left before Core had drawn the module as ready, so go to the module's page only then.
  const [finished, setFinished] = useState(false);
  useEffect(() => { if (finished && module.setup.ready) navigate(`${settingsPath}?section=connection`); }, [finished, module.setup.ready]);
  return <section className="module-onboarding" aria-labelledby="part-requests-setup-title">
    <div className="page-intro"><p className="kicker">Part Requests module</p><h1 id="part-requests-setup-title">Set up Part Requests</h1><p>Choose the team's Notion ordering database for Core's Notion connection, then verify it. Requests from the browser extension stay off until it is verified.</p></div>
    <LoadState loading={loading && !status} error={error} label="Part Requests setup" onRetry={() => void load()} />
    {status && <>
      {setupSummary(status)}
      <ConnectionCard status={status} onStatus={setStatus} onVerified={async () => { await onReady(); setFinished(true); }} />
    </>}
  </section>;
}
