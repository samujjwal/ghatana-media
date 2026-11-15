import React from "react";
import {
  DevErasureHostError, describeErasureFailure, parseErasurePlanView, parseErasureReceiptView, parseLegalHoldView, treeRows,
  type DevErasureFailure, type DevErasurePort, type ErasurePlanView, type ErasureReceiptView, type LegalHoldView,
} from "./devErasure";

export interface DevErasurePanelProps {
  readonly erasure: DevErasurePort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};
const asHost = (error: unknown): DevErasureHostError => error instanceof DevErasureHostError ? error
  : new DevErasureHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const KIND_LABEL: Readonly<Record<string, string>> = {
  SOURCE_ARTIFACT: "Source", DERIVED_ARTIFACT: "Derived", SYNTHESIZED_AUDIO: "Synthesized audio", TRANSCRIPT: "Transcript",
  WEBVTT: "WebVTT captions", CAPTION_VERSION: "Corrected caption version", VISION_ANALYSIS: "Vision analysis", VISION_TRACKS: "Vision tracks",
  VISION_ROI: "Vision ROI result", GROUNDED_ANSWER: "Grounded answer", RENDER: "Render or dub", CREATIVE_OUTPUT: "Creative output",
  S3_OBJECT: "Stored object", UPLOAD_CHUNK_OBJECT: "Staged upload chunk", REQUEST_LEDGER_ROW: "Request-ledger replay row",
  DELIVERY_RECORD: "Delivery record", DELIVERED_OBJECT: "Delivered file", REVIEW_RECORD: "Review record", DEV_REVIEW_RECORD: "Review record",
  CAPTION_REGISTRATION: "Caption registration", TRANSCRIPT_REVISION: "Transcript revision", LINEAGE_RECORD: "Lineage record",
  UPLOAD_SESSION: "Upload session", LOCAL_SPOOL_ENTRY: "Local speech spool entry", PROCESS_LEDGER_ROW: "Process ledger row",
  CACHE_TENANT_INVALIDATION: "Cache invalidation",
};
const label = (kind: string): string => KIND_LABEL[kind] ?? kind.replaceAll("_", " ").toLowerCase();
const shortDigest = (digest: string): string => `${digest.slice(0, 12)}…`;

/**
 * DEV_ONLY erasure and legal-hold panel. It previews the exact tree an erasure removes, lets the owner place or release
 * a hold (with a recorded reason), and erases only after an explicit, typed confirmation. Revoking a rights statement is
 * a different act and is stated as such. The receipt lists what was removed by kind and count with the digests of the
 * removed objects; it never shows content.
 */
