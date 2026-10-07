import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";

export type ArtifactIntakeView = "browse-media" | "import-media" | "job-status" | "inspect-media";

export interface ArtifactIntakeProjection {
  readonly view: ArtifactIntakeView;
  readonly workspaceName?: string;
  readonly projectName?: string;
  readonly artifacts?: readonly {
    readonly id: string;
    readonly name: string;
    readonly version?: string;
    readonly integrity?: string;
    readonly availability?: string;
  }[];
  readonly sourceName?: string;
  readonly uploadId?: string;
  readonly acknowledgedTransfer?: string;
  readonly integrity?: string;
  readonly verificationJobId?: string;
  readonly verificationState?: string;
  readonly message?: string;
}

export interface ArtifactIntakeScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly intake: ArtifactIntakeProjection;
  /** Transfer selection is handed to the host; the component does not upload bytes. */
  readonly onSourceFilesSelected?: (files: readonly File[]) => void;
}

/** Candidate J-02 screen body. Upload and verification outcomes are observations supplied by the host. */
export function ArtifactIntakeScreen({ intake, onSourceFilesSelected, ...flow }: ArtifactIntakeScreenProps): React.ReactElement {
  const heading = {
    "browse-media": "Media library",
    "import-media": "Import media",
    "job-status": "Verification status",
    "inspect-media": "Artifact details",
  }[intake.view];
  return <MediaTaskScreen {...flow}>
    <section className="media-screen-body" aria-labelledby="artifact-intake-title">
      <header>
        <h3 id="artifact-intake-title">{heading}</h3>
        <p>
          {[intake.workspaceName, intake.projectName].filter(Boolean).join(" · ")}
        </p>
      </header>
      {intake.message && <p role="status">{intake.message}</p>}
      {intake.view === "import-media" && <div>
        <label htmlFor="media-source-files">Choose source media</label>
        <input id="media-source-files" type="file" multiple aria-describedby="media-upload-disclosure"
          onChange={(event) => onSourceFilesSelected?.(Array.from(event.currentTarget.files ?? []))}
          />
        <p id="media-upload-disclosure">Only server-acknowledged transfer and recorded integrity results are shown as confirmed.</p>
        {intake.sourceName && <p>Selected source: <strong>{intake.sourceName}</strong></p>}
        {intake.uploadId && <p>Upload ID: <code>{intake.uploadId}</code></p>}
        {intake.acknowledgedTransfer && <p>Server-acknowledged transfer: {intake.acknowledgedTransfer}</p>}
        {intake.integrity && <p>Integrity: {intake.integrity}</p>}
      </div>}
      {intake.view === "job-status" && <dl>
        <div><dt>Verification job</dt><dd>{intake.verificationJobId ?? "Not available"}</dd></div>
        <div><dt>Observed state</dt><dd role="status">{intake.verificationState ?? "Outcome not yet observed"}</dd></div>
      </dl>}
      {(intake.view === "browse-media" || intake.view === "inspect-media") && <>
        {intake.artifacts?.length ? <ul aria-label="Media artifacts">
          {intake.artifacts.map((artifact) => <li key={artifact.id}>
            <p>{artifact.name}{artifact.version ? ` · ${artifact.version}` : ""}</p>
            <p>Artifact ID: {artifact.id}</p>
            {(artifact.integrity || artifact.availability) && <p>{[artifact.integrity, artifact.availability].filter(Boolean).join(" · ")}</p>}
          </li>)}
        </ul> : <p>No artifact records are available in this projection.</p>}
      </>}
    </section>
  </MediaTaskScreen>;
}
