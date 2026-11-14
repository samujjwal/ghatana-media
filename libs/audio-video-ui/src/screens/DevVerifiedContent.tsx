import React from "react";
import {
  describeContentFailure, readVerifiedContent,
  type DevArtifactContentReader, type DigestFunction, type RegisteredArtifact, type VerifiedContent,
} from "./devArtifactContent";

export type DevContentKind = "gif" | "mp4" | "wav" | "glb";
const EXTENSION: Readonly<Record<DevContentKind, string>> = { gif: "gif", mp4: "mp4", wav: "wav", glb: "glb" };
const LABEL: Readonly<Record<DevContentKind, string>> = { gif: "GIF", mp4: "MP4", wav: "WAV", glb: "GLB" };

export interface DevVerifiedContentProps {
  readonly reader: DevArtifactContentReader | undefined;
  readonly artifact: RegisteredArtifact;
  readonly kind: DevContentKind;
  /** GLB is download-only (a browser cannot preview it here). */
  readonly previewable?: boolean;
  readonly locked?: boolean;
  /** Test seam; defaults to the browser's SHA-256. */
  readonly digest?: DigestFunction;
  readonly maxBytes?: number;
}

type Phase = "idle" | "loading" | "verified" | "failed";

/**
 * Preview and Download for one registered artifact version. The content is read with the bearer token in a header,
 * and is shown or saved only after its SHA-256 equals the registered one. Mount it keyed by artifact version.
 */
export function DevVerifiedContent({ reader, artifact, kind, previewable = kind !== "glb", locked = false, digest, maxBytes }: DevVerifiedContentProps): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [message, setMessage] = React.useState("Content not loaded.");
  const [failure, setFailure] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState<string | null>(null);
  const verified = React.useRef<VerifiedContent | null>(null);
  const urlRef = React.useRef<string | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  }, []);

  const verify = async (): Promise<VerifiedContent | null> => {
    if (verified.current) return verified.current;
    if (!reader) return null;
    setPhase("loading"); setFailure(null);
    setMessage(`Reading ${artifact.artifactVersionId} and verifying its SHA-256…`);
    try {
      const content = await readVerifiedContent(reader, artifact, { ...(maxBytes === undefined ? {} : { maxBytes }), ...(digest ? { digest } : {}) });
      verified.current = content;
      return content;
    } catch (error) {
      verified.current = null;
      const shown = describeContentFailure(error);
      if (alive.current) { setPhase("failed"); setFailure(shown.code); setMessage(`${shown.code}: ${shown.text}`); }
      return null;
    }
  };

  const loadPreview = async (): Promise<void> => {
    if (phase === "loading") return;
    const content = await verify();
    if (!content || !alive.current) return;
    if (!urlRef.current) {
      urlRef.current = URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: content.contentType }));
      setUrl(urlRef.current);
    }
    setPhase("verified");
    setMessage(`Bytes verified against the registered version: SHA-256 ${content.sha256} (${content.bytes.byteLength} bytes).`);
  };

  const download = async (): Promise<void> => {
    if (phase === "loading") return;
    const content = await verify();
    if (!content || !alive.current) return;
    const saveUrl = urlRef.current ?? URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: content.contentType }));
    const anchor = document.createElement("a");
    anchor.href = saveUrl;
    anchor.download = `${artifact.artifactId}.${EXTENSION[kind]}`;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (!urlRef.current) setTimeout(() => URL.revokeObjectURL(saveUrl), 0);
    setPhase("verified");
    setMessage(`Bytes verified against the registered version: SHA-256 ${content.sha256}. Saved ${artifact.artifactId}.${EXTENSION[kind]} (${content.bytes.byteLength} bytes).`);
  };

  const noun = LABEL[kind];
  return <section aria-label={`${noun} content`} data-content-kind={kind} data-content-state={phase}>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the {noun} bytes cannot be previewed or saved here.</p>}
    {reader && <p>
      {previewable && <button type="button" onClick={() => void loadPreview()} disabled={locked || phase === "loading"}>Preview {noun} (verify bytes first)</button>}
      <button type="button" onClick={() => void download()} disabled={locked || phase === "loading"}>Download {noun}</button>
    </p>}
    {reader && <p role={phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={phase === "loading"}
      data-state={phase} data-failure={failure ?? undefined} className="dev-content-status">{message}</p>}
    {phase === "verified" && url && kind === "gif" && <img src={url} alt={`Preview of registered GIF ${artifact.artifactId}`} data-verified-preview="gif" />}
    {phase === "verified" && url && kind === "mp4" && <video src={url} controls preload="metadata" aria-label={`Preview of registered MP4 ${artifact.artifactId}`} data-verified-preview="mp4" />}
    {phase === "verified" && url && kind === "wav" && <audio src={url} controls preload="metadata" aria-label={`Preview of registered WAV ${artifact.artifactId}`} data-verified-preview="wav" />}
  </section>;
}
