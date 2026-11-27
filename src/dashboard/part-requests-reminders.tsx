// Settings > Part Requests > Reminders, Admin only: stale-request reminders. Reminders always use the ordering database chosen
// on the Connection tab; this tab checks its layout for reminders, places Core's picker for the optional People database,
// holds the schedule and thresholds, previews a run without sending anything, and shows the last run.
import { useEffect, useId, useState, type FormEvent } from "react";
import { NotionBindingField } from "@lancerlogin/module-sdk/dashboard";
import { errorText, request, RequestError } from "./part-requests-http.ts";
import { formatDateTime, notionPageLink } from "./part-requests-model.ts";
import {
  daysToMinutes, durationLabel, lastRunSummary, minutesToDays, peopleBadge, peopleNote, reminderProblemText, remindersBadge, remindersRoute, scheduleText, skipText, stepText, testingThreshold, testingThresholdNote,
  unpingedText, weekdayNames, type PreviewResult, type RemindersView, type RequestLink,
} from "./part-requests-reminders-model.ts";
import { Field, fieldAria, LoadState, Notice, Pill, type NoticeValue } from "./part-requests-ui";

export function RemindersTab() {
  const [view, setView] = useState<RemindersView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    setError(""); setLoading(true);
    try { setView(await request<RemindersView>(remindersRoute)); }
    catch (caught) { setError(errorText(caught, "Reminders could not be loaded.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return <>
    <LoadState loading={loading && !view} error={error} label="reminders" onRetry={() => void load()} />
    {view && <>
      <StatusCard view={view} onView={setView} reload={load} />
      <SettingsCard key={view.settings.revision} view={view} onView={setView} />
      <PeopleCard view={view} onView={setView} reload={load} />
      {view.lastRun && <LastRunCard view={view} />}
    </>}
  </>;
}

function RequestList({ items, empty }: { items: readonly (RequestLink & { note?: string })[]; empty?: string }) {
  if (!items.length) return empty ? <p className="field-help pr-notice">{empty}</p> : null;
  return <ul className="pr-run-list">{items.map((item, index) => {
    const link = notionPageLink(item.pageUrl);
    return <li key={`${item.pageUrl}-${index}`}>
      {link ? <a href={link} target="_blank" rel="noopener noreferrer">{item.description || "(no description)"}<span aria-hidden="true"> ↗</span><span className="visually-hidden"> in Notion, new tab</span></a> : item.description}
      {item.note && <span className="pr-row-note">{item.note}</span>}
    </li>;
  })}</ul>;
}

function StatusCard({ view, onView, reload }: { view: RemindersView; onView: (view: RemindersView) => void; reload: () => Promise<void> }) {
  const ids = useId();
  const [busy, setBusy] = useState<"" | "verify" | "preview" | "run">("");
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  const [preview, setPreview] = useState<PreviewResult>();
  const problem = reminderProblemText(view.problem, undefined, view.problemMs);
  const comment = view.core.capabilities.comment; const update = view.core.capabilities.update;
  const canCheck = !busy && view.core.ordersBound && view.core.connected;
  const canPreview = !busy && view.targetVerified;
  const canSend = !busy && view.settings.enabled && view.targetVerified && !view.activeRun;
  // One primary button per row, and never a disabled one: the next step an Admin should take.
  const primary: "verify" | "run" | "" = !view.targetVerified ? (canCheck ? "verify" : "") : canSend ? "run" : "";
  const buttonClass = (kind: "verify" | "preview" | "run") => `ui-button${primary === kind ? " ui-button--primary" : ""}`;

  async function act(kind: "verify" | "preview" | "run") {
    if (busy) return;
    setBusy(kind); setResult(undefined);
    try {
      if (kind === "verify") {
        const next = await request<RemindersView>(`${remindersRoute}/verify`, "POST", {});
        onView(next);
        setResult({ notice: { tone: "success", content: `Checked ${next.target?.dataSourceName ?? "the ordering database"} for reminders.` }, key: Date.now() });
      } else if (kind === "preview") {
        setPreview(await request<PreviewResult>(`${remindersRoute}/preview`, "POST"));
      } else {
        await request(`${remindersRoute}/run`, "POST");
        setResult({ notice: { tone: "success", content: "Reminders are being sent, one step at a time. The last run below updates when it finishes." }, key: Date.now() });
        await reload();
      }
    } catch (caught) { setResult({ notice: { tone: "error", content: errorText(caught, "That did not work. Try again.") }, key: Date.now() }); }
    finally { setBusy(""); }
  }

  return <section className="ui-card pr-stack" aria-labelledby={`${ids}title`}>
    <div className="pr-card-heading"><h2 id={`${ids}title`}>Stale-request reminders</h2><Pill badge={remindersBadge(view)} /></div>
    <p className="field-help pr-notice">On the chosen days, every Incomplete Request in the ordering database older than the threshold gets a Notion comment mentioning its Orderer/Recipient and a Discord message pinging them, then its Reminder sent date is set so it is not reminded again until the cooldown passes. Requests themselves are never changed or ordered.</p>
    {problem && <Notice notice={{ tone: "error", content: problem }} />}
    {view.target?.schemaError && <Notice notice={{ tone: "error", content: view.target.schemaError }} />}
    {(comment === "refused" || update === "refused") && <Notice notice={{ tone: "warning", content: `Core's Notion connection lacks ${[comment === "refused" ? "Insert comments" : "", update === "refused" ? "Update content" : ""].filter(Boolean).join(" and ")}. Turn ${comment === "refused" && update === "refused" ? "them" : "it"} on in the connection's Capabilities in Notion's integration settings.` }} />}
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    <dl className="pr-facts">
      <div><dt>Ordering database</dt><dd>{!view.core.ordersBound ? "Not chosen" : view.targetVerified ? `${view.target?.dataSourceName || "Checked"}, checked ${formatDateTime(view.target!.verifiedMs!)}` : view.target && !view.target.current ? "Changed in Core, check again" : "Not checked for reminders"}</dd></div>
      <div><dt>Schedule</dt><dd>{scheduleText(view.settings)}{view.timeZone ? ` (${view.timeZone})` : ""}</dd></div>
      <div><dt>Next run</dt><dd>{view.activeRun ? "Running now" : view.nextRunMs ? formatDateTime(view.nextRunMs) : view.settings.enabled ? "Not scheduled" : "Reminders are off"}</dd></div>
      <div><dt>Threshold and cooldown</dt><dd>{durationLabel(view.settings.staleMinutes)}, then {durationLabel(view.settings.cooldownMinutes)}</dd></div>
    </dl>
    <div className="module-actions pr-actions">
      <button className={buttonClass("verify")} type="button" disabled={!canCheck} onClick={() => void act("verify")}>{busy === "verify" ? "Checking..." : view.targetVerified ? "Check again" : "Check ordering database"}</button>
      <button className={buttonClass("preview")} type="button" disabled={!canPreview} onClick={() => void act("preview")}>{busy === "preview" ? "Reading Notion..." : "Preview"}</button>
      <button className={buttonClass("run")} type="button" disabled={!canSend} onClick={() => void act("run")}>{busy === "run" ? "Starting..." : "Send reminders now"}</button>
    </div>
    {preview && <PreviewList preview={preview} />}
  </section>;
}

function PreviewList({ preview }: { preview: PreviewResult }) {
  return <div className="pr-stack" role="region" aria-label="Preview">
    <p className="ui-status settings-notice pr-notice" role="status">Preview only: nothing was sent or changed. {preview.requests.length ? `${preview.requests.length} stale ${preview.requests.length === 1 ? "request" : "requests"}${preview.more ? " shown; more exist" : ""}.` : "No stale requests right now."}{preview.source === "people" ? " Pings use the People database." : " Pings use default recipients."}{preview.peopleIncomplete ? " Only the first 100 People rows were read for this preview." : ""}</p>
    {preview.requests.length > 0 && <div className="responsive-table"><table className="ui-table pr-table">
      <thead><tr><th scope="col">Request</th><th scope="col">Created</th><th scope="col">People</th><th scope="col">Outcome</th></tr></thead>
      <tbody>{preview.requests.map((row, index) => {
        const link = notionPageLink(row.pageUrl);
        return <tr key={`${row.pageUrl}-${index}`}>
          <th scope="row">{link ? <a href={link} target="_blank" rel="noopener noreferrer">{row.description || "(no description)"}<span aria-hidden="true"> ↗</span><span className="visually-hidden"> in Notion, new tab</span></a> : row.description}</th>
          <td data-label="Created">{formatDateTime(row.createdMs)}</td>
          <td data-label="People">{row.people.length ? <span className="pr-cell-lines">{row.people.map((person, position) => <span key={position}>{person.name}{person.ping ? ", pinged" : `, no ping: ${unpingedText(person.reason ?? "")}`}</span>)}</span> : "Nobody"}</td>
          <td data-label="Outcome">{skipText(row.skipReason)}</td>
        </tr>;
      })}</tbody>
    </table></div>}
  </div>;
}

function SettingsCard({ view, onView }: { view: RemindersView; onView: (view: RemindersView) => void }) {
  const ids = useId();
  const initial = view.settings;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [weekdays, setWeekdays] = useState<readonly number[]>(initial.weekdays);
  const [runTime, setRunTime] = useState(initial.runTime);
  const [staleMinutes, setStaleMinutes] = useState(initial.staleMinutes);
  const [cooldownMinutes, setCooldownMinutes] = useState(initial.cooldownMinutes);
  const [staleDays, setStaleDays] = useState(minutesToDays(initial.staleMinutes));
  const [cooldownDays, setCooldownDays] = useState(minutesToDays(initial.cooldownMinutes));
  const [channel, setChannel] = useState(initial.discordChannelId ?? "");
  const [peopleKey, setPeopleKey] = useState(initial.peopleKey);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  const toggleDay = (day: number) => setWeekdays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setErrors({}); setResult(undefined);
    try {
      const next = await request<RemindersView>(`${remindersRoute}/settings`, "PUT", {
        revision: initial.revision, enabled, weekdays, runTime, staleMinutes, cooldownMinutes, discordChannelId: channel.trim() || null, peopleKey,
      });
      onView(next);
    } catch (caught) {
      const fields = caught instanceof RequestError && caught.errors && Object.keys(caught.errors).length ? caught.errors : undefined;
      if (fields) setErrors({ ...fields });
      setResult({ notice: { tone: "error", content: fields ? "Check the highlighted fields." : errorText(caught, "Reminder settings could not be saved.") }, key: Date.now() });
    } finally { setBusy(false); }
  }
  const days = (text: string, set: (minutes: number) => void, setText: (text: string) => void) => { setText(text); const minutes = daysToMinutes(text); if (minutes !== undefined) set(minutes); };
  // A threshold that is not whole days leaves the days field empty, so it says where the value is instead, and Advanced starts open.
  const inMinutes = (minutes: number) => minutesToDays(minutes) ? undefined : testingThresholdNote(minutes);
  const [advancedOpen, setAdvancedOpen] = useState(!minutesToDays(initial.staleMinutes) || !minutesToDays(initial.cooldownMinutes));

  return <form className="ui-card pr-stack" aria-labelledby={`${ids}title`} onSubmit={(event) => void save(event)} noValidate>
    <div className="pr-card-heading"><h2 id={`${ids}title`}>Settings</h2></div>
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    <div className="pr-field pr-switch-field">
      <label className="pr-choice"><input type="checkbox" role="switch" checked={enabled} disabled={busy || (!view.targetVerified && !enabled)} aria-describedby={`${ids}enabled-help`} onChange={(event) => setEnabled(event.target.checked)} /><span>Send stale-request reminders</span></label>
      <span id={`${ids}enabled-help`} className="field-help">{view.targetVerified ? "Turning this off stops a run in progress. Sending requests is never affected." : "Check the ordering database for reminders first."}</span>
    </div>
    <div className="pr-field" data-invalid={errors.weekdays ? "true" : undefined}>
      <span id={`${ids}days-label`} className="pr-field-label">Days</span>
      <div className="pr-chips" role="group" aria-labelledby={`${ids}days-label`} aria-describedby={errors.weekdays ? `${ids}days-error` : undefined}>{weekdayNames.map(([day, name]) =>
        <button className="pr-chip" type="button" key={day} aria-pressed={weekdays.includes(day)} disabled={busy} onClick={() => toggleDay(day)}>{name}</button>)}</div>
      {errors.weekdays && <span id={`${ids}days-error`} className="field-help pr-field-error">{errors.weekdays}</span>}
    </div>
    <Field id={`${ids}time`} label="Time" help={`In the installation's time zone${view.timeZone ? `, ${view.timeZone}` : ""}.`} error={errors.runTime}>
      <input {...fieldAria(`${ids}time`, errors.runTime)} className="ui-control" type="time" step={60} required value={runTime} disabled={busy} onChange={(event) => setRunTime(event.target.value)} />
    </Field>
    <Field id={`${ids}stale`} label="Remind after (days)" help={inMinutes(staleMinutes) ?? "How long a request can stay an Incomplete Request before its people are reminded."} error={errors.staleMinutes}>
      <input {...fieldAria(`${ids}stale`, errors.staleMinutes)} className="ui-control" type="number" min={1} max={30} step={1} inputMode="numeric" placeholder={staleDays ? undefined : "Testing threshold"} value={staleDays} disabled={busy} onChange={(event) => days(event.target.value, setStaleMinutes, setStaleDays)} />
    </Field>
    <Field id={`${ids}cooldown`} label="Remind again after (days)" help={inMinutes(cooldownMinutes) ?? "The shortest time between two reminders for the same request."} error={errors.cooldownMinutes}>
      <input {...fieldAria(`${ids}cooldown`, errors.cooldownMinutes)} className="ui-control" type="number" min={1} max={30} step={1} inputMode="numeric" placeholder={cooldownDays ? undefined : "Testing threshold"} value={cooldownDays} disabled={busy} onChange={(event) => days(event.target.value, setCooldownMinutes, setCooldownDays)} />
    </Field>
    <details className="settings-disclosure" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
      <summary>Advanced (testing)</summary>
      <div className="pr-stack">
        <Field id={`${ids}stale-minutes`} label="Remind after (minutes)" help="For testing on a sandbox. Below one day, every Incomplete Request becomes stale almost at once.">
          <input {...fieldAria(`${ids}stale-minutes`, undefined)} className="ui-control" type="number" min={1} max={43200} step={1} inputMode="numeric" value={staleMinutes} disabled={busy} onChange={(event) => { const value = Number(event.target.value); setStaleMinutes(value); setStaleDays(minutesToDays(value)); }} />
        </Field>
        <Field id={`${ids}cooldown-minutes`} label="Remind again after (minutes)">
          <input {...fieldAria(`${ids}cooldown-minutes`, undefined, false)} className="ui-control" type="number" min={1} max={43200} step={1} inputMode="numeric" value={cooldownMinutes} disabled={busy} onChange={(event) => { const value = Number(event.target.value); setCooldownMinutes(value); setCooldownDays(minutesToDays(value)); }} />
        </Field>
        {(testingThreshold(staleMinutes) || testingThreshold(cooldownMinutes)) && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">A threshold below one day is for testing only. Don't use it on the live ordering database.</p>}
      </div>
    </details>
    <Field id={`${ids}channel`} label="Discord channel ID" help="The channel reminders are posted in. In Discord, right-click the channel and choose Copy Channel ID. Needed while reminders are on." error={errors.discordChannelId}>
      <input {...fieldAria(`${ids}channel`, errors.discordChannelId)} className="ui-control" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={20} value={channel} disabled={busy} onChange={(event) => setChannel(event.target.value.replace(/\D/g, ""))} />
    </Field>
    <Field id={`${ids}key`} label="People database member ID" help="Which ID the People database's LancerLogin member ID column holds." error={errors.peopleKey}>
      <select {...fieldAria(`${ids}key`, errors.peopleKey)} className="ui-control" value={peopleKey} disabled={busy} onChange={(event) => setPeopleKey(event.target.value as "external_id" | "id")}>
        <option value="external_id">Typed member ID (recommended)</option>
        <option value="id">Internal LancerLogin ID</option>
      </select>
    </Field>
    <div className="module-actions pr-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save settings"}</button></div>
  </form>;
}

function PeopleCard({ view, onView, reload }: { view: RemindersView; onView: (view: RemindersView) => void; reload: () => Promise<void> }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ notice: NoticeValue; key: number }>();
  async function act(method: "POST" | "DELETE") {
    if (busy) return;
    setBusy(true); setResult(undefined);
    try {
      const next = await request<RemindersView>(`${remindersRoute}/people${method === "POST" ? "/verify" : ""}`, method, method === "POST" ? {} : undefined);
      onView(next);
      setResult({ notice: { tone: "success", content: method === "POST" ? `Checked ${next.people?.dataSourceName ?? "the People database"}.` : "Reminders no longer use the People database." }, key: Date.now() });
    } catch (caught) { setResult({ notice: { tone: "error", content: errorText(caught, "That did not work. Try again.") }, key: Date.now() }); }
    finally { setBusy(false); }
  }
  const usable = Boolean(view.people && view.people.current && !view.people.error);
  // Core's picker brings its own card, heading, description and pill; this card's heading and pill stand for both (see the CSS).
  return <section className="ui-card pr-stack pr-people" aria-labelledby={`${ids}title`}>
    <div className="pr-card-heading"><h2 id={`${ids}title`}>People database</h2><Pill badge={peopleBadge(view)} /></div>
    <p className="field-help pr-notice">Optional and read only. Reminders look up each Notion person's LancerLogin member ID in it (columns Notion account, LancerLogin member ID and Active) to find who to ping in Discord. Part Requests never writes to it.</p>
    {result && <Notice notice={result.notice} focusKey={result.key} />}
    <p className="ui-status settings-notice pr-notice" data-tone={usable ? "success" : view.people?.error || (view.people && !view.people.current) ? "warning" : undefined} role="status">{peopleNote(view)}</p>
    {view.core.connected && <NotionBindingField moduleId="part-requests" bindingId="people" onChanged={(bound) => { if (bound !== view.core.peopleBound) void reload(); }} />}
    <div className="module-actions pr-actions">
      <button className={`ui-button${view.core.peopleBound && !usable && !busy ? " ui-button--primary" : ""}`} type="button" disabled={busy || !view.core.peopleBound} onClick={() => void act("POST")}>{busy ? "Checking..." : view.people ? "Check People again" : "Check People"}</button>
      {view.people && <button className="ui-button" type="button" disabled={busy} onClick={() => void act("DELETE")}>Stop using People</button>}
    </div>
  </section>;
}

function LastRunCard({ view }: { view: RemindersView }) {
  const ids = useId();
  const run = view.lastRun!;
  const counts = run.counts;
  return <section className="ui-card pr-stack" aria-labelledby={`${ids}title`}>
    <div className="pr-card-heading"><h2 id={`${ids}title`}>Last run</h2><Pill badge={run.state === "done" ? { label: "Finished", tone: "success" } : { label: "Stopped", tone: run.errorCode === "disabled" ? "neutral" : "error" }} /></div>
    <p className="field-help pr-notice">{lastRunSummary(run)}</p>
    <dl className="pr-summary">
      <div><dt>Reminded</dt><dd className="pr-summary-value">{counts.reminded}</dd><dd className="pr-summary-note">{counts.marked} marked Reminder sent</dd></div>
      <div><dt>Discord</dt><dd className="pr-summary-value">{counts.discordSent}</dd><dd className="pr-summary-note">{counts.discordFailed} failed</dd></div>
      <div><dt>Notion problems</dt><dd className="pr-summary-value">{counts.notionFailed + counts.uncertain}</dd><dd className="pr-summary-note">{counts.uncertain} to check</dd></div>
    </dl>
    {run.truncated && <p className="ui-status settings-notice pr-notice" data-tone="warning" role="status">This run stopped at 200 requests. The rest are reminded on the next run.</p>}
    {run.checkPage.length > 0 && <RunSection title="Check the page" help="Notion did not confirm these comments. Look at each request: if the comment is missing, the next run after the cooldown adds it." items={run.checkPage} />}
    {run.failed.length > 0 && <RunSection title="Not completed" items={run.failed.map((item) => ({ ...item, note: stepText(item.step) }))} />}
    {run.nobody.length > 0 && <RunSection title="Nobody set" help="These have no Orderer/Recipient, so nobody could be reminded." items={run.nobody} />}
    {run.pingSkipped.length > 0 && <RunSection title="Ping skipped" help="These were commented on in Notion, but some people were not pinged in Discord."
      items={run.pingSkipped.map((item) => ({ ...item, note: item.people.map((person) => `${person.name}: ${unpingedText(person.reason)}`).join("; ") }))} />}
  </section>;
}

function RunSection({ title, help, items }: { title: string; help?: string; items: readonly (RequestLink & { note?: string })[] }) {
  return <div className="pr-run-section">
    <h3>{title}</h3>
    {help && <p className="field-help pr-notice">{help}</p>}
    <RequestList items={items} />
  </div>;
}
