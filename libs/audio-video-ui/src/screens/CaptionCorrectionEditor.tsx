import React from "react";
import { DevOutputsHostError, type Outcome } from "./devProjectOutputs";
import {
  buildCorrectionRequest, describeCaptionFailure, draftFrom, draftToCues, formatTimecode, isOpaqueId, parseCaptionVersion,
  parseTimecode, sameCues, validateDraft,
  type DevCaptionPort, type DevCaptionVersion, type DraftCue,
} from "./devCaptions";

export interface CaptionCorrectionEditorProps {
  readonly captions: DevCaptionPort;
  readonly locked?: boolean;
  /** Caption version to open on mount (for example from a link); the user can open any other id. */
  readonly initialCaptionId?: string;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
  /** Reports the exact version being edited (or null) so a review panel can bind that exact version. */
  readonly onCaptionChange?: (caption: DevCaptionVersion | null) => void;
}

type Pending = "open" | "save" | null;
type Attempt = { readonly fingerprint: string; readonly requestId: string };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};
const asHost = (error: unknown): DevOutputsHostError => error instanceof DevOutputsHostError ? error
  : new DevOutputsHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const KIND_NAME = {
  LOCAL_STT_WEBVTT_UNREVIEWED: "machine caption (unreviewed Whisper output)",
  LOCAL_CAPTION_USER_CORRECTED: "human-corrected caption",
} as const;
const toneHeading = (tone: Outcome["tone"]): string =>
  tone === "unknown" ? "Outcome unknown" : tone === "denied" ? "Denied" : tone === "unavailable" ? "Unavailable" : "Not saved";

/**
 * DEV_ONLY caption correction editor. A person edits cue text and timing on top of one exact caption version and saves
 * a NEW version (lineage to the machine version and to the corrector); the base is never overwritten, a stale base is a
 * conflict, and an unknown outcome is retried with the same request identity. Keyboard: every control is a native
 * input or button; Alt+ArrowUp/Down moves between cue texts and Ctrl/Cmd+Enter saves. No quality, approval or delivery
 * claim is made: use of the caption in a render needs an assigned reviewer's decision on the exact version.
 */
