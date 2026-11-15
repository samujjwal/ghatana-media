import React from "react";
import {
  DEV_PROVIDER_LABELS, DevProviderCatalogHostError, describeDevProviderFailure, describeDevProviderReason,
  describeDevProviderState, diffDevProviderStates, parseDevProviderCatalog, shortDigest,
  type DevProviderCatalogPort, type DevProviderCatalogView, type DevProviderEntry, type DevProviderFailure,
} from "./devProviderCatalog";

export interface DevProviderStatusPanelProps {
  readonly catalog: DevProviderCatalogPort;
  /** Live refresh period in milliseconds; defaults to 5000 and is clamped to at least 1000. */
  readonly refreshIntervalMs?: number;
  /** Start with live refresh on (default true). */
  readonly live?: boolean;
}

const asHost = (error: unknown): DevProviderCatalogHostError => error instanceof DevProviderCatalogHostError ? error
  : new DevProviderCatalogHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");

const label = (provider: DevProviderEntry): string => DEV_PROVIDER_LABELS[provider.providerId] ?? provider.providerId;

/**
 * DEV_ONLY provider readiness. Every row shows the observed state as text (never colour alone), the stable reason code
 * with a plain explanation, the licence, the device the provider actually reported and the last check time. Nothing is
 * shown as ready unless the host says READY; a failed refresh keeps the last view but marks it stale. Production
 * eligibility is shown as "No" (the DEV catalog never asserts it). "Ready" is neither a quality nor a rights claim.
 */
export function DevProviderStatusPanel({ catalog, refreshIntervalMs = 5000, live: initialLive = true }: DevProviderStatusPanelProps): React.ReactElement {
  const id = React.useId();
  const [view, setView] = React.useState<DevProviderCatalogView | null>(null);
  const [failure, setFailure] = React.useState<DevProviderFailure | null>(null);
  const [live, setLive] = React.useState(initialLive);
  const [loading, setLoading] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");
  const previous = React.useRef<DevProviderCatalogView | null>(null);
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  const period = Math.max(1000, refreshIntervalMs);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await catalog.get();
      if (response.status !== 200) throw new DevProviderCatalogHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const next = parseDevProviderCatalog(response.body);
      if (!mounted.current) return;
      const changes = diffDevProviderStates(previous.current, next);
      previous.current = next;
      setView(next);
      setFailure(null);
      if (changes.length > 0) {
        setAnnounce(changes.map((c) => `${DEV_PROVIDER_LABELS[c.providerId] ?? c.providerId} changed from ${c.from} to ${c.to}`).join(". ") + ".");
      }
    } catch (error) {
      if (!mounted.current) return;
      setFailure(describeDevProviderFailure(asHost(error)));
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [catalog]);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  React.useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { void refresh(); }, period);
    return () => clearInterval(timer);
  }, [live, period, refresh]);

  const message = failure
    ? `${failure.code}: ${failure.text}${view ? " Showing the last observation, which is stale." : ""}`
    : view ? `Observed ${view.checkedAt}${live ? `; refreshing about every ${Math.round(period / 1000)} s` : "; live refresh is off"}.` : loading ? "Checking the local providers…" : "Not checked yet.";

  return <section aria-labelledby={`${id}-title`} className="dev-provider-status" data-stale={failure && view ? "true" : "false"}>
    <h2 id={`${id}-title`}>Local providers · DEV_ONLY</h2>
    <aside role="note"><p>Readiness is observed on this host from manifest digest checks and live probes of each process, port or binary; it is never read from configuration. It is not a quality, rights, approval or production-eligibility claim. Media never substitutes a different model when a provider is down{view?.fallbackPolicy ? `: ${view.fallbackPolicy}` : ""}.</p></aside>

    <div className="ps-controls">
      <button type="button" onClick={() => { void refresh(); }} disabled={loading}>Refresh now</button>
      <label htmlFor={`${id}-live`}><input id={`${id}-live`} type="checkbox" checked={live} onChange={(e) => setLive(e.currentTarget.checked)} /> Live refresh</label>
    </div>
    <p id="provider-status" role={failure ? "alert" : "status"} aria-live={failure ? "assertive" : "polite"} data-tone={failure ? "error" : "idle"}>{message}</p>

    {view && <table aria-label="Local provider readiness" id="provider-table">
      <caption className="ps-sr-only">Observed readiness of each local provider</caption>
      <thead><tr><th scope="col">Provider</th><th scope="col">State</th><th scope="col">Reason</th><th scope="col">Licence</th><th scope="col">Device</th><th scope="col">Checked</th></tr></thead>
      <tbody>{view.providers.map((provider) => <tr key={provider.providerId} data-provider-id={provider.providerId} data-state={provider.state}>
        <th scope="row">{label(provider)}<br /><span className="ps-kind">{provider.kind.replaceAll("_", " ").toLowerCase()}</span></th>
        <td><strong className="ps-state" data-state={provider.state} title={describeDevProviderState(provider.state)}>{provider.state.replace("_", " ")}</strong><span className="ps-sr-only"> {describeDevProviderState(provider.state)}</span></td>
        <td><code>{provider.reason}</code>{provider.detail ? <> <code>{provider.detail}</code></> : null}<br />{describeDevProviderReason(provider.reason)}</td>
        <td>{provider.licenseSpdx ?? "unknown"}{provider.noticeRequired ? " · notice required" : ""}</td>
        <td>{provider.deviceReported ? `${provider.deviceKind}${provider.deviceName ? ` · ${provider.deviceName}` : ""}` : "not reported"}</td>
        <td><time dateTime={provider.lastCheckedAt}>{provider.lastCheckedAt}</time></td>
      </tr>)}</tbody>
    </table>}

    {view && <div className="ps-details">{view.providers.map((provider) => <details key={provider.providerId} data-provider-id={provider.providerId}>
      <summary>{label(provider)}: model, licence notice, digests and languages</summary>
      <dl>
        <dt>Model</dt><dd>{provider.modelId ?? "none"}{provider.revision ? ` @ ${provider.revision}` : ""}</dd>
        <dt>Production eligible</dt><dd>{provider.productionEligible ? "Yes" : "No"}</dd>
        <dt>Verified languages</dt><dd>{provider.verifiedLanguages.length ? provider.verifiedLanguages.join(", ") : "none listed"}</dd>
        <dt>Voices</dt><dd>{provider.voices.length ? provider.voices.join(", ") : "none"}</dd>
        <dt>Digests</dt><dd>{Object.keys(provider.digests).length ? Object.entries(provider.digests).map(([name, value]) => <span key={name} className="ps-digest"><code title={value}>{name}: {shortDigest(value)}</code> </span>) : "none"}</dd>
        <dt>Licence notice</dt><dd>{provider.licenseNotice ?? "none"}</dd>
      </dl>
    </details>)}</div>}
    <p className="ps-sr-only" role="status" aria-live="polite" data-testid="provider-announcement">{announce}</p>
  </section>;
}
