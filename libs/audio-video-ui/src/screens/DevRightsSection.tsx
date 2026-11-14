import React from "react";
import { DevOutputsHostError, type DevProjectOutputsPort, type Outcome } from "./devProjectOutputs";
import {
  DEV_RIGHTS_CONFIRMED_SCOPES, DEV_RIGHTS_SCOPES, DEV_RIGHTS_STATEMENT_KINDS, confirmGate, describeRightsFailure,
  parseRightsAttestation, parseRightsVersionView, revokeGate,
  type DevRightsAttestation, type DevRightsScope, type DevRightsStatementKind, type DevRightsVersionView,
} from "./devRights";

export interface DevRightsSectionProps {
  readonly outputs: DevProjectOutputsPort;
  readonly locked: boolean;
  /** The exact artifact version the uploader states rights for. Null renders only the second-person confirmation lane. */
  readonly artifact: { readonly artifactId: string; readonly artifactVersionId: string } | null;
  /** Distinguishes element ids when two sections share one page (for example the standalone confirmer view). */
  readonly idPrefix?: string;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TEXT = 2000;
const asHost = (error: unknown): DevOutputsHostError => error instanceof DevOutputsHostError ? error
  : new DevOutputsHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const KIND_LABEL: Readonly<Record<DevRightsStatementKind, string>> = {
  MEDIA_RIGHTS: "I own this media or hold a licence for it",
  IDENTIFIABLE_PERSON_CONSENT: "Identifiable people in this media consented",
};
const SCOPE_LABEL: Readonly<Record<DevRightsScope, string>> = {
  PROCESSING: "PROCESSING",
  VOICE_OR_LIKENESS_USE: "VOICE_OR_LIKENESS_USE (needs a second person)",
  EXTERNAL_DELIVERY: "EXTERNAL_DELIVERY (needs a second person)",
};

type Pending = "list" | "create" | "open" | "confirm" | "revoke" | null;

/**
 * DEV_ONLY rights and consent. The uploader states rights and consent for one exact artifact version; a second
 * person confirms before any voice or likeness use or external delivery; either of them can revoke. Who, when and
 * which exact file are shown from the host's records. Nothing here is a legal determination or human approval.
 */
export function DevRightsSection({ outputs, locked, artifact, idPrefix = "" }: DevRightsSectionProps): React.ReactElement {
  const pfx = idPrefix ? `${idPrefix}-` : "";
  const principalId = outputs.principalId;
  const [pending, setPending] = React.useState<Pending>(null);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [message, setMessage] = React.useState("No rights statement loaded.");
  const [view, setView] = React.useState<DevRightsVersionView | null>(null);
  const [opened, setOpened] = React.useState<DevRightsAttestation | null>(null);
  const [kind, setKind] = React.useState<DevRightsStatementKind>("MEDIA_RIGHTS");
  const [scopes, setScopes] = React.useState<readonly DevRightsScope[]>([]);
  const [basis, setBasis] = React.useState("");
  const [supporting, setSupporting] = React.useState("");
  const [confirmer, setConfirmer] = React.useState("");
  const [knownId, setKnownId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [sure, setSure] = React.useState(false);
  const [actSure, setActSure] = React.useState(false);

  const supported = typeof outputs.createRightsAttestation === "function" && typeof outputs.listRightsAttestations === "function"
    && typeof outputs.getRightsAttestation === "function" && typeof outputs.confirmRightsAttestation === "function"
    && typeof outputs.revokeRightsAttestation === "function";
  const busy = pending !== null;
  const versionKey = artifact ? `${artifact.artifactId}@${artifact.artifactVersionId}` : "";

  const fail = (error: unknown): void => {
    const next = describeRightsFailure(asHost(error));
    setOutcome(next); setMessage(`${next.code}: ${next.text}`);
  };

  const load = React.useCallback(async (keepMessage: boolean): Promise<void> => {
    if (!artifact || !supported) return;
    setPending("list"); if (!keepMessage) setMessage("Reading the rights statements for this exact version…");
    try {
      const response = await outputs.listRightsAttestations!(artifact.artifactId, artifact.artifactVersionId);
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const next = parseRightsVersionView(response.body, artifact);
      setView(next); setOutcome(null);
      if (!keepMessage) {
        setMessage(next.attestations.length === 0
          ? "No rights statement exists for this exact version. Nothing is admitted for voice or likeness use or external delivery."
          : `Read ${next.attestations.length} statement(s) for this exact version.`);
      }
    } catch (error) { setView(null); fail(error); } finally { setPending(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputs, versionKey, supported]);

  // The component is mounted per exact version; a read on mount shows the host's current records.
  React.useEffect(() => { void load(false); }, [load]);

  const toggleScope = (value: DevRightsScope, on: boolean): void =>
    setScopes((current) => on ? [...new Set([...current, value])] : current.filter((entry) => entry !== value));

  const basisOk = basis.trim() !== "" && basis.length <= MAX_TEXT;
  const supportingOk = supporting.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}@sha256:[0-9a-f]{64}$/u.test(supporting.trim());
  const confirmerOk = confirmer.trim() === "" || (OPAQUE_ID.test(confirmer.trim()) && confirmer.trim() !== principalId);
  const needsSecond = scopes.some((scope) => DEV_RIGHTS_CONFIRMED_SCOPES.includes(scope));
  const createDisabled = busy || locked || !artifact || scopes.length === 0 || !basisOk || !supportingOk || !confirmerOk || !sure;

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (createDisabled || !artifact) return;
    setPending("create"); setOutcome(null); setMessage("Recording your statement for this exact version…");
    try {
      const response = await outputs.createRightsAttestation!({
        artifactId: artifact.artifactId, artifactVersionId: artifact.artifactVersionId, statementKind: kind,
        scopes: DEV_RIGHTS_SCOPES.filter((scope) => scopes.includes(scope)), basis: basis.trim(),
        ...(supporting.trim() ? { supportingDocumentArtifactRef: supporting.trim() } : {}),
        ...(confirmer.trim() ? { requestedConfirmerPrincipalId: confirmer.trim() } : {}),
      });
      if (response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const created = parseRightsAttestation(response.body);
      if (created.artifactId !== artifact.artifactId || created.artifactVersionId !== artifact.artifactVersionId) {
        throw new DevOutputsHostError("INVALID_RESPONSE", 201, "Statement is for a different version.");
      }
      setBasis(""); setScopes([]); setSupporting(""); setConfirmer(""); setSure(false);
      setMessage(`Recorded statement ${created.attestationId} by ${created.attestingPrincipalId}. ${created.requiresSecondPersonConfirmation
        ? "It is not admitted for voice or likeness use or external delivery until a different person confirms it. Give them this statement id."
        : "It covers processing only."}`);
      await load(true);
    } catch (error) { fail(error); } finally { setPending(null); }
  };

  const openKnown = async (): Promise<void> => {
    const id = knownId.trim();
    if (busy || !OPAQUE_ID.test(id) || !supported) return;
    setPending("open"); setOutcome(null); setMessage(`Reading statement ${id}…`);
    try {
      const response = await outputs.getRightsAttestation!(id);
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const found = parseRightsAttestation(response.body);
      if (found.attestationId !== id) throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Statement identity mismatch.");
      setOpened(found); setKnownId("");
      setMessage(`Opened statement ${found.attestationId}: ${found.status}.`);
    } catch (error) { setOpened(null); fail(error); } finally { setPending(null); }
  };

  const confirm = async (target: DevRightsAttestation): Promise<void> => {
    if (busy || locked || !actSure || !confirmGate(target, principalId).allowed) return;
    setPending("confirm"); setOutcome(null); setMessage(`Confirming statement ${target.attestationId}…`);
    try {
      const response = await outputs.confirmRightsAttestation!(target.attestationId, note.trim() ? { note: note.trim() } : {});
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const next = parseRightsAttestation(response.body);
      if (next.attestationId !== target.attestationId) throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Statement identity mismatch.");
      setNote(""); setActSure(false);
      setOpened((current) => current && current.attestationId === next.attestationId ? next : current);
      setMessage(`Confirmed statement ${next.attestationId} as ${next.confirmation?.confirmingPrincipalId ?? "unknown"}. It covers exactly ${next.artifactVersionId}.`);
      await load(true);
    } catch (error) { fail(error); } finally { setPending(null); }
  };

  const revoke = async (target: DevRightsAttestation): Promise<void> => {
    if (busy || locked || !actSure || reason.trim() === "" || !revokeGate(target, principalId).allowed) return;
    setPending("revoke"); setOutcome(null); setMessage(`Revoking statement ${target.attestationId}…`);
    try {
      const response = await outputs.revokeRightsAttestation!(target.attestationId, { reason: reason.trim() });
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const next = parseRightsAttestation(response.body);
      if (next.attestationId !== target.attestationId || next.status !== "REVOKED") throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Statement is not revoked.");
      setReason(""); setActSure(false);
      setOpened((current) => current && current.attestationId === next.attestationId ? next : current);
      setMessage(`Revoked statement ${next.attestationId} by ${next.revocation?.revokedByPrincipalId ?? "unknown"}.`);
      await load(true);
    } catch (error) { fail(error); } finally { setPending(null); }
  };

  const renderRecord = (record: DevRightsAttestation): React.ReactElement => {
    const cGate = confirmGate(record, principalId);
    const rGate = revokeGate(record, principalId);
    return <li key={record.attestationId} data-attestation={record.attestationId} data-status={record.status}>
      <p><strong>{record.status}</strong> · <code>{record.attestationId}</code> · {record.statementKind === "MEDIA_RIGHTS" ? "ownership or licence" : "consent of identifiable people"} · {record.scopes.join(", ")}</p>
      <dl>
        <div><dt>Given by</dt><dd><code>{record.attestingPrincipalId}</code> at {record.attestedAt}</dd></div>
        <div><dt>Exact file</dt><dd><code>{record.artifactId}@{record.artifactVersionId}</code> · sha256 <code>{record.contentSha256}</code></dd></div>
        <div><dt>Basis</dt><dd>{record.basis}</dd></div>
        {record.supportingDocumentArtifactRef && <div><dt>Supporting document</dt><dd><code>{record.supportingDocumentArtifactRef}</code></dd></div>}
        {record.expiresAt && <div><dt>Expires</dt><dd>{record.expiresAt}</dd></div>}
        {record.requestedConfirmerPrincipalId && <div><dt>Requested confirmer</dt><dd><code>{record.requestedConfirmerPrincipalId}</code></dd></div>}
        <div><dt>Second-person confirmation</dt><dd>{record.confirmation
          ? <>Confirmed by <code>{record.confirmation.confirmingPrincipalId}</code> at {record.confirmation.confirmedAt}{record.confirmation.note ? ` · ${record.confirmation.note}` : ""}</>
          : record.requiresSecondPersonConfirmation ? "Not confirmed yet" : "Not required for these scopes"}</dd></div>
        {record.revocation && <div><dt>Revoked</dt><dd>By <code>{record.revocation.revokedByPrincipalId}</code> at {record.revocation.revokedAt} · {record.revocation.reason}</dd></div>}
      </dl>
      {record.requiresSecondPersonConfirmation && !record.confirmation && record.status !== "REVOKED" && <>
        <button type="button" onClick={() => void confirm(record)} disabled={busy || locked || !actSure || !cGate.allowed}
          aria-label={`Confirm statement ${record.attestationId}`}>Confirm as a second person</button>
        {!cGate.allowed && <p role="note" data-confirm-gate={cGate.reason}>{cGate.reason}</p>}
      </>}
      {record.status !== "REVOKED" && <>
        <button type="button" onClick={() => void revoke(record)} disabled={busy || locked || !actSure || reason.trim() === "" || !rGate.allowed}
          aria-label={`Revoke statement ${record.attestationId}`}>Revoke</button>
        {!rGate.allowed && <p role="note" data-revoke-gate={rGate.reason}>{rGate.reason}</p>}
      </>}
    </li>;
  };

  if (!supported) {
    return <section aria-labelledby={`${pfx}rights-title`} id={`${pfx}dev-rights`} data-rights-state="unavailable">
      <h4 id={`${pfx}rights-title`}>Rights and consent</h4>
      <p role="note">This host does not expose the DEV_ONLY rights lane, so no rights statement can be made or confirmed here. External delivery stays refused.</p>
    </section>;
  }

  const confirmingOpened = opened ? [opened] : [];
  return <section aria-labelledby={`${pfx}rights-title`} id={`${pfx}dev-rights`} data-rights-state={outcome ? outcome.tone : "ready"}>
    <h4 id={`${pfx}rights-title`}>Rights and consent</h4>
    <aside role="note" aria-label="Rights and consent disclaimer" data-approval="false">
      <strong>Uploader plus reviewer.</strong> The uploader states rights and consent for each exact version. A second person must confirm before any voice or likeness use, or before any external delivery. Every statement records who gave it, when and for which exact file, and can be revoked. These are statements by DEV_ONLY identities: they are not a legal determination and not human approval.
    </aside>
    <p id={`${pfx}rights-status`} role="status" aria-live="polite" aria-atomic="true" aria-busy={busy}
      data-state={outcome ? outcome.tone : "idle"}>{message}</p>
    {outcome && <p role="alert" data-outcome={outcome.tone}><strong>{outcome.tone === "unknown" ? "Outcome unknown" : outcome.tone === "denied" ? "Denied" : outcome.tone === "unavailable" ? "Unavailable" : "Not recorded"} · <code>{outcome.code}</code></strong></p>}

    {artifact && <>
      <h5>Statements for <code>{artifact.artifactVersionId}</code></h5>
      {view && <ul aria-label="Admission by scope" data-admission>{view.admission.map((entry) => <li key={entry.scope} data-scope={entry.scope} data-verdict={entry.verdict}>
        {entry.scope}: <strong>{entry.verdict}</strong>{entry.reasons.length > 0 ? ` (${entry.reasons.join(", ")})` : ""}</li>)}</ul>}
      {view && (view.attestations.length === 0 ? <p>No statement yet for this exact version. A new version never inherits an earlier version's statements.</p>
        : <ol aria-label="Rights statements">{view.attestations.map(renderRecord)}</ol>)}
      <button type="button" onClick={() => void load(false)} disabled={busy}>Re-read statements</button>

      <form id={`${pfx}rights-create-form`} onSubmit={(event) => void create(event)}>
        <fieldset aria-labelledby={`${pfx}rights-create-legend`}>
          <legend id={`${pfx}rights-create-legend`}>State rights and consent for this exact version</legend>
          <label htmlFor={`${pfx}rights-kind`}>What you are stating</label>
          <select id={`${pfx}rights-kind`} value={kind} onChange={(event) => setKind(event.currentTarget.value as DevRightsStatementKind)} disabled={busy || locked}>
            {DEV_RIGHTS_STATEMENT_KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
          </select>
          <fieldset aria-label="Statement scopes">
            {DEV_RIGHTS_SCOPES.map((value) => <label key={value}><input type="checkbox" value={value} checked={scopes.includes(value)}
              onChange={(event) => toggleScope(value, event.currentTarget.checked)} disabled={busy || locked} /> {SCOPE_LABEL[value]}</label>)}
          </fieldset>
          <label htmlFor={`${pfx}rights-basis`}>Basis (what this statement rests on)</label>
          <textarea id={`${pfx}rights-basis`} value={basis} onChange={(event) => setBasis(event.currentTarget.value)} disabled={busy || locked} maxLength={MAX_TEXT} required />
          <label htmlFor={`${pfx}rights-supporting`}>Supporting document (optional, artifactId@sha256:version)</label>
          <input id={`${pfx}rights-supporting`} value={supporting} onChange={(event) => setSupporting(event.currentTarget.value)} disabled={busy || locked} autoComplete="off" spellCheck={false} />
          {!supportingOk && <p role="note">A supporting document reference is an artifact id, an at sign and its exact sha256 version.</p>}
          <label htmlFor={`${pfx}rights-confirmer`}>Ask a specific person to confirm (optional principal ID)</label>
          <input id={`${pfx}rights-confirmer`} value={confirmer} onChange={(event) => setConfirmer(event.currentTarget.value)} disabled={busy || locked} autoComplete="off" spellCheck={false} />
          {!confirmerOk && <p role="note">The confirmer must be a different person from you.</p>}
          {needsSecond && <p role="note">These scopes are admitted only after a different person confirms.</p>}
          <label htmlFor={`${pfx}rights-sure`}><input id={`${pfx}rights-sure`} type="checkbox" checked={sure} onChange={(event) => setSure(event.currentTarget.checked)} disabled={busy || locked} />
            I am stating this as myself, for this exact version only. I understand it is recorded with my identity and the time.</label>
          <button type="submit" disabled={createDisabled}>Record my statement</button>
        </fieldset>
      </form>
    </>}

    <form id={`${pfx}rights-known-form`} onSubmit={(event) => { event.preventDefault(); void openKnown(); }}>
      <label htmlFor={`${pfx}known-rights-id`}>Statement ID to review and confirm</label>
      <input id={`${pfx}known-rights-id`} value={knownId} onChange={(event) => setKnownId(event.currentTarget.value)} disabled={busy} autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={busy || !OPAQUE_ID.test(knownId.trim())}>Open statement</button>
    </form>
    {confirmingOpened.length > 0 && <ol aria-label="Opened statement">{confirmingOpened.map(renderRecord)}</ol>}
    {(opened || view) && <>
      <label htmlFor={`${pfx}rights-note`}>Confirmation note (optional)</label>
      <input id={`${pfx}rights-note`} value={note} onChange={(event) => setNote(event.currentTarget.value)} disabled={busy || locked} maxLength={MAX_TEXT} />
      <label htmlFor={`${pfx}rights-reason`}>Revocation reason</label>
      <input id={`${pfx}rights-reason`} value={reason} onChange={(event) => setReason(event.currentTarget.value)} disabled={busy || locked} maxLength={MAX_TEXT} />
      <label htmlFor={`${pfx}rights-act-sure`}><input id={`${pfx}rights-act-sure`} type="checkbox" checked={actSure} onChange={(event) => setActSure(event.currentTarget.checked)} disabled={busy || locked} />
        I have read the statement and I am confirming or revoking it as myself.</label>
    </>}
  </section>;
}
