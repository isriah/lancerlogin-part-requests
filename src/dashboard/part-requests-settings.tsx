// Settings > Modules > Part Requests, Admin only: Connection, Requests log and Paired devices.
import { useEffect, useMemo, useRef, useState } from "react";
import { SettingsSectionNavigation, settingsSectionHref, usePath } from "@lancerlogin/module-sdk/dashboard";
import { ConnectionCard, useSetupStatus } from "./part-requests-connection";
import { adminRoute, errorText, request, setupRoute } from "./part-requests-http.ts";
import {
  adminSection, adminSections, deviceSummary, emptyMembersText, formatDate, formatDateTime, formatShortDate, inactiveDays, inactiveNote, inFilter, isConnected, memberFilters, memberFlag, memberLastUsed, memberRows, offRosterNote, pairingNotice, refreshNotice, requestRow, revokeMessage, rosterLimitedNote, searchMatches, uncertainBanner, visibleMembers,
  type AdminSection, type Device, type MemberFilter, type MemberRow, type DeviceList, type LoggedRequest, type RequestLogPage, type SetupStatus,
} from "./part-requests-model.ts";
import { ConfirmDialog, Field, fieldAria, LoadState, Notice, Pill } from "./part-requests-ui";

export function PartRequestsSettings({ openSetup }: { openSetup: () => void }) {
  const { path, search, navigate } = usePath();
  const section = adminSection(new URLSearchParams(search).get("section"));
  const hrefFor = (id: AdminSection) => settingsSectionHref(path, search, id);
  const { status, setStatus, error, loading, load } = useSetupStatus();
  // Each tab shows fresh facts when it opens. The hook has already loaded them for the first one.
  const opened = useRef(section);
  useEffect(() => { if (opened.current !== section) { opened.current = section; void load(); } }, [section]);
  return <section className="settings-page" aria-labelledby="part-requests-title">
    <div className="page-intro"><h1 id="part-requests-title">Part Requests</h1></div>
    <div className="settings-section-toolbar">
      <SettingsSectionNavigation label="Part Requests sections" pickerLabel="Part Requests section" sections={adminSections.map(([id, title]) => [hrefFor(id), title] as [string, string])} currentHref={hrefFor(section)} navigate={navigate} />
    </div>
    <div className="pr-stack">
      <LoadState loading={loading && !status} error={error} label="Part Requests" onRetry={() => void load()} />
      {status && section === "connection" && <>
        <ConnectionCard status={status} onStatus={setStatus} openSetup={openSetup} />
        <ConnectionDetails status={status} reload={() => load()} onStatus={setStatus} />
      </>}
      {status && section === "requests" && <RequestsLog databaseId={status.databaseId} />}
      {section === "devices" && <PairedDevices />}
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

function MemberListRow({ row, limit, search, open, onToggle, onRevoke }: { row: MemberRow; limit: number; search: string; open: boolean; onToggle: () => void; onRevoke: (device: Device) => void }) {
  const flag = memberFlag(row, limit);
  const matches = searchMatches(row, search);
  const cells = <>
    <span className="pr-member-name">{row.name}{matches.length > 0 && <span className="pr-row-note">Matches {matches.join(", ")}</span>}</span>
    <span className="pr-member-flag">{flag && <Pill badge={flag} />}</span>
    <span className="pr-member-meta"><span className="pr-member-count">{row.working.length} of {limit} devices</span><span className="pr-member-last">{memberLastUsed(row)}</span></span>
  </>;
  if (!row.devices.length) return <li><div className="pr-member-row">{cells}</div></li>;
  const panel = `pr-member-${row.id}`;
  return <li>
    <button className="pr-member-row" type="button" aria-expanded={open} aria-controls={panel} onClick={onToggle}>{cells}<span className="pr-member-sign" aria-hidden="true" /></button>
    <div className="pr-member-panel" id={panel} hidden={!open}>{open && <>
      {!row.active && <p className="field-help">{offRosterNote(row)}</p>}
      {row.idleDays >= inactiveDays && <p className="field-help">{inactiveNote}</p>}
      <div className="responsive-table"><table className="ui-table pr-table pr-devices">
        <caption className="visually-hidden">{row.name}'s devices</caption>
        <thead><tr><th scope="col">Device</th><th scope="col">Paired</th><th scope="col">Last used</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
        <tbody>{row.devices.map((device) => <tr key={device.id} data-revoked={device.revokedMs !== null ? "true" : undefined}>
          <td data-label="Device">{device.label}</td>
          <td data-label="Paired">{formatDate(device.createdMs)}</td>
          <td data-label="Last used">{device.lastUsedMs ? formatDateTime(device.lastUsedMs) : "Never"}</td>
          <td className="pr-device-action" data-label="Action">{device.revokedMs !== null
            ? <Pill badge={{ label: `Revoked ${formatShortDate(device.revokedMs)}`, tone: "neutral" }} />
            : <button className="ui-button ui-button--danger" type="button" aria-label={`Revoke ${row.name}'s ${device.label}`} onClick={() => onRevoke(device)}>Revoke</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </>}</div>
  </li>;
}

function PairedDevices() {
  const [list, setList] = useState<DeviceList>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Device>();
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [revoked, setRevoked] = useState<{ text: string; key: number }>();
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const searchField = useRef<HTMLInputElement>(null);
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
  const limit = list?.limitPerMember ?? 5;
  const rows = useMemo(() => list ? memberRows(list, Date.now()) : [], [list]);
  const summary = deviceSummary(rows);
  const shown = visibleMembers(rows, filter, search, limit);
  const toggle = (id: string) => setExpanded((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return <>
    {revoked
      ? <Notice notice={{ tone: "success", content: revoked.text }} focusKey={revoked.key} />
      : <p className="ui-status settings-notice pr-notice" role="status">Members pair a device by running <code>/ordering-pin</code> in Discord, which privately replies with the site address and a PIN to enter in the extension. Each member can have up to {limit} devices.</p>}
    <LoadState loading={loading && !list} error={error} label="paired devices" onRetry={() => void load()} />
    {list && <section className="ui-card pr-stack" aria-labelledby="pr-devices-title">
      <div className="pr-card-heading"><h2 id="pr-devices-title">Paired devices</h2></div>
      <dl className="pr-summary">
        <div><dt>Members paired</dt><dd className="pr-summary-value">{summary.paired}</dd><dd className="pr-summary-note">of {summary.onRoster} on the active roster</dd></div>
        <div><dt>Devices</dt><dd className="pr-summary-value">{summary.devices}</dd><dd className="pr-summary-note">{summary.offRosterDevices} {summary.offRosterDevices === 1 ? "is" : "are"} off roster and {summary.offRosterDevices === 1 ? "has" : "have"} no access</dd></div>
        <div><dt>Members with none</dt><dd className="pr-summary-value">{summary.none}</dd><dd className="pr-summary-note">on the roster, no working device</dd></div>
      </dl>
      {list.rosterLimited && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">{rosterLimitedNote}</p>}
      <Field id="pr-device-search" label="Search by name or device"><input {...fieldAria("pr-device-search", undefined, false)} ref={searchField} className="ui-control" type="search" autoComplete="off" spellCheck={false} maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
      <div className="pr-chips" role="group" aria-label="Filter members">{memberFilters.map(([id, label]) =>
        <button className="pr-chip" type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} <span className="pr-chip-count">{rows.filter((row) => inFilter(row, id, limit)).length}</span></button>)}</div>
      {filter === "idle" && <p className="field-help pr-notice">{inactiveNote}</p>}
      <p className="pr-result-count" role="status">Showing {shown.length} of {rows.length} members, {filter === "idle" ? "longest idle first." : "by name."}</p>
      {shown.length > 0
        ? <ul className="pr-member-list">{shown.map((row) => <MemberListRow key={row.id} row={row} limit={limit} search={search} open={expanded.has(row.id)} onToggle={() => toggle(row.id)} onRevoke={(device) => { setRevokeError(""); setTarget(device); }} />)}</ul>
        : <div className="pr-member-list pr-empty-actions">
          <p>{emptyMembersText(filter, search, limit)}</p>
          {(filter !== "all" || search.trim() !== "") && <button className="ui-button" type="button" onClick={() => { setFilter("all"); setSearch(""); searchField.current?.focus(); }}>Clear filters</button>}
        </div>}
    </section>}
    {target && <ConfirmDialog title={`Revoke ${target.label}?`} message={revokeMessage(target)} keepLabel="Keep device" confirmLabel="Revoke device" busy={busy} error={revokeError} onConfirm={() => void revoke()} onClose={() => setTarget(undefined)} />}
  </>;
}

function CartsCard({ status, onStatus }: { status: SetupStatus; onStatus: (status: SetupStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(enabled: boolean) {
    setBusy(true); setError("");
    try { onStatus(await request<SetupStatus>(`${setupRoute}/carts`, "PUT", { enabled })); }
    catch (caught) { setError(errorText(caught, "Carts could not be changed.")); }
    finally { setBusy(false); }
  }
  return <section className="ui-card pr-stack pr-connection-wide" aria-labelledby="pr-carts-title">
    <div className="pr-card-heading"><h2 id="pr-carts-title">Carts</h2><Pill badge={status.cartsEnabled ? { label: "On", tone: "success" } : { label: "Off", tone: "neutral" }} /></div>
    {error && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{error}</p>}
    <label className="pr-choice"><input type="checkbox" role="switch" checked={status.cartsEnabled} disabled={busy} aria-describedby="pr-carts-help" onChange={(event) => void save(event.target.checked)} /><span>Let paired devices use Carts</span></label>
    <p id="pr-carts-help" className="field-help pr-notice">Carts shows every paired device the team's open orders, with requester names and prices, to fill store carts. It never checks out. Turning this off stops that at once; sending requests is not affected.</p>
  </section>;
}

/** The rest of the Connection tab, below the Notion card: the recipient list, pairing and Carts. */
function ConnectionDetails({ status, reload, onStatus }: { status: SetupStatus; reload: () => Promise<void>; onStatus: (status: SetupStatus) => void }) {
  const connected = isConnected(status);
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
  const refreshProblem = refreshNotice(status.refresh);
  const pauseNotice = pairingNotice(status.pairingPausedUntilMs);
  return <div className="pr-connection-grid">
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

    <CartsCard status={status} onStatus={onStatus} />
  </div>;
}
