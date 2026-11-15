import React, { useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDevDeliveryClient, DevDeliveryHostError, type DevDeliveryClient, type DevExportView } from "./dev-delivery-client";

const origin = window.location.origin;
const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  CREDENTIAL_REVOKED: "The destination refused Media's upload credential (revoked). Nothing further was written; restore the credential, then reconcile and resume.",
  ACK_SIGNATURE_INVALID: "A destination acknowledgment did not verify against the registered signing key, so it was ignored. Reconcile to read the destination's signed status.",
  DESTINATION_IDENTITY_MISMATCH: "The receiver is not the registered destination (its signed identity differs). Nothing was accepted from it.",
  CHECKSUM_MISMATCH: "The destination holds bytes whose SHA-256 or size differs from the artifact. The destination is write-once, so Media did not overwrite them and will not confirm.",
  DESTINATION_UNREACHABLE: "The destination did not answer. The bytes may or may not have been stored; reconcile reads its state without uploading again.",
  DESTINATION_REJECTED: "The destination rejected the request.",
};
const ACK_TEXT: Readonly<Record<string, string>> = {
  DELIVERED: "Delivered: the destination returned a signed receipt for these exact bytes and Media verified it.",
  UNKNOWN: "Unknown: the destination has not given a verified receipt. Nothing is marked delivered.",
  NOT_DELIVERED: "Not delivered: the destination verifiably holds none of these bytes.",
};

const ERROR_TEXT: Readonly<Record<string, string>> = {
  DESTINATION_NOT_FOUND: "That destination is not registered on this DEV_ONLY host. Nothing was sent.",
  DESTINATION_NOT_PERMITTED: "That destination is registered but not permitted for this tenant. Nothing was sent.",
  EXPORT_RIGHTS_NOT_ADMITTED: "External delivery needs a current, second-person-confirmed EXTERNAL_DELIVERY attestation for this exact version. Nothing was sent.",
  EXPORT_RIGHTS_AUTHORITY_UNAVAILABLE: "The rights authority is unavailable. Nothing was sent.",
  ARTIFACT_VERSION_NOT_FOUND: "That exact artifact version is not available to you. Nothing was sent.",
  EXPORT_NOT_FOUND: "No export with that request id exists in your scope.",
  EXPORT_REQUEST_CONFLICT: "That request id is already bound to a different artifact version or destination.",
  OUTCOME_UNKNOWN: "The host did not answer. The export may have happened; reconcile the same request id instead of exporting again.",
};

