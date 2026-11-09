// Settings > Modules > Part Requests, Admin only: Setup, Requests log, Paired devices and Status.
import { useEffect, useRef, useState } from "react";
import { RouteLink, SettingsSectionNavigation, settingsSectionHref, usePath } from "@lancerlogin/module-sdk/dashboard";
import { ConnectionCard, setupSummary, useSetupStatus } from "./part-requests-connection";
import { adminRoute, errorText, request } from "./part-requests-http.ts";
import {
  connectionProblem, formatDate, formatDateTime, formatShortDate, groupDevices, isConnected, pairingNotice, refreshNotice, requestRow, revokeMessage, uncertainBanner,
  type Device, type DeviceList, type LoggedRequest, type RequestLogPage, type SetupStatus,
} from "./part-requests-model.ts";
import { ConfirmDialog, LoadState, Notice, Pill } from "./part-requests-ui";

const sections = [["setup", "Setup"], ["requests", "Requests log"], ["devices", "Paired devices"], ["status", "Status"]] as const;
type Section = (typeof sections)[number][0];
const isSection = (value: string | null): value is Section => sections.some(([id]) => id === value);

export function PartRequestsSettings({ openSetup }: { openSetup: () => void }) {
  const { path, search, navigate } = usePath();
  const requested = new URLSearchParams(search).get("section");
  const section: Section = isSection(requested) ? requested : "setup";
  const hrefFor = (id: Section) => settingsSectionHref(path, search, id);
  const { status, setStatus, error, loading, load } = useSetupStatus();
  // Each tab shows fresh facts when it opens. The hook has already loaded them for the first one.
  const opened = useRef(section);
  useEffect(() => { if (opened.current !== section) { opened.current = section; void load(); } }, [section]);
  return <section className="settings-page" aria-labelledby="part-requests-title">
    <div className="page-intro"><h1 id="part-requests-title">Part Requests</h1></div>
    <div className="settings-section-toolbar">
      <SettingsSectionNavigation label="Part Requests sections" pickerLabel="Part Requests section" sections={sections.map(([id, title]) => [hrefFor(id), title] as [string, string])} currentHref={hrefFor(section)} navigate={navigate} />
    </div>
    <div className="pr-stack">
      <LoadState loading={loading && !status} error={error} label="Part Requests" onRetry={() => void load()} />
      {status && section === "setup" && <>
        {setupSummary(status)}
        <ConnectionCard status={status} onStatus={setStatus} />
        <div className="module-actions"><button className="settings-setup-link" type="button" onClick={openSetup}>Open setup screen</button></div>
      </>}
      {status && section === "requests" && <RequestsLog databaseId={status.databaseId} />}
      {section === "devices" && <PairedDevices />}
      {status && section === "status" && <StatusSection status={status} setupHref={hrefFor("setup")} navigate={navigate} reload={() => load()} />}
    </div>
  </section>;
}

