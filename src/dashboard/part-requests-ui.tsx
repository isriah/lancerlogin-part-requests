// Small pieces the Admin pages share, built on Core's dashboard classes: labelled fields, notices, status pills and a
// confirmation dialog whose focus starts on the safe choice.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useModalFocus } from "@lancerlogin/module-sdk/dashboard";
import type { Badge } from "./part-requests-model.ts";

export function Pill({ badge }: { badge: Badge }) {
  return badge.tone === "neutral"
    ? <span className="status-pill ui-status pr-pill-neutral">{badge.label}</span>
    : <span className="status-pill ui-status" data-tone={badge.tone}>{badge.label}</span>;
}

/** The id, `aria-invalid` and `aria-describedby` of a control with optional help and error text. */
export function fieldAria(id: string, error: string | undefined, help = true) {
  const describedBy = [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy || undefined } as const;
}

export function Field({ id, label, help, error, children }: { id: string; label: string; help?: string; error?: string | undefined; children: ReactNode }) {
  return <div className="pr-field" data-invalid={error ? "true" : undefined}>
    <label htmlFor={id}>{label}</label>
    {children}
    {help && <span id={`${id}-help`} className="field-help">{help}</span>}
    {error && <span id={`${id}-error`} className="field-help pr-field-error">{error}</span>}
  </div>;
}

export type NoticeValue = { readonly tone?: "success" | "warning" | "error"; readonly content: ReactNode };

/** A status line. `focusKey` moves focus to it when it changes, for a result the person needs to meet at once. */
export function Notice({ notice, focusKey, action }: { notice: NoticeValue; focusKey?: unknown; action?: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (focusKey) ref.current?.focus(); }, [focusKey]);
  return <p ref={ref} tabIndex={-1} className={`ui-status settings-notice pr-notice${action ? " pr-notice-action" : ""}`} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
    {action ? <span>{notice.content}</span> : notice.content}{action}
  </p>;
}

/** A loading or failure line for a section, with Try again after a failure. */
export function LoadState({ loading, error, label, onRetry }: { loading: boolean; error: string; label: string; onRetry: () => void }) {
  if (error) return <Notice notice={{ tone: "error", content: error }} action={<button className="ui-button" type="button" onClick={onRetry}>Try again</button>} />;
  return loading ? <p className="ui-status settings-notice pr-notice" role="status">Loading {label}...</p> : null;
}

/** A confirmation for something that cannot be undone from here. Focus starts on the choice that changes nothing. */
export function ConfirmDialog({ title, message, keepLabel, confirmLabel, busy, error, onConfirm, onClose }: {
  title: string; message: string; keepLabel: string; confirmLabel: string; busy: boolean; error: string; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const id = useId();
  const close = () => { if (!busy) onClose(); };
  useModalFocus(dialog, true, busy, close);
  return <div className="dialog-backdrop">
    <section ref={dialog} className="ui-dialog pr-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}title`} aria-describedby={`${id}body`} tabIndex={-1}>
      <div className="dialog-heading">
        <h2 id={`${id}title`}>{title}</h2>
        <button className="ui-button" type="button" aria-label="Close" disabled={busy} onClick={close}><span aria-hidden="true">×</span></button>
      </div>
      <div className="pr-stack">
        <p id={`${id}body`}>{message}</p>
        {error && <p className="ui-status settings-notice" data-tone="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="ui-button" type="button" disabled={busy} onClick={close} data-modal-initial-focus>{keepLabel}</button>
          <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={onConfirm}>{busy ? "Working..." : confirmLabel}</button>
        </div>
      </div>
    </section>
  </div>;
}