function DeliveryPanel({ client }: { client: DevDeliveryClient }): React.ReactElement {
  const [requestId, setRequestId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [destination, setDestination] = useState("dev-http-receiver");
  const [view, setView] = useState<DevExportView | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  async function run(action: () => Promise<{ status: number; view: DevExportView }>): Promise<void> {
    setBusy(true); setError(null);
    try {
      const outcome = await action();
      setView(outcome.view);
    } catch (failure) {
      const typed = failure instanceof DevDeliveryHostError ? failure : null;
      setError({ code: typed?.code ?? "UNEXPECTED", message: ERROR_TEXT[typed?.code ?? ""] ?? typed?.message ?? "The request failed." });
    } finally {
      setBusy(false);
      queueMicrotask(() => resultHeading.current?.focus());
    }
  }
  const ready = requestId.trim() !== "" && artifactId.trim() !== "" && versionId.trim() !== "";
  const settled = view?.ackState === "DELIVERED";

  return (
    <section className="panel" aria-labelledby="export-heading" aria-busy={busy}>
      <h2 id="export-heading">Export to a destination</h2>
      <form onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void run(() => client.exportArtifact({ requestId: requestId.trim(), artifactId: artifactId.trim(), artifactVersionId: versionId.trim(), destinationId: destination })); }}>
        <label htmlFor="export-request">Request id (the idempotency identity of this delivery)</label>
        <input id="export-request" type="text" value={requestId} onChange={(event) => setRequestId(event.target.value)} autoComplete="off" required />
        <label htmlFor="export-artifact">Artifact id</label>
        <input id="export-artifact" type="text" value={artifactId} onChange={(event) => setArtifactId(event.target.value)} autoComplete="off" required />
        <label htmlFor="export-version">Exact artifact version (for example sha256:…)</label>
        <input id="export-version" type="text" value={versionId} onChange={(event) => setVersionId(event.target.value)} autoComplete="off" required />
        <label htmlFor="export-destination">Registered destination</label>
        <select id="export-destination" value={destination} onChange={(event) => setDestination(event.target.value)}>
          <option value="dev-http-receiver">dev-http-receiver (signed-ACK local receiver)</option>
          <option value="dev-local-directory">dev-local-directory (read-back local directory)</option>
        </select>
        <div className="actions">
          <button type="submit" disabled={!ready || busy}>Export</button>
          <button type="button" disabled={requestId.trim() === "" || busy} onClick={() => void run(() => client.read(requestId.trim()))}>Refresh status</button>
          <button type="button" disabled={requestId.trim() === "" || busy || settled} onClick={() => void run(() => client.reconcile(requestId.trim(), false))}>Reconcile (read destination only)</button>
          <button type="button" disabled={requestId.trim() === "" || busy || settled} onClick={() => void run(() => client.reconcile(requestId.trim(), true))}>Reconcile and resume</button>
        </div>
      </form>
      <div id="delivery-result" role="status" aria-live="polite">
        <h3 ref={resultHeading} tabIndex={-1}>Acknowledgment</h3>
        {view === null && error === null ? <p>No export checked yet.</p> : null}
        {view !== null ? (
          <div data-ack-state={view.ackState}>
            <p className="ack-state"><strong>ACK state: <span id="ack-state">{view.ackState}</span></strong></p>
            <p id="ack-explanation">{ACK_TEXT[view.ackState] ?? view.ackState}</p>
            {view.failure !== null && !view.destinationConfirmed ? (
              <p id="ack-failure" role="note"><strong>Failure: <span id="ack-failure-code">{view.failure}</span></strong> {FAILURE_TEXT[view.failure] ?? ""}</p>
            ) : null}
            <dl>
              <dt>Request</dt><dd>{view.requestId}</dd>
              <dt>Destination</dt><dd>{view.destinationId}</dd>
              <dt>Ledger status</dt><dd id="ledger-status">{view.status}</dd>
              <dt>Bytes acknowledged by the destination</dt><dd id="acknowledged-bytes">{view.acknowledgedBytes}</dd>
              <dt>Bytes the destination reported holding</dt><dd id="received-bytes">{view.destinationReceivedBytes ?? "not observed"}</dd>
              <dt>Signed receipt</dt><dd id="receipt-ref">{view.destinationReceiptRef ?? "none"}</dd>
              <dt>Replay of an existing operation</dt><dd>{view.replayed ? "yes" : "no"}</dd>
            </dl>
          </div>
        ) : null}
        {error !== null ? <p id="delivery-error" role="alert"><strong>{error.code}</strong> {error.message}</p> : null}
      </div>
    </section>
  );
}

const tokenInput = byId<HTMLInputElement>("dev-token");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const status = byId<HTMLParagraphElement>("connection-status");
const root: Root = createRoot(byId<HTMLDivElement>("delivery-root"));
let bearerToken: string | null = null;

const forget = (): void => { bearerToken = null; root.render(null); };
byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  bearerToken = raw;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  status.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const context: unknown = await response.json();
    if (!context || typeof context !== "object" || (context as { scope?: unknown }).scope !== "DEV_ONLY") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    status.textContent = "Connected to local DEV_ONLY host. Exports are subject to the host's owner, delivery and rights permissions.";
    root.render(<DeliveryPanel client={createDevDeliveryClient({ origin, bearerToken: () => bearerToken ?? "" })} />);
  } catch (error) {
    forget();
    status.textContent = error instanceof Error ? error.message : "Unable to connect.";
    tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  }
});
disconnectButton.addEventListener("click", () => {
  forget();
  tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  status.textContent = "Disconnected. In-memory token cleared.";
});
window.addEventListener("beforeunload", forget);