export function CaptionCorrectionEditor({ captions, locked = false, initialCaptionId, newRequestId = defaultRequestId, onCaptionChange }: CaptionCorrectionEditorProps): React.ReactElement {
  const [captionIdInput, setCaptionIdInput] = React.useState(initialCaptionId ?? "");
  const [base, setBase] = React.useState<DevCaptionVersion | null>(null);
  const [draft, setDraft] = React.useState<DraftCue[]>([]);
  const [pending, setPending] = React.useState<Pending>(null);
  const [message, setMessage] = React.useState("No caption version opened.");
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [lookupError, setLookupError] = React.useState("");
  const nextKey = React.useRef(1);
  const attempt = React.useRef<Attempt | null>(null);
  const textRefs = React.useRef(new Map<number, HTMLTextAreaElement>());
  const busy = pending !== null;
  const disabled = locked || busy;

  const validation = React.useMemo(() => validateDraft(draft), [draft]);
  const changed = base !== null && !sameCues(draftToCues(draft), base.cues);
  const canSave = base !== null && !disabled && changed && validation.summary.length === 0;

  const adopt = React.useCallback((view: DevCaptionVersion): void => {
    const rows = draftFrom(view.cues);
    nextKey.current = rows.length + 1;
    setBase(view);
    setDraft(rows);
    attempt.current = null;
    onCaptionChange?.(view);
  }, [onCaptionChange]);

  const open = async (rawId: string): Promise<void> => {
    const id = rawId.trim();
    setLookupError("");
    if (!isOpaqueId(id)) { setLookupError("Enter a caption version id (1-128 letters, digits, '.', '_', ':' or '-')."); return; }
    setPending("open");
    setOutcome(null);
    setMessage(`Opening caption version ${id}…`);
    try {
      const response = await captions.getCaption(id);
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const view = parseCaptionVersion(response.body);
      if (view.captionId !== id) throw new DevOutputsHostError("INVALID_RESPONSE", 200, "The host returned a different caption version.");
      adopt(view);
      setMessage(`Opened ${KIND_NAME[view.kind]} ${view.captionId} with ${view.cues.length} cue${view.cues.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setOutcome(describeCaptionFailure(asHost(error)));
      setMessage(`Caption version ${id} could not be opened.`);
    } finally {
      setPending(null);
    }
  };

  React.useEffect(() => {
    if (initialCaptionId) void open(initialCaptionId);
    // Open once for the supplied link; later changes are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<void> => {
    if (!base || !canSave) return;
    const fingerprint = `${base.captionId}|${base.artifactVersionId}|${JSON.stringify(draftToCues(draft))}`;
    const current = attempt.current && attempt.current.fingerprint === fingerprint
      ? attempt.current : { fingerprint, requestId: newRequestId() };
    attempt.current = current;
    setPending("save");
    setOutcome(null);
    setMessage("Saving a new caption version…");
    try {
      const request = buildCorrectionRequest(base, draft, current.requestId);
      const response = await captions.correctCaption(request);
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const view = parseCaptionVersion(response.body);
      if (view.kind !== "LOCAL_CAPTION_USER_CORRECTED" || view.parent?.artifactId !== base.captionId
        || view.parent.artifactVersionId !== base.artifactVersionId || view.captionId === base.captionId) {
        throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "The saved version does not descend from the edited version.");
      }
      if ((response.status === 200) !== view.replayed) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Status and replay flag disagree.");
      adopt(view);
      setCaptionIdInput(view.captionId);
      setMessage(view.replayed
        ? `Replayed (HTTP 200): the same request identity returned the version already saved, ${view.captionId}; no second version was created.`
        : `Saved (HTTP 201) as new version ${view.captionId} (correction ${view.correctionNumber}); the version you edited is unchanged. It is not reviewed yet.`);
    } catch (error) {
      const described = describeCaptionFailure(asHost(error));
      if (described.discardRequest) attempt.current = null;
      setOutcome(described);
      setMessage(described.tone === "unknown" ? "The save outcome is unknown." : "Nothing was saved.");
    } finally {
      setPending(null);
    }
  };

  const update = (key: number, patch: Partial<Pick<DraftCue, "start" | "end" | "text">>): void =>
    setDraft((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const insertAfter = (index: number): void => {
    const previous = draft[index];
    const start = previous ? parseTimecode(previous.end) ?? 0 : 0;
    const key = nextKey.current++;
    const row: DraftCue = { key, start: formatTimecode(start), end: formatTimecode(start + 2_000), text: "" };
    setDraft((rows) => [...rows.slice(0, index + 1), row, ...rows.slice(index + 1)]);
    queueMicrotask(() => textRefs.current.get(key)?.focus());
  };
  const remove = (index: number): void => {
    const neighbour = draft[index + 1] ?? draft[index - 1];
    setDraft((rows) => rows.filter((_, position) => position !== index));
    if (neighbour) queueMicrotask(() => textRefs.current.get(neighbour.key)?.focus());
  };
  const revert = (): void => { if (base) { adopt(base); setOutcome(null); setMessage("Edits discarded; the draft matches the opened version again."); } };
  const onTextKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>, index: number): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); return; }
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const target = draft[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (target) { event.preventDefault(); textRefs.current.get(target.key)?.focus(); }
    }
  };

  return <section id="caption-correction" aria-labelledby="caption-correction-title" className="caption-correction">
    <h2 id="caption-correction-title">Correct captions</h2>
    <p className="caption-note">DEV_ONLY. You edit the text and timing of one exact caption version; saving creates a NEW version with lineage to the machine caption and to you. The version you edited is never overwritten. Machine text is unreviewed. Nothing here is a quality, approval or delivery claim.</p>
    <form id="caption-open-form" onSubmit={(event) => { event.preventDefault(); void open(captionIdInput); }}>
      <label htmlFor="caption-id">Caption version id</label>
      <input id="caption-id" name="captionId" type="text" autoComplete="off" spellCheck={false} value={captionIdInput}
        disabled={disabled} aria-invalid={lookupError ? true : undefined} aria-describedby={lookupError ? "caption-id-error" : undefined}
        onChange={(event) => setCaptionIdInput(event.currentTarget.value)} />
      <button type="submit" disabled={disabled || captionIdInput.trim() === ""}>Open caption version</button>
      {lookupError && <p id="caption-id-error" role="alert" className="caption-error">{lookupError}</p>}
    </form>
    <p id="caption-status" role="status" aria-live="polite">{message}</p>
    {outcome && <div id="caption-outcome" role="alert" className={`caption-outcome caption-outcome-${outcome.tone}`} data-outcome-code={outcome.code}>
      <strong>{toneHeading(outcome.tone)}</strong> <span>{outcome.text}</span>
    </div>}
    {base && <>
      <dl id="caption-lineage" className="caption-lineage" aria-label="Caption version lineage">
        <dt>Version</dt><dd><code id="caption-version-id">{base.captionId}</code> <span>{KIND_NAME[base.kind]}</span></dd>
        <dt>Content version</dt><dd><code id="caption-content-version">{base.artifactVersionId}</code></dd>
        {base.parent && <><dt>Edited from</dt><dd><code id="caption-parent">{base.parent.artifactId}</code></dd></>}
        {base.machineVersion && <><dt>Machine caption</dt><dd><code id="caption-machine">{base.machineVersion.artifactId}</code></dd></>}
        {base.correctedByPrincipalId && <><dt>Corrected by</dt><dd><code id="caption-corrector">{base.correctedByPrincipalId}</code> (a DEV_ONLY principal, not a verified human)</dd></>}
        {base.edit && <><dt>Changes from parent</dt><dd id="caption-edit">{base.edit.textChanged} text, {base.edit.timingChanged} timing, {base.edit.added} added, {base.edit.removed} removed</dd></>}
        <dt>Review</dt><dd id="caption-review">{base.review.acceptedByAssignedReviewer
          ? "Accepted by an assigned reviewer for this exact version (a DEV_ONLY statement, not an approval)."
          : base.review.available
            ? `Not accepted for use${base.review.latestDecision && base.review.latestDecision !== "NONE" ? ` (latest decision ${base.review.latestDecision}, ${String(base.review.currentness).toLowerCase()})` : ""}. An assigned reviewer must accept this exact version before it can be used in a render.`
            : "The review lane is not enabled on this host."}</dd>
      </dl>
      <form id="caption-edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-describedby="caption-keys">
        <p id="caption-keys" className="caption-hint">Keyboard: Tab between fields; Alt+ArrowUp or Alt+ArrowDown moves between cue texts; Ctrl+Enter (Cmd+Enter) saves.</p>
        {validation.summary.length > 0 && <ul id="caption-validation" className="caption-error" aria-label="Problems to fix before saving">
          {validation.summary.map((line) => <li key={line}>{line}</li>)}
        </ul>}
        <ol className="caption-cues" aria-label="Caption cues">
          {draft.map((cue, index) => {
            const errors = validation.rows[index] ?? {};
            const id = `cue-${cue.key}`;
            return <li key={cue.key}>
              <fieldset disabled={disabled}>
                <legend>Cue {index + 1}</legend>
                <label htmlFor={`${id}-start`}>Cue {index + 1} start</label>
                <input id={`${id}-start`} type="text" inputMode="decimal" autoComplete="off" value={cue.start}
                  aria-invalid={errors.start ? true : undefined} aria-describedby={errors.start ? `${id}-start-error` : undefined}
                  onChange={(event) => update(cue.key, { start: event.currentTarget.value })} />
                {errors.start && <span id={`${id}-start-error`} className="caption-error">{errors.start}</span>}
                <label htmlFor={`${id}-end`}>Cue {index + 1} end</label>
                <input id={`${id}-end`} type="text" inputMode="decimal" autoComplete="off" value={cue.end}
                  aria-invalid={errors.end ? true : undefined} aria-describedby={errors.end ? `${id}-end-error` : undefined}
                  onChange={(event) => update(cue.key, { end: event.currentTarget.value })} />
                {errors.end && <span id={`${id}-end-error`} className="caption-error">{errors.end}</span>}
                <label htmlFor={`${id}-text`}>Cue {index + 1} text</label>
                <textarea id={`${id}-text`} rows={2} value={cue.text} spellCheck
                  ref={(node) => { if (node) textRefs.current.set(cue.key, node); else textRefs.current.delete(cue.key); }}
                  aria-invalid={errors.text ? true : undefined} aria-describedby={errors.text ? `${id}-text-error` : undefined}
                  onKeyDown={(event) => onTextKeyDown(event, index)}
                  onChange={(event) => update(cue.key, { text: event.currentTarget.value })} />
                {errors.text && <span id={`${id}-text-error`} className="caption-error">{errors.text}</span>}
                <button type="button" onClick={() => insertAfter(index)}>Insert cue after {index + 1}</button>
                <button type="button" onClick={() => remove(index)} disabled={disabled || draft.length <= 1}>Remove cue {index + 1}</button>
              </fieldset>
            </li>;
          })}
        </ol>
        <p id="caption-dirty" aria-live="polite">{changed ? "You have unsaved edits." : "No edits yet."}</p>
        <button id="caption-save" type="submit" disabled={!canSave}>Save as new caption version</button>
        <button id="caption-revert" type="button" onClick={revert} disabled={disabled || !changed}>Discard edits</button>
      </form>
    </>}
  </section>;
}