export function DevErasurePanel({ erasure, locked = false, newRequestId = defaultRequestId }: DevErasurePanelProps): React.ReactElement {
  const id = React.useId();
  const [artifactId, setArtifactId] = React.useState("");
  const [plan, setPlan] = React.useState<ErasurePlanView | null>(null);
  const [receipt, setReceipt] = React.useState<ErasureReceiptView | null>(null);
  const [message, setMessage] = React.useState("Nothing requested.");
  const [failure, setFailure] = React.useState<DevErasureFailure | null>(null);
  const [pending, setPending] = React.useState(false);
  const [holdReason, setHoldReason] = React.useState("");
  const [releaseReasons, setReleaseReasons] = React.useState<Readonly<Record<string, string>>>({});
  const [confirming, setConfirming] = React.useState(false);
  const [understood, setUnderstood] = React.useState(false);
  const [typedId, setTypedId] = React.useState("");
  const [reopenId, setReopenId] = React.useState("");
  const attempt = React.useRef<{ rootArtifactId: string; erasureId: string } | null>(null);
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const dialogHeading = React.useRef<HTMLHeadingElement | null>(null);
  const disabled = locked || pending;

  const refocusTrigger = React.useRef(false);
  React.useEffect(() => {
    if (confirming) dialogHeading.current?.focus();
    else if (refocusTrigger.current) { refocusTrigger.current = false; trigger.current?.focus(); }
  }, [confirming]);

  function fail(error: unknown): void {
    const outcome = describeErasureFailure(asHost(error));
    setFailure(outcome);
    setMessage(`${outcome.code}: ${outcome.text}`);
  }

  async function loadPlan(rootId: string): Promise<ErasurePlanView | null> {
    const response = await erasure.plan(rootId);
    if (response.status !== 200) throw new DevErasureHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
    const parsed = parseErasurePlanView(response.body, { rootArtifactId: rootId });
    setPlan(parsed);
    return parsed;
  }

  async function review(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || !artifactId.trim()) return;
    setPending(true); setFailure(null); setPlan(null); setReceipt(null); setConfirming(false); setUnderstood(false); setTypedId("");
    setMessage("Reading the tree…");
    try {
      const parsed = await loadPlan(artifactId.trim());
      if (parsed) {
        setMessage(parsed.erasable
          ? `${parsed.artifacts.length} artifact${parsed.artifacts.length === 1 ? "" : "s"} would be erased. Review the tree, then erase.`
          : `${parsed.artifacts.length} artifact${parsed.artifacts.length === 1 ? "" : "s"} in this tree; a legal hold blocks erasure.`);
      }
    } catch (error) { fail(error); } finally { setPending(false); }
  }

  async function place(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || !plan || !holdReason.trim()) return;
    setPending(true); setFailure(null);
    setMessage("Placing the legal hold…");
    try {
      const response = await erasure.placeHold({ requestId: newRequestId(), artifactId: plan.rootArtifactId, reason: holdReason.trim() });
      if (response.status !== 200 && response.status !== 201) throw new DevErasureHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const hold = parseLegalHoldView(response.body);
      setHoldReason("");
      await loadPlan(plan.rootArtifactId);
      setMessage(`Legal hold ${hold.holdId} placed by ${hold.placedBy} (${hold.placedIdentityAssurance}). Erasure is blocked until it is released.`);
    } catch (error) { fail(error); } finally { setPending(false); }
  }

  async function release(hold: LegalHoldView): Promise<void> {
    const reason = (releaseReasons[hold.holdId] ?? "").trim();
    if (disabled || !plan || !reason) return;
    setPending(true); setFailure(null);
    setMessage("Releasing the legal hold…");
    try {
      const response = await erasure.releaseHold(hold.holdId, reason);
      if (response.status !== 200) throw new DevErasureHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const released = parseLegalHoldView(response.body);
      await loadPlan(plan.rootArtifactId);
      setMessage(`Legal hold ${released.holdId} released by ${released.releasedBy}: ${released.releaseReason}.`);
    } catch (error) { fail(error); } finally { setPending(false); }
  }

  function openConfirm(): void { setConfirming(true); setUnderstood(false); setTypedId(""); }
  function cancelConfirm(): void {
    setConfirming(false); setUnderstood(false); setTypedId("");
    setMessage("Erasure cancelled. Nothing was changed.");
    refocusTrigger.current = true;
  }

  async function erase(): Promise<void> {
    if (disabled || !plan || !plan.erasable || !understood || typedId !== plan.rootArtifactId) return;
    if (!attempt.current || attempt.current.rootArtifactId !== plan.rootArtifactId) attempt.current = { rootArtifactId: plan.rootArtifactId, erasureId: newRequestId() };
    setPending(true); setFailure(null);
    setMessage("Erasing. This removes every metadata row, every stored object and every local copy…");
    try {
      const response = await erasure.erase({ erasureId: attempt.current.erasureId, artifactId: plan.rootArtifactId, confirm: true,
        expectedArtifactCount: plan.artifacts.length });
      if (response.status !== 200 && response.status !== 201) throw new DevErasureHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const parsed = parseErasureReceiptView(response.body);
      setReceipt(parsed); setPlan(null); setConfirming(false); setUnderstood(false); setTypedId("");
      attempt.current = null;
      setMessage(parsed.complete ? `Erased: ${parsed.totalRemoved} items removed. Receipt ${parsed.erasureId}.`
        : `Erasure ${parsed.erasureId} is ${parsed.phase}; reopen the receipt to confirm it completed.`);
    } catch (error) { fail(error); } finally { setPending(false); }
  }

  async function reopen(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || !reopenId.trim()) return;
    setPending(true); setFailure(null); setPlan(null); setReceipt(null); setConfirming(false);
    setMessage("Reopening the receipt…");
    try {
      const response = await erasure.receipt(reopenId.trim());
      if (response.status !== 200) throw new DevErasureHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const parsed = parseErasureReceiptView(response.body, { erasureId: reopenId.trim() });
      setReceipt(parsed);
      setMessage(`Reopened receipt ${parsed.erasureId} (${parsed.phase}).`);
    } catch (error) { fail(error); } finally { setPending(false); }
  }

  const rows = React.useMemo(() => plan ? treeRows(plan) : [], [plan]);
  const confirmReady = understood && plan !== null && typedId === plan.rootArtifactId;

  return <section aria-labelledby={`${id}-title`} className="dev-erasure">
    <h2 id={`${id}-title`}>Erasure and legal hold · DEV_ONLY</h2>
    <aside role="note"><p>Erasing an artifact permanently removes it and everything derived from it: transcripts, captions, synthesized audio, vision and grounded results, renders, review records, request-ledger replay rows, delivery records, stored objects and local copies. It cannot be undone. This is not the same as revoking a rights statement: revocation stops new processing and replays and deletes nothing. Only the owner can hold or erase, and a legal hold blocks erasure until it is released.</p></aside>

    <form onSubmit={review} aria-label="Review the tree to erase" className="ea-review">
      <label htmlFor={`${id}-artifact`}>Root artifact ID</label>
      <input id={`${id}-artifact`} type="text" value={artifactId} disabled={disabled} autoComplete="off" onChange={(e) => setArtifactId(e.currentTarget.value)} />
      <button type="submit" disabled={disabled || !artifactId.trim()}>Review tree</button>
    </form>
    <form onSubmit={reopen} aria-label="Reopen an erasure receipt" className="ea-reopen">
      <label htmlFor={`${id}-reopen`}>Reopen receipt by erasure ID</label>
      <input id={`${id}-reopen`} type="text" value={reopenId} disabled={disabled} autoComplete="off" onChange={(e) => setReopenId(e.currentTarget.value)} />
      <button type="submit" disabled={disabled || !reopenId.trim()}>Reopen receipt</button>
    </form>
    <p role={failure ? "alert" : "status"} aria-live={failure ? "assertive" : "polite"} id="erasure-status" data-tone={failure?.tone ?? "idle"}>{message}</p>

    {plan && <article id="erasure-plan" aria-labelledby={`${id}-plan`} data-root={plan.rootArtifactId} data-erasable={plan.erasable ? "true" : "false"}>
      <h3 id={`${id}-plan`}>Tree that will be erased · {plan.artifacts.length} artifact{plan.artifacts.length === 1 ? "" : "s"}</h3>
      <table aria-label="Artifacts that will be erased"><thead><tr><th scope="col">Artifact</th><th scope="col">Kind</th><th scope="col">Content digest</th><th scope="col">Derived from</th></tr></thead>
        <tbody>{rows.map(({ node, depth }) => <tr key={node.artifactId} data-artifact-id={node.artifactId} data-kind={node.kind} data-depth={depth}>
          <th scope="row" className={`ea-depth-${Math.min(depth, 6)}`}><code>{node.artifactId}</code>{node.artifactId === plan.rootArtifactId ? " (root)" : ""}</th>
          <td>{label(node.kind)}</td><td><code title={node.sha256}>{shortDigest(node.sha256)}</code></td>
          <td>{node.derivedFrom.length === 0 ? "—" : node.derivedFrom.map((parent) => <code key={parent}>{parent} </code>)}</td></tr>)}</tbody></table>
      <h4>Records that will also be removed</h4>
      <ul aria-label="Dependent records">{Object.entries(plan.dependentRecords).map(([kind, total]) => <li key={kind} data-kind={kind}>{label(kind)}: {total}</li>)}</ul>

      <h4>Legal holds</h4>
      {plan.blockingHolds.length === 0 ? <p>No legal hold covers this tree.</p> : <ul aria-label="Active legal holds" className="ea-holds">{plan.blockingHolds.map((hold) => <li key={hold.holdId} data-hold-id={hold.holdId}>
        <p><strong>Legal hold active</strong> on <code>{hold.rootArtifactId}</code>: {hold.reason}. Placed by {hold.placedBy} ({hold.placedIdentityAssurance}) at {hold.placedAt}.</p>
        <label htmlFor={`${id}-release-${hold.holdId}`}>Reason for releasing hold {hold.holdId}</label>
        <input id={`${id}-release-${hold.holdId}`} type="text" value={releaseReasons[hold.holdId] ?? ""} disabled={disabled} autoComplete="off"
          onChange={(e) => setReleaseReasons({ ...releaseReasons, [hold.holdId]: e.currentTarget.value })} />
        <button type="button" disabled={disabled || !(releaseReasons[hold.holdId] ?? "").trim()} onClick={() => { void release(hold); }}>Release hold</button>
      </li>)}</ul>}
      <form onSubmit={place} aria-label="Place a legal hold" className="ea-hold-form">
        <label htmlFor={`${id}-hold`}>Reason for a new legal hold on {plan.rootArtifactId}</label>
        <input id={`${id}-hold`} type="text" value={holdReason} disabled={disabled} maxLength={1000} autoComplete="off" onChange={(e) => setHoldReason(e.currentTarget.value)} />
        <button type="submit" disabled={disabled || !holdReason.trim()}>Place legal hold</button>
      </form>

      <h4>Erase</h4>
      {!plan.erasable && <p role="note">Erasure is blocked while a legal hold covers this tree. Release the hold first.</p>}
      <button type="button" ref={trigger} disabled={disabled || !plan.erasable || confirming} aria-haspopup="dialog" onClick={openConfirm}>Erase this tree…</button>
      {confirming && <div role="alertdialog" aria-modal="false" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-body`} className="ea-confirm"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelConfirm(); } }}>
        <h4 id={`${id}-confirm-title`} tabIndex={-1} ref={dialogHeading}>Confirm permanent erasure</h4>
        <p id={`${id}-confirm-body`}>You are about to permanently erase {plan.artifacts.length} artifact{plan.artifacts.length === 1 ? "" : "s"} rooted at <code>{plan.rootArtifactId}</code>, together with every record, stored object and local copy listed above. This cannot be undone and is not the same as revoking rights.</p>
        <label><input type="checkbox" checked={understood} disabled={disabled} onChange={(e) => setUnderstood(e.currentTarget.checked)} /> I understand this is permanent</label>
        <label htmlFor={`${id}-typed`}>Type the root artifact ID to confirm</label>
        <input id={`${id}-typed`} type="text" value={typedId} disabled={disabled} autoComplete="off" onChange={(e) => setTypedId(e.currentTarget.value)} />
        <button type="button" disabled={disabled || !confirmReady} onClick={() => { void erase(); }}>Erase permanently</button>
        <button type="button" disabled={pending} onClick={cancelConfirm}>Cancel</button>
      </div>}
    </article>}

    {receipt && <article id="erasure-receipt" aria-labelledby={`${id}-receipt`} data-erasure-id={receipt.erasureId} data-complete={receipt.complete ? "true" : "false"} data-phase={receipt.phase}>
      <h3 id={`${id}-receipt`}>Erasure receipt · {receipt.complete ? "complete" : receipt.phase.replaceAll("_", " ").toLowerCase()}</h3>
      <p>Erasure <code>{receipt.erasureId}</code> of <code>{receipt.rootArtifactId}</code> requested by {receipt.requestedBy} at {receipt.requestedAt}{receipt.completedAt ? `, completed ${receipt.completedAt}` : ""}. {receipt.totalRemoved} items removed. No content is shown; digests identify the removed objects.</p>
      <table aria-label="What was erased"><thead><tr><th scope="col">Kind</th><th scope="col">Removed</th><th scope="col">Digests of removed objects</th></tr></thead>
        <tbody>{receipt.items.map((item) => <tr key={item.kind} data-kind={item.kind}><th scope="row">{label(item.kind)}</th><td>{item.count}</td>
          <td>{item.digests.length === 0 ? "—" : item.digests.map((digest) => <code key={digest} title={digest}>{shortDigest(digest)} </code>)}</td></tr>)}</tbody></table>
    </article>}
  </section>;
}
