// The Notion connection card, on Core's setup screen and on the Connection tab, and the setup screen itself. One Verify button
// saves the token and checks the database together. Core keeps a module open once its setup is complete, so replacing or
// removing the token later stops requests without closing these pages.
import { useEffect, useId, useState, type FormEvent } from "react";
import type { DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";
import { errorText, recordSetupStep, request, RequestError, setupRoute, type DataSource } from "./part-requests-http.ts";
import { connectionProblem, databaseLink, formatDateTime, isConnected, type SetupStatus } from "./part-requests-model.ts";
import { ConfirmDialog, Field, fieldAria, LoadState, Notice, Pill, type NoticeValue } from "./part-requests-ui";

export const connectionsUrl = "https://app.notion.com/developers/connections";
const settingsPath = "/settings/part-requests";

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

const linkHelp = "Copy the link to the database itself, not a page with a linked view.";

/** `openSetup` is given on the Connection tab only. There the card also puts any problem and its fix above itself, always lists its facts, and links to Core's setup screen. */
export function ConnectionCard({ status, onStatus, onVerified, openSetup }: { status: SetupStatus; onStatus: (status: SetupStatus) => void; onVerified?: () => Promise<void> | void; openSetup?: () => void }) {
  const ids = useId();
  const [token, setToken] = useState("");
  const [link, setLink] = useState(status.databaseId ? databaseLink(status.databaseId) : "");
  const [sources, setSources] = useState<readonly DataSource[]>();
  const [sourceId, setSourceId] = useState(status.dataSourceId ?? "");
  const [tokenError, setTokenError] = useState<string>();
  const [linkError, setLinkError] = useState<string>();
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [replaceError, setReplaceError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  // Fields are disabled while busy and may not be drawn yet, so focus moves once React has settled.
  const [focusTarget, setFocusTarget] = useState<string>();
  useEffect(() => { if (focusTarget && !busy) { document.getElementById(focusTarget)?.focus(); setFocusTarget(undefined); } }, [focusTarget, busy]);
  const connected = isConnected(status);
  const onTab = openSetup !== undefined;
  const formId = `${ids}form`;
  const tokenId = `${ids}token`; const linkId = `${ids}link`; const newTokenId = `${ids}new-token`; const replaceId = `${ids}replace-button`; const firstSourceId = `${ids}source-0`;
  const name = status.dataSourceName ?? "the ordering database";

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (connected || busy) return;
    setFormError(""); setResult(undefined);
    const missingToken = !status.tokenSaved && !token.trim() ? "Enter the connection's Notion token." : undefined;
    const missingLink = !link.trim() ? "Enter the database's Notion link." : undefined;
    setTokenError(missingToken); setLinkError(missingLink);
    if (missingToken) { setFocusTarget(tokenId); return; }
    if (missingLink) { setFocusTarget(linkId); return; }
    setBusy(true);
    try {
      const next = await request<SetupStatus>(`${setupRoute}/verify`, "POST", { ...(status.tokenSaved ? {} : { token: token.trim() }), databaseUrl: link.trim(), ...(sourceId ? { dataSourceId: sourceId } : {}) });
      await recordSetupStep();
      setToken(""); setSources(undefined);
      onStatus(next);
      await onVerified?.();
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === "data_source_required") {
        // The token is saved by now, so the form moves on to choosing a data source.
        setSources(caught.dataSources);
        setSourceId(caught.dataSources.find((source) => source.id === sourceId)?.id ?? caught.dataSources[0]?.id ?? "");
        setToken("");
        onStatus(await request<SetupStatus>(`${setupRoute}/status`));
        setFocusTarget(firstSourceId);
      } else if (caught instanceof RequestError && (caught.code === "notion_token_rejected" || caught.code === "invalid_token") && !status.tokenSaved) { setTokenError(caught.message); setFocusTarget(tokenId); }
      else if (caught instanceof RequestError && caught.code === "invalid_link") { setLinkError(caught.message); setFocusTarget(linkId); }
      else setFormError(errorText(caught, "The connection could not be verified."));
    } finally { setBusy(false); }
  }

  function closeReplace() {
    setReplacing(false); setNewToken(""); setReplaceError(undefined);
    setFocusTarget(replaceId);
  }

  async function saveNewToken() {
    if (!newToken.trim()) { setReplaceError("Enter the new Notion token."); setFocusTarget(newTokenId); return; }
    setBusy(true); setReplaceError(undefined); setResult(undefined);
    try {
      onStatus(await request<SetupStatus>(`${setupRoute}/token`, "PUT", { token: newToken.trim() }));
      setResult({ notice: { content: "New token saved. Verify the connection to turn requests back on." }, key: Date.now() });
      setReplacing(false); setNewToken("");
    } catch (caught) { setReplaceError(errorText(caught, "The token could not be saved.")); setFocusTarget(newTokenId); }
    finally { setBusy(false); }
  }

  async function removeToken() {
    setBusy(true); setRemoveError("");
    try {
      onStatus(await request<SetupStatus>(`${setupRoute}/token`, "DELETE"));
      setRemoving(false); setReplacing(false); setNewToken("");
      setResult({ notice: { content: "Token removed. Requests have stopped until a new token is saved and verified." }, key: Date.now() });
    } catch (caught) { setRemoveError(errorText(caught, "The token could not be removed.")); }
    finally { setBusy(false); }
  }

  const problem = status.problem === "notion_schema_changed" ? connectionProblem(status) : undefined;
  const noEncryption = !status.canSaveToken && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">Credential encryption is unavailable on this installation, so a token cannot be saved.</p>;
  // The fix for what stopped requests: verify with what is saved, or go to the token field. Without encryption there is no fix to offer here.
  const rejected = status.problem === "notion_token_rejected";
  // A rejected token has nothing to verify: it needs replacing, so the tab leaves the database link and Verify out.
  const repairing = !connected && !(onTab && rejected);
  const fix = rejected
    ? <button className="ui-button" type="button" onClick={() => { setReplacing(true); setFocusTarget(newTokenId); }}>Replace token</button>
    : status.tokenSaved
    ? <button className="ui-button" type="submit" form={formId} disabled={busy}>{busy ? "Verifying..." : "Verify connection"}</button>
    : status.canSaveToken ? <button className="ui-button" type="button" onClick={() => setFocusTarget(tokenId)}>Enter token</button> : undefined;
  const problemText = onTab ? connectionProblem(status) : undefined;
  const stopped = problemText && status.problem === "notion_schema_changed" ? `${problemText} Then verify the connection again.` : problemText;
  const setupButton = openSetup && <button className="settings-setup-link" type="button" onClick={openSetup}>Open setup</button>;
  const facts = <dl className="pr-facts">
    <div><dt>Data source</dt><dd>{status.dataSourceName ?? (connected ? "Name not recorded" : "Not chosen")}</dd></div>
    <div><dt>Last verified</dt><dd>{status.verifiedMs ? formatDateTime(status.verifiedMs) : connected ? "Not yet" : "Not verified"}</dd></div>
    <div><dt>Site address</dt><dd>{status.siteAddress ?? "Not saved"}</dd></div>
  </dl>;
  return <>
  {stopped && <Notice notice={{ tone: "error", content: stopped }} action={fix} />}
  {onTab && noEncryption}
  <form id={formId} className={onTab ? "ui-card pr-stack ui-form" : "module-setup-card ui-form"} aria-labelledby={onTab ? `${ids}title` : undefined} noValidate onSubmit={(event) => void verify(event)}>
    {onTab
      ? <div className="pr-card-heading"><h2 id={`${ids}title`}>Notion connection</h2><Pill badge={connected ? { label: "Connected", tone: "success" } : { label: "Requests stopped", tone: "error" }} /></div>
      : <div className="module-setup-card-heading">
        <div><p className="kicker">Step 1 - Required</p><h2>Notion connection</h2></div>
        <Pill badge={connected ? { label: "Connected", tone: "success" } : { label: "Not connected", tone: "neutral" }} />
      </div>}
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    {connected && <p className="ui-status settings-notice pr-notice" data-tone="success" role="status">Connected to {name}. Members can now run <code>/ordering-pin</code> in Discord to pair a device.</p>}
    {!onTab && problem && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{problem}</p>}
    {!onTab && noEncryption}

    {!status.tokenSaved && <div className="oauth-walkthrough pr-stack">
      <ol>
        <li>Open Notion's connections page and create a connection for this team.</li>
        <li>Give it three capabilities: Read content, Insert content, and Read user information without email addresses.</li>
        <li>Copy its token, then add the connection to the ordering database in Notion.</li>
      </ol>
      <div className="module-actions"><a className="ui-button" href={connectionsUrl} target="_blank" rel="noopener noreferrer">Open Notion connections<span aria-hidden="true">&nbsp;↗</span><span className="visually-hidden"> in a new tab</span></a></div>
    </div>}

    {!status.tokenSaved && <Field id={tokenId} label="Notion connection token" help="Stored encrypted. It can't be viewed again; this page only shows that one is saved." error={tokenError}>
      <input {...fieldAria(tokenId, tokenError)} type="password" autoComplete="new-password" spellCheck={false} maxLength={1000} disabled={busy} value={token} onChange={(event) => { setToken(event.target.value); setTokenError(undefined); }} />
    </Field>}

    {status.tokenSaved && <div className="pr-field">
      <div className="saved-credentials" role="group" aria-label="Notion connection token">
        <span className="pr-saved-state"><strong>Notion connection token</strong><Pill badge={rejected ? { label: "Rejected", tone: "error" } : { label: "Saved", tone: "success" }} /></span>
        <span className="saved-credentials-actions">
          <button id={replaceId} className="ui-button" type="button" disabled={busy} aria-expanded={replacing} aria-controls={`${ids}replace`} onClick={() => { if (replacing) closeReplace(); else { setReplacing(true); setFocusTarget(newTokenId); } }}>Replace token</button>
          <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => { setRemoveError(""); setRemoving(true); }}>Remove token</button>
        </span>
      </div>
      <div className="pr-replace" id={`${ids}replace`} hidden={!replacing}>
        <Field id={newTokenId} label="New token" help="Requests stop when a new token is saved, until the connection is verified again." error={replaceError}>
          <input {...fieldAria(newTokenId, replaceError)} type="password" autoComplete="new-password" spellCheck={false} maxLength={1000} disabled={busy} value={newToken}
            onChange={(event) => { setNewToken(event.target.value); setReplaceError(undefined); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveNewToken(); } }} />
        </Field>
        <div className="module-actions">
          <button className="ui-button" type="button" disabled={busy || !status.canSaveToken} onClick={() => void saveNewToken()}>{busy ? "Saving..." : "Save new token"}</button>
          <button className="ui-button" type="button" disabled={busy} onClick={closeReplace}>Cancel</button>
        </div>
      </div>
    </div>}

    {(connected || onTab) && facts}

    {repairing && <>
      <Field id={linkId} label="Database link" help={linkHelp} error={linkError}>
        <input {...fieldAria(linkId, linkError)} type="url" inputMode="url" placeholder="https://app.notion.com/p/..." spellCheck={false} maxLength={2000} disabled={busy} value={link}
          onChange={(event) => { setLink(event.target.value); setLinkError(undefined); setSources(undefined); setSourceId(""); }} />
      </Field>
      {sources && sources.length > 0 && <fieldset className="pr-field" disabled={busy}>
        <legend>Data source</legend>
        <span className="field-help">This database has multiple data sources. Select the ordering data source.</span>
        <div className="pr-choice-group">{sources.map((source, index) => <label className="pr-choice" key={source.id}>
          <input id={`${ids}source-${index}`} type="radio" name={`${ids}source`} checked={sourceId === source.id} onChange={() => setSourceId(source.id)} /> {source.name || "Unnamed data source"}
        </label>)}</div>
      </fieldset>}
      {!status.tokenSaved && <details className="settings-disclosure">
        <summary>Expected database layout</summary>
        <ul className="pr-layout">{layout.map(([field, kind]) => <li key={field}><strong>{field}</strong>: {kind}</li>)}</ul>
      </details>}
      {/* The tab's Verify button can be far above this, so a failure takes focus there. */}
      {formError && (onTab
        ? <Notice notice={{ tone: "error", content: formError }} focusKey={formError} />
        : <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{formError}</p>)}
      <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy || !status.tokenSaved && !status.canSaveToken}>{busy ? "Verifying..." : "Verify connection"}</button>{setupButton}</div>
    </>}
    {formError && connected && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{formError}</p>}
    {!repairing && setupButton && <div className="module-actions">{setupButton}</div>}

    {removing && <ConfirmDialog title="Remove the Notion token?" keepLabel="Keep token" confirmLabel="Remove token" busy={busy} error={removeError} onConfirm={() => void removeToken()} onClose={() => setRemoving(false)}
      message="Requests from the browser extension stop at once, until a new token is saved and the connection is verified again. Paired devices stay paired and the log stays." />}
  </form>
  </>;
}

/** Core's setup screen. Core shows it until setup is complete, and an Admin can reopen it from the Connection tab. */
export function PartRequestsSetup({ module, navigate, onReady }: DashboardSetupProps) {
  const { status, setStatus, error, loading, load } = useSetupStatus();
  // Core would reopen setup if it were left before Core had drawn the module as ready, so go to the module's page only then.
  const [finished, setFinished] = useState(false);
  useEffect(() => { if (finished && module.setup.ready) navigate(`${settingsPath}?section=connection`); }, [finished, module.setup.ready]);
  return <section className="module-onboarding" aria-labelledby="part-requests-setup-title">
    <div className="page-intro"><p className="kicker">Part Requests module</p><h1 id="part-requests-setup-title">Set up Part Requests</h1><p>Connect the team's Notion ordering database. Requests from the browser extension stay off until the connection is verified.</p></div>
    <LoadState loading={loading && !status} error={error} label="Part Requests setup" onRetry={() => void load()} />
    {status && <>
      {setupSummary(status)}
      <ConnectionCard status={status} onStatus={setStatus} onVerified={async () => { await onReady(); setFinished(true); }} />
    </>}
  </section>;
}
