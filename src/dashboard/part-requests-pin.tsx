// Generate pairing PIN, from Paired devices: an Admin makes the same PIN /ordering-pin makes, for a member without Discord.
// The PIN lives only in this dialog's state, so it goes when the dialog closes, and a timer removes it when it expires.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useModalFocus } from "@lancerlogin/module-sdk/dashboard";
import { adminRoute, errorText, request } from "./part-requests-http.ts";
import {
  pinCandidates, pinCopied, pinCopyFailed, pinExpiredText, pinExpiryText, pinInstructions, pinIntro, pinLifetimeMs, pinMemberAtLimit, pinMoreMatches, pinNoMatches, pinPairedNote,
  pinResultTitle, pinSearchLabel, pinShareText, pinShownOnceNote, type IssuedPin, type MemberRow,
} from "./part-requests-model.ts";
import { Field, fieldAria, Notice, Pill } from "./part-requests-ui";

type Shown = IssuedPin & { readonly hideAtMs: number };

export function GeneratePinDialog({ rows, limit, onClose }: { rows: readonly MemberRow[]; limit: number; onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const [search, setSearch] = useState("");
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<Shown>();
  const [expired, setExpired] = useState(false);
  const [copy, setCopy] = useState<{ ok: boolean; key: number }>();
  const searchField = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const close = () => { if (!busy) onClose(); };
  useModalFocus(dialog, true, busy, close);
  // The button that was pressed goes away with each switch, so focus moves to where the next step starts.
  const switched = useRef(false);
  useEffect(() => { if (!switched.current) { switched.current = true; return; } (shown ? copyButton.current : searchField.current)?.focus(); }, [Boolean(shown)]);

  // Removes the PIN from the screen once it can no longer work.
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => { setShown(undefined); setCopy(undefined); setExpired(true); }, Math.max(0, shown.hideAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [shown]);

  const candidates = pinCandidates(rows, search, limit);
  const chosen = rows.find((row) => row.id === memberId);

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    if (!memberId) return;
    // Counted from before the request, so the page never shows a PIN past the Worker's 10 minutes.
    const asked = Date.now();
    setBusy(true); setError(""); setExpired(false); setCopy(undefined);
    try {
      const issued = await request<IssuedPin>(`${adminRoute}/pins`, "POST", { memberId });
      setShown({ ...issued, hideAtMs: asked + pinLifetimeMs });
    } catch (caught) { setError(errorText(caught, "The PIN could not be generated.")); }
    finally { setBusy(false); }
  }
  function copyPin() {
    if (!shown) return;
    void navigator.clipboard.writeText(pinShareText(shown)).then(() => setCopy({ ok: true, key: Date.now() }), () => setCopy({ ok: false, key: Date.now() }));
  }
  const another = () => { setShown(undefined); setExpired(false); setCopy(undefined); setError(""); };

  return <div className="dialog-backdrop">
    <section ref={dialog} className="ui-dialog pr-dialog pr-pin-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}title`} aria-describedby={`${id}intro`} tabIndex={-1}>
      <div className="dialog-heading">
        <h2 id={`${id}title`}>Generate pairing PIN</h2>
        <button className="ui-button" type="button" aria-label="Close" disabled={busy} onClick={close}><span aria-hidden="true">×</span></button>
      </div>
      {shown ? <div className="pr-stack">
        <h3 className="pr-pin-member">{pinResultTitle(shown.memberName)}</h3>
        <div className="pairing-code pr-pin-code" role="group" aria-label="Pairing PIN">
          <span>Pairing PIN</span>
          <strong className="pr-pin-value">{shown.pin}</strong>
          <small>{pinExpiryText(shown.hideAtMs)}</small>
        </div>
        <dl className="pr-facts">
          <div><dt>Site address</dt><dd className="pr-pin-site">{shown.siteAddress}</dd></div>
        </dl>
        <p id={`${id}intro`}>{pinInstructions}</p>
        {shown.pairedDevices > 0 && <p className="field-help pr-notice">{pinPairedNote(shown.pairedDevices, limit)}</p>}
        <p className="field-help pr-notice">{pinShownOnceNote}</p>
        {copy && <Notice notice={{ tone: copy.ok ? "success" : "error", content: copy.ok ? pinCopied : pinCopyFailed }} />}
        <div className="dialog-actions">
          <button className="ui-button" type="button" onClick={another}>Generate another</button>
          <button className="ui-button" type="button" onClick={close}>Done</button>
          <button className="ui-button ui-button--primary" type="button" ref={copyButton} onClick={copyPin}>Copy</button>
        </div>
      </div> : <form className="pr-stack" onSubmit={(event) => void generate(event)}>
        <p id={`${id}intro`}>{pinIntro}</p>
        {expired && <Notice notice={{ tone: "warning", content: pinExpiredText }} focusKey={expired} />}
        <Field id={`${id}search`} label={pinSearchLabel}>
          <input {...fieldAria(`${id}search`, undefined, false)} ref={searchField} className="ui-control" type="search" autoComplete="off" spellCheck={false} maxLength={200} value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} data-modal-initial-focus />
        </Field>
        <fieldset className="pr-field pr-pin-picker">
          <legend className="visually-hidden">Member</legend>
          {candidates.shown.length > 0
            ? <ul className="pr-member-list">{candidates.shown.map((member) => <li key={member.id}>
              <label className="pr-pin-option" data-disabled={member.atLimit ? "true" : undefined}>
                <input type="radio" name={`${id}member`} value={member.id} checked={memberId === member.id} disabled={busy || member.atLimit} aria-describedby={member.atLimit ? `${id}limit-${member.id}` : undefined} onChange={() => { setMemberId(member.id); setError(""); }} />
                <span className="pr-member-name">{member.name}</span>
                {member.atLimit && <span className="pr-pin-limit"><Pill badge={{ label: "At the limit", tone: "warning" }} /><span id={`${id}limit-${member.id}`} className="pr-row-note">{pinMemberAtLimit(limit)}</span></span>}
              </label>
            </li>)}</ul>
            : <p className="pr-member-list pr-empty-actions">{pinNoMatches(search)}</p>}
          {candidates.total > candidates.shown.length && <p className="pr-result-count">{pinMoreMatches(candidates.shown.length, candidates.total)}</p>}
        </fieldset>
        {chosen && <p className="pr-result-count" role="status">Chosen: <strong>{chosen.name}</strong></p>}
        {error && <p className="ui-status settings-notice pr-notice" data-tone="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ui-button" type="button" disabled={busy} onClick={close}>Cancel</button>
          <button className="ui-button ui-button--primary" type="submit" disabled={busy || !chosen}>{busy ? "Generating..." : "Generate"}</button>
        </div>
      </form>}
    </section>
  </div>;
}
