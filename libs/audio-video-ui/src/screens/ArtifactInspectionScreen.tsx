import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";

/** Minimal authenticated SDK projection used by the source-defined inspect-artifact read. */
export interface CanonicalArtifactReadClient {
  getArtifact(artifactId: string, signal?: AbortSignal): Promise<{
    readonly artifactId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly objectReference: string;
    readonly classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }>;
}

type ArtifactReadState =
  | { readonly state: "NOT_ADMITTED" }
  | { readonly state: "READY" }
  | { readonly state: "LOADING" }
  | { readonly state: "DENIED" }
  | { readonly state: "NOT_VISIBLE" }
  | { readonly state: "UNKNOWN" }
  | { readonly state: "OBSERVED"; readonly artifact: Awaited<ReturnType<CanonicalArtifactReadClient["getArtifact"]>> };

export interface ArtifactInspectionScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly artifactId: string;
  /** Optional authenticated SDK; absent means NOT_ADMITTED and performs no request. */
  readonly canonicalArtifactReadClient?: CanonicalArtifactReadClient;
}

/** Candidate media.view.inspect-media body: metadata only, never byte retrieval or rights admission. */
export function ArtifactInspectionScreen({ artifactId, canonicalArtifactReadClient, ...flow }: ArtifactInspectionScreenProps): React.ReactElement {
  const initial = canonicalArtifactReadClient ? { state: "READY" as const } : { state: "NOT_ADMITTED" as const };
  const [record, setRecord] = React.useState({ artifactId, reader: canonicalArtifactReadClient, value: initial as ArtifactReadState });
  const activeRead = React.useRef<AbortController | undefined>(undefined);
  const readState = record.artifactId === artifactId && record.reader === canonicalArtifactReadClient ? record.value : initial;
  const setReadState = (value: ArtifactReadState): void => setRecord({ artifactId, reader: canonicalArtifactReadClient, value });

  React.useEffect(() => {
    activeRead.current?.abort();
    activeRead.current = undefined;
    return () => {
      activeRead.current?.abort();
      activeRead.current = undefined;
    };
  }, [artifactId, canonicalArtifactReadClient]);

  const refresh = (): void => {
    if (!canonicalArtifactReadClient || readState.state === "LOADING" || activeRead.current) return;
    const controller = new AbortController();
    activeRead.current = controller;
    setReadState({ state: "LOADING" });
    void canonicalArtifactReadClient.getArtifact(artifactId, controller.signal).then((artifact) => {
      if (controller.signal.aborted || activeRead.current !== controller) return;
      if (artifact.artifactId !== artifactId || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1
        || !/^[0-9a-fA-F]{64}$/u.test(artifact.sha256)) {
        setReadState({ state: "UNKNOWN" });
        return;
      }
      setReadState({ state: "OBSERVED", artifact });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || activeRead.current !== controller) return;
      const statusCode = error && typeof error === "object" && "statusCode" in error
        ? (error as { readonly statusCode?: unknown }).statusCode : undefined;
      setReadState(statusCode === 401 || statusCode === 403
        ? { state: "DENIED" }
        : statusCode === 404 ? { state: "NOT_VISIBLE" } : { state: "UNKNOWN" });
    }).finally(() => {
      if (activeRead.current === controller) activeRead.current = undefined;
    });
  };

  const message = (() => {
    switch (readState.state) {
      case "NOT_ADMITTED": return "Canonical artifact inspection is NOT_ADMITTED. No live read was requested.";
      case "READY": return "Artifact metadata has not been refreshed in this view.";
      case "LOADING": return "Loading artifact metadata…";
      case "DENIED": return "Artifact metadata access is denied for this caller.";
      case "NOT_VISIBLE": return "No artifact metadata is visible in this caller scope. This does not establish global absence.";
      case "UNKNOWN": return "Artifact metadata is unavailable or invalid. No availability or rights conclusion was made.";
      case "OBSERVED": return `Metadata observed for ${readState.artifact.artifactId}. This does not establish current availability or processing rights.`;
    }
  })();

  return <MediaTaskScreen {...flow}>
    <section className="media-screen-body" aria-labelledby="artifact-inspection-title">
      <header><h3 id="artifact-inspection-title">Inspect media</h3><p>Read metadata for this exact artifact identity.</p></header>
      <dl><div><dt>Artifact ID</dt><dd><code>{artifactId}</code></dd></div></dl>
      <section aria-labelledby="artifact-canonical-read-title">
        <h4 id="artifact-canonical-read-title">Canonical metadata read</h4>
        <p role="status" aria-live="polite" aria-atomic="true" aria-busy={readState.state === "LOADING"} data-state={readState.state.toLowerCase()}>{message}</p>
        {canonicalArtifactReadClient && <button type="button" onClick={refresh} disabled={readState.state === "LOADING"}>Refresh artifact metadata</button>}
        {readState.state === "OBSERVED" && <dl>
          <div><dt>File name</dt><dd>{readState.artifact.fileName}</dd></div>
          <div><dt>Content type</dt><dd>{readState.artifact.contentType}</dd></div>
          <div><dt>Size</dt><dd>{readState.artifact.sizeBytes} bytes</dd></div>
          <div><dt>SHA-256</dt><dd><code>{readState.artifact.sha256}</code></dd></div>
          <div><dt>Classification</dt><dd>{readState.artifact.classification}</dd></div>
          <div><dt>Created</dt><dd>{readState.artifact.createdAt}</dd></div>
          <div><dt>Expires</dt><dd>{readState.artifact.expiresAt}</dd></div>
          <div><dt>Opaque object reference</dt><dd><code>{readState.artifact.objectReference}</code></dd></div>
        </dl>}
      </section>
      <p>Inspection does not retrieve content bytes, confirm current availability, or authorize processing or delivery.</p>
    </section>
  </MediaTaskScreen>;
}