function RequestsLog({ databaseId }: { databaseId: string | null }) {
  const [requests, setRequests] = useState<readonly LoggedRequest[]>();
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusRow, setFocusRow] = useState<string>();
  async function loadPage(before?: number) {
    setBusy(true); setError("");
    try {
      const page = await request<RequestLogPage>(`${adminRoute}/requests${before ? `?before=${before}` : ""}`);
      setRequests((current) => before && current ? [...current, ...page.requests] : page.requests);
      setNextBefore(page.nextBefore); setUncertain(page.uncertainCount);
      // "Load older requests" may disappear, so move on to the first row it added.
      if (before) setFocusRow(page.requests[0]?.id);
    } catch (caught) { setError(errorText(caught, "The requests log could not be loaded.")); }
    finally { setBusy(false); }
  }
  useEffect(() => { void loadPage(); }, []);
  useEffect(() => { if (focusRow) document.getElementById(`pr-request-${focusRow}`)?.focus(); }, [focusRow]);
  const banner = uncertainBanner(uncertain);
  return <>
    {banner && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">{banner}</p>}
    <LoadState loading={busy && !requests} error={error} label="the requests log" onRetry={() => void loadPage(requests ? nextBefore ?? undefined : undefined)} />
    {requests && <section className={`ui-card${requests.length ? " pr-stack" : ""}`} aria-labelledby="pr-log-title">
      <div className="pr-card-heading"><h2 id="pr-log-title">Requests log</h2></div>
      {!requests.length && <p className="empty-state">No requests yet. They appear here after a paired device sends one.</p>}
      {requests.length > 0 && <div className="responsive-table"><table className="ui-table pr-table pr-log">
        <thead><tr><th scope="col">Time</th><th scope="col">Description</th><th scope="col">Vendor</th><th scope="col">Status</th><th scope="col">Member</th><th scope="col">Device</th><th scope="col">Notion</th></tr></thead>
        <tbody>{requests.map((item) => {
          const row = requestRow(item, databaseId);
          return <tr key={item.id} id={`pr-request-${item.id}`} tabIndex={-1}>
            <td className="pr-time" data-label="Time">{formatDateTime(item.createdMs)}</td>
            <th scope="row">{item.description}{row.note && <span className="pr-row-note">{row.note}</span>}</th>
            <td data-label="Vendor">{item.vendor}</td>
            <td data-label="Status"><Pill badge={row.badge} /></td>
            <td data-label="Member">{item.memberName}</td>
            <td data-label="Device">{item.deviceLabel}</td>
            <td data-label="Notion">{row.link
              ? <a href={row.link.href} target="_blank" rel="noopener noreferrer">{row.link.label}<span aria-hidden="true"> ↗</span><span className="visually-hidden"> in Notion, new tab</span></a>
              : <span className="pr-none">No page</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>}
      {nextBefore !== null && <div className="module-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void loadPage(nextBefore)}>{busy ? "Loading..." : "Load older requests"}</button></div>}
    </section>}
  </>;
}

function PairedDevices() {
  const [list, setList] = useState<DeviceList>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Device>();
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [revoked, setRevoked] = useState<{ text: string; key: number }>();
  async function load() {
    setError(""); setLoading(true);
    try { setList(await request<DeviceList>(`${adminRoute}/devices`)); }
    catch (caught) { setError(errorText(caught, "Paired devices could not be loaded.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function revoke() {
    if (!target) return;
    setBusy(true); setRevokeError("");
    try {
      await request(`${adminRoute}/devices/revoke`, "POST", { deviceId: target.id });
      setRevoked({ text: `${target.memberName}'s ${target.label} was revoked.`, key: Date.now() });
      setTarget(undefined);
      await load();
    } catch (caught) { setRevokeError(errorText(caught, "The device could not be revoked.")); }
    finally { setBusy(false); }
  }
  const groups = list ? groupDevices(list.devices, list.limitPerMember) : [];
  return <>
    {revoked
      ? <Notice notice={{ tone: "success", content: revoked.text }} focusKey={revoked.key} />
      : <p className="ui-status settings-notice pr-notice" role="status">Members pair a device by running <code>/ordering-pin</code> in Discord, which privately replies with the site address and a PIN to enter in the extension. Each member can have up to {list?.limitPerMember ?? 5} devices.</p>}
    <LoadState loading={loading && !list} error={error} label="paired devices" onRetry={() => void load()} />
    {list && <section className={`ui-card${groups.length ? " pr-stack" : ""}`} aria-labelledby="pr-devices-title">
      <div className="pr-card-heading"><h2 id="pr-devices-title">Paired devices</h2></div>
      {!groups.length && <p className="empty-state">No paired devices yet. They appear here after a member pairs one.</p>}
      {groups.length > 0 && <div className="responsive-table"><table className="ui-table pr-table pr-devices">
        <thead><tr><th scope="col">Device</th><th scope="col">Paired</th><th scope="col">Last used</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
        {groups.map((group) => <tbody key={group.memberId}>
          <tr className="pr-group"><th colSpan={4} scope="rowgroup"><span className="pr-group-heading"><span>{group.memberName}</span><Pill badge={group.badge} /></span></th></tr>
          {group.devices.map((device) => <tr key={device.id} data-revoked={device.revokedMs !== null ? "true" : undefined}>
            <td data-label="Device">{device.label}</td>
            <td data-label="Paired">{formatDate(device.createdMs)}</td>
            <td data-label="Last used">{device.lastUsedMs ? formatDateTime(device.lastUsedMs) : "Never"}</td>
            <td className="pr-device-action" data-label="Action">{device.revokedMs !== null
              ? <Pill badge={{ label: `Revoked ${formatShortDate(device.revokedMs)}`, tone: "neutral" }} />
              : <button className="ui-button ui-button--danger" type="button" aria-label={`Revoke ${group.memberName}'s ${device.label}`} onClick={() => { setRevokeError(""); setTarget(device); }}>Revoke</button>}</td>
          </tr>)}
        </tbody>)}
      </table></div>}
    </section>}
    {target && <ConfirmDialog title={`Revoke ${target.label}?`} message={revokeMessage(target)} keepLabel="Keep device" confirmLabel="Revoke device" busy={busy} error={revokeError} onConfirm={() => void revoke()} onClose={() => setTarget(undefined)} />}
  </>;
}

function StatusSection({ status, setupHref, navigate, reload }: { status: SetupStatus; setupHref: string; navigate: (path: string) => void; reload: () => Promise<void> }) {
  const connected = isConnected(status);
  const problem = connectionProblem(status);
  const [refresh, setRefresh] = useState<{ busy: boolean; requested: boolean; error: string }>({ busy: false, requested: false, error: "" });
  const result = useRef<HTMLParagraphElement>(null);
  async function refreshNow() {
    setRefresh({ busy: true, requested: false, error: "" });
    try {
      await request(`${adminRoute}/recipients/refresh`, "POST");
      setRefresh({ busy: false, requested: true, error: "" });
      await reload();
      result.current?.focus();
    } catch (caught) { setRefresh({ busy: false, requested: false, error: errorText(caught, "The refresh could not be requested.") }); }
  }
  const setupLink = (className: string) => <RouteLink href={setupHref} currentPath="" navigate={navigate} className={className}>Open setup</RouteLink>;
  const refreshProblem = refreshNotice(status.refresh);
  const pauseNotice = pairingNotice(status.pairingPausedUntilMs);
  return <div className="pr-status-grid">
    <section className="ui-card pr-stack pr-status-wide" aria-labelledby="pr-connection-title">
      <div className="pr-card-heading"><h2 id="pr-connection-title">Notion connection</h2><Pill badge={connected ? { label: "Connected", tone: "success" } : { label: "Requests stopped", tone: "error" }} /></div>
      {problem && <Notice notice={{ tone: "error", content: problem }} action={setupLink("ui-button")} />}
      <dl className="pr-facts">
        <div><dt>Token</dt><dd>{status.tokenSaved ? "Saved" : "Not saved"}</dd></div>
        <div><dt>Data source</dt><dd>{status.dataSourceName ?? "Not chosen"}</dd></div>
        <div><dt>Last verified</dt><dd>{status.verifiedMs ? formatDateTime(status.verifiedMs) : "Not verified"}</dd></div>
        <div><dt>Site address</dt><dd>{status.siteAddress ?? "Not saved"}</dd></div>
      </dl>
      {!problem && <div className="module-actions">{setupLink("settings-setup-link")}</div>}
    </section>

    <section className="ui-card pr-stack" aria-labelledby="pr-recipients-title">
      <div className="pr-card-heading"><h2 id="pr-recipients-title">Recipient list</h2></div>
      <dl className="pr-facts">
        <div><dt>Last refresh</dt><dd>{status.refresh?.finishedMs ? formatDateTime(status.refresh.finishedMs) : "Not yet"}</dd></div>
        <div><dt>People found</dt><dd>{status.recipients}</dd></div>
        <div><dt>Schedule</dt><dd>Every 6 hours</dd></div>
      </dl>
      {refreshProblem && !refresh.requested && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">{refreshProblem}</p>}
      {refresh.error && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{refresh.error}</p>}
      {(!refreshProblem || refresh.requested) && <p ref={result} tabIndex={-1} className="field-help pr-notice" role="status">{refresh.requested ? "Refresh requested. It runs in the background, one step at a time." : connected ? "Workspace members and everyone named on existing requests." : "The list refreshes once the connection is verified."}</p>}
      <div className="module-actions"><button className="ui-button" type="button" disabled={refresh.busy || refresh.requested || !connected} onClick={() => void refreshNow()}>{refresh.busy ? "Requesting..." : "Refresh now"}</button></div>
    </section>

    <section className="ui-card pr-stack" aria-labelledby="pr-pairing-title">
      <div className="pr-card-heading"><h2 id="pr-pairing-title">Pairing</h2><Pill badge={pauseNotice ? { label: "Paused", tone: "warning" } : { label: "Open", tone: "success" }} /></div>
      {pauseNotice && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">{pauseNotice}</p>}
      <dl className="pr-facts">
        <div><dt>Paired devices</dt><dd>{status.pairedDevices}</dd></div>
        <div><dt>Limit per member</dt><dd>{status.deviceLimit} devices</dd></div>
      </dl>
    </section>
  </div>;
}
