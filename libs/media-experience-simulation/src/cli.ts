import type { MediaAction, MediaExperienceState } from "./model.js";

export type MediaCliFormat = "human" | "json" | "jsonl";

export interface MediaCliHumanReport {
  readonly applied: boolean;
  readonly reasonCode?: string | null;
  readonly message: string;
  readonly workflow: string;
  readonly state: string;
  readonly finality: string;
  readonly workflowState?: string | null;
  readonly jobId?: string | null;
  readonly uploadId?: string | null;
  readonly verificationStage?: string | null;
  readonly sourceVersion?: string | null;
  readonly resultVersion?: string | null;
  readonly nextAction?: string | null;
  readonly effectIds?: readonly string[];
}

export type MediaCliParseResult =
  | { readonly kind: "help"; readonly text: string }
  | {
      readonly kind: "action";
      readonly commandId: string;
      readonly action: MediaAction;
      readonly format: MediaCliFormat;
    }
  | { readonly kind: "error"; readonly message: string };

const commandHelp = `ghatana-media — Media command simulation over deterministic fixtures

Usage:
  ghatana-media --scenario <fixture-id> <command> [options]
  ghatana-media <command> [options]

  Commands:
  upload inspect --upload <id> [--format human|json|jsonl]
  upload resume --upload <id> [--format human|json|jsonl]
  transcribe --source-version <id> --language <tag>
  transcript review --transcript-version <id>
  job status --job <id>
  job cancel --job <id>
  job check-outcome --job <id>
  caption correct-text --artifact-version <draft-id> --segment <id> --text <text>
  caption align-timing --artifact-version <draft-id> --segment <id> --start-tick <tick> --end-tick <tick>
  caption save-version --draft-version <id> --purpose <text>
  caption compare-versions --left-version <id> --right-version <id>

Global option: --format human|json|jsonl (defaults to human).
Use --option=value when a value itself begins with '--', such as --text=--speaker.
The default scenario is media.scenario.transcript-ready.
This command runs synthetic fixture state only. It does not call the Media runtime or a provider.
`;

interface TokenResult {
  readonly tokens: readonly string[];
  readonly error?: string;
}

function tokenize(input: string): TokenResult {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped) return { tokens, error: "The command ends with an incomplete escape." };
  if (quote) return { tokens, error: "Close the quoted command value before running it." };
  if (tokenStarted) tokens.push(token);
  return { tokens };
}

function error(message: string): MediaCliParseResult {
  return { kind: "error", message };
}

function parseOptions(
  tokens: readonly string[],
  allowedOptions: readonly string[],
): { readonly options: Readonly<Record<string, string>>; readonly error?: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) return { options: values, error: `Unexpected argument '${token}'.` };
    const separator = token.indexOf("=");
    const name = separator >= 0 ? token.slice(0, separator) : token;
    if (!allowedOptions.includes(name)) return { options: values, error: `Unknown option '${name}'.` };
    if (Object.hasOwn(values, name)) return { options: values, error: `Option '${name}' can only be supplied once.` };
    const inlineValue = separator >= 0 ? token.slice(separator + 1) : undefined;
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("--"))) {
      return { options: values, error: `Option '${name}' requires a value.` };
    }
    values[name] = value;
    if (inlineValue === undefined) index += 1;
  }
  return { options: values };
}

function requireOptions(
  options: Readonly<Record<string, string>>,
  required: readonly string[],
): string | undefined {
  const missing = required.filter((name) => !options[name]?.trim());
  return missing.length ? `Missing required option${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` : undefined;
}

function outputOptions(options: Readonly<Record<string, string>>): {
  readonly format: MediaCliFormat;
  readonly error?: string;
} {
  const format = options["--format"] ?? "human";
  if (!(["human", "json", "jsonl"] as string[]).includes(format)) {
    return { format: "human", error: `Unsupported format '${format}'. Choose human, json, or jsonl.` };
  }
  return { format: format as MediaCliFormat };
}

export function requestedMediaCliFormat(input: string | readonly string[]): MediaCliFormat {
  const tokenResult = typeof input === "string" ? tokenize(input) : { tokens: input };
  if (tokenResult.error) return "human";
  const tokens = tokenResult.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const format = token === "--format"
      ? tokens[index + 1]
      : token.startsWith("--format=")
        ? token.slice("--format=".length)
        : undefined;
    if (format === "human" || format === "json" || format === "jsonl") return format;
  }
  return "human";
}

export function formatMediaCliError(message: string, format: MediaCliFormat): string {
  if (format === "json") {
    return `${JSON.stringify({ schemaVersion: "media.cli-error.v1", code: "INVALID_ARGUMENT", message }, null, 2)}\n`;
  }
  if (format === "jsonl") {
    return `${JSON.stringify({ recordType: "error", schemaVersion: "media.cli-error.v1", code: "INVALID_ARGUMENT", message })}\n`;
  }
  return `${message}\n`;
}

const actionLabels: Readonly<Record<MediaAction["type"], string>> = {
  "media.action.create-project": "Create a project",
  "media.action.inspect-project-creation": "Inspect project creation status",
  "media.action.inspect-artifact": "Inspect this artifact version",
  "media.action.resume-artifact-upload": "Resume this upload",
  "media.action.choose-source": "Choose a recording",
  "media.action.request-transcription": "Transcribe this recording",
  "media.action.inspect-source": "Inspect this recording",
  "media.action.seek-source": "Move to a point in the recording",
  "media.action.review-transcript": "Review recognized text",
  "media.action.view-job-status": "View job status",
  "media.action.inspect-provenance": "Inspect source and result history",
  "media.action.correct-caption": "Correct caption text",
  "media.action.compare-caption-versions": "Compare caption versions",
  "media.action.resolve-caption-conflict": "Resolve this caption conflict",
  "media.action.align-caption-timing": "Correct caption timing",
  "media.action.save-caption-version": "Save this caption version",
  "media.action.request-cancellation": "Request to stop this job",
  "media.action.check-job-outcome": "Check job outcome",
};

const effectLabels: Readonly<Record<string, string>> = {
  "media.effect.cancellation-requested": "Cancellation requested",
  "media.effect.caption-conflict-resolved": "Caption conflict resolved",
  "media.effect.caption-draft-updated": "Caption draft updated",
  "media.effect.caption-timing-updated": "Caption timing updated",
  "media.effect.caption-version-registered": "Caption version saved",
  "media.effect.consent-revoked": "Consent revoked",
  "media.effect.empty-project-created-in-fixture": "Synthetic empty project created",
  "media.effect.existing-job-outcome-check-started": "Existing job outcome check started",
  "media.effect.in-flight-work-requires-outcome-check": "Active work needs its outcome checked",
  "media.effect.job-cancelled-before-dispatch": "Job cancelled before dispatch",
  "media.effect.simulated-cancellation-confirmed": "Cancellation confirmed in simulation",
  "media.effect.simulated-job-completed-result-lifecycle-pending": "Job completed; result lifecycle remains pending in simulation",
  "media.effect.simulated-job-started": "Job started in simulation",
  "media.effect.simulated-outcome-unknown": "Job outcome not confirmed in simulation",
  "media.effect.simulated-outcome-check-recorded": "Checked outcome recorded in simulation",
  "media.effect.simulated-transcript-available": "Transcript available in simulation",
  "media.effect.source-position-changed": "Source position changed",
  "media.effect.source-selected": "Source selected",
  "media.effect.transcription-request-recorded": "Transcription request recorded in simulation",
  "media.effect.upload-resume-simulated": "Upload resume simulated",
};

function displayStatus(value: string | null | undefined): string {
  const labels: Readonly<Record<string, string>> = {
    NOT_APPLICABLE: "Not applicable",
    NOT_SUBMITTED: "Not submitted",
    OUTCOME_UNKNOWN: "Outcome not confirmed",
    RECONCILING: "Checking outcome",
  };
  return labels[value ?? ""] ?? String(value ?? "not available")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function formatMediaCliHumanResult(report: MediaCliHumanReport): string {
  const workflowStatus = report.workflow === "artifact-verification" && report.jobId && report.uploadId
    ? `Verification job: ${displayStatus(report.state)} (${displayStatus(report.finality)}) · ${report.jobId}\nRelated upload: ${report.uploadId}${report.verificationStage ? `\nVerification stage: ${displayStatus(report.verificationStage)}` : ""}`
    : report.workflow === "artifact-intake" && report.uploadId
      ? `Upload: ${displayStatus(report.workflowState ?? report.state)} (${displayStatus(report.finality)}) · ${report.uploadId}`
      : report.jobId
        ? `Job: ${displayStatus(report.state)} (${displayStatus(report.finality)}) · ${report.jobId}`
        : `Workflow: ${report.workflow} · ${displayStatus(report.workflowState ?? report.state)}`;
  const nextAction = report.nextAction && report.nextAction !== "none"
    ? actionLabels[report.nextAction as MediaAction["type"]]
      ?? report.nextAction.replace(/^media\.action\./u, "").replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())
    : "none";
  return [
    `${report.applied ? "Applied" : `Blocked (${report.reasonCode ?? "UNKNOWN"})`}: ${report.message}`,
    workflowStatus,
    ...(report.sourceVersion ? [`Source version: ${report.sourceVersion}`] : []),
    `Result version: ${report.resultVersion ?? "not available"}`,
    `Next safe action: ${nextAction}`,
    ...(report.effectIds?.length ? [`Effects: ${report.effectIds.map((effect) => effectLabels[effect] ?? effect.replace(/^media\.effect\./u, "").replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())).join(", ")}`] : []),
  ].join("\n") + "\n";
}

function actionResult(
  commandId: string,
  action: MediaAction,
  options: Readonly<Record<string, string>>,
): MediaCliParseResult {
  const output = outputOptions(options);
  if (output.error) return error(output.error);
  return {
    kind: "action",
    commandId,
    action,
    format: output.format,
  };
}

export function parseMediaCommand(
  state: MediaExperienceState,
  input: string | readonly string[],
): MediaCliParseResult {
  const tokenResult = typeof input === "string" ? tokenize(input) : { tokens: input };
  if (tokenResult.error) return error(tokenResult.error);
  const tokens = [...tokenResult.tokens];
  if (!tokens.length) return error("Enter a command. Use 'ghatana-media --help' for usage.");

  if (tokens[0] === "help" || tokens[0] === "ghatana-media" && ["--help", "-h"].includes(tokens[1] ?? "")) {
    return { kind: "help", text: commandHelp };
  }
  if (tokens[0] !== "ghatana-media") return error("Commands must start with 'ghatana-media'.");
  const args = tokens.slice(1);
  let commandName = args[0] ?? "";
  let optionStart = 1;
  if (["transcript", "job", "caption", "upload"].includes(commandName)) {
    commandName = `${commandName} ${args[1] ?? ""}`;
    optionStart = 2;
  }
  const rest = args.slice(optionStart);

  if (commandName === "upload inspect" || commandName === "upload resume") {
    const parsed = parseOptions(rest, ["--upload", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--upload"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--upload"] !== state.artifactIntake?.uploadId) {
      return error("The requested upload identifier is not the current upload in this scenario.");
    }
    const resume = commandName === "upload resume";
    return actionResult(
      resume ? "media.cli.upload.resume" : "media.cli.upload.inspect",
      { type: resume ? "media.action.resume-artifact-upload" : "media.action.inspect-artifact" },
      parsed.options,
    );
  }

  if (commandName === "transcribe") {
    if (state.workflow !== "transcription") return error("Transcription commands require a transcription workflow fixture.");
    const parsed = parseOptions(rest, ["--source-version", "--language", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--source-version", "--language"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--source-version"] !== state.source.artifactVersion) {
      return error(`Source version '${parsed.options["--source-version"]}' is not the current source version '${state.source.artifactVersion}'.`);
    }
    let languageTag: string;
    try {
      languageTag = Intl.getCanonicalLocales(parsed.options["--language"]!)[0] ?? "";
    } catch {
      return error(`Language tag '${parsed.options["--language"]}' is not a valid BCP 47 tag.`);
    }
    if (!languageTag) return error("Choose a valid language tag.");
    return actionResult("media.cli.transcribe", { type: "media.action.request-transcription", languageTag }, parsed.options);
  }

  if (commandName === "transcript review") {
    const parsed = parseOptions(rest, ["--transcript-version", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--transcript-version"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--transcript-version"] !== state.transcript.versionId) return error("The requested transcript version is not the current readable transcript.");
    return actionResult("media.cli.transcript.review", { type: "media.action.review-transcript" }, parsed.options);
  }

  if (commandName === "job status" || commandName === "job cancel" || commandName === "job check-outcome") {
    const parsed = parseOptions(rest, ["--job", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--job"]);
    if (requiredError) return error(requiredError);
    const cancel = commandName === "job cancel";
    if (cancel && state.workflow !== "transcription") {
      return error("Job cancellation is only modeled for transcription job fixtures in this simulator.");
    }
    const currentJobId = state.workflow === "artifact-verification"
      ? state.artifactVerification.jobId
      : state.job.jobId;
    if (parsed.options["--job"] !== currentJobId) return error("The requested job identifier is not the current job in this scenario.");
    const checkOutcome = commandName === "job check-outcome";
    return actionResult(
      checkOutcome ? "media.cli.job.check-outcome" : cancel ? "media.cli.job.cancel" : "media.cli.job.status",
      { type: checkOutcome ? "media.action.check-job-outcome" : cancel ? "media.action.request-cancellation" : "media.action.view-job-status" },
      parsed.options,
    );
  }

  if (commandName === "caption correct-text") {
    const parsed = parseOptions(rest, ["--artifact-version", "--segment", "--text", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--artifact-version", "--segment", "--text"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--artifact-version"] !== state.captionDraft.versionId) return error("The requested caption draft is not the current draft version.");
    return actionResult("media.cli.caption.correct-text", {
      type: "media.action.correct-caption",
      segmentId: parsed.options["--segment"]!,
      text: parsed.options["--text"]!,
    }, parsed.options);
  }

  if (commandName === "caption align-timing") {
    const parsed = parseOptions(rest, ["--artifact-version", "--segment", "--start-tick", "--end-tick", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--artifact-version", "--segment", "--start-tick", "--end-tick"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--artifact-version"] !== state.captionDraft.versionId) return error("The requested caption draft is not the current draft version.");
    const startTick = Number(parsed.options["--start-tick"]);
    const endTick = Number(parsed.options["--end-tick"]);
    if (!Number.isSafeInteger(startTick) || !Number.isSafeInteger(endTick)) return error("Start and end ticks must be safe integers on the exact source clock.");
    return actionResult("media.cli.caption.align-timing", {
      type: "media.action.align-caption-timing",
      segmentId: parsed.options["--segment"]!,
      startTick,
      endTick,
    }, parsed.options);
  }

  if (commandName === "caption save-version") {
    const parsed = parseOptions(rest, ["--draft-version", "--purpose", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--draft-version", "--purpose"]);
    if (requiredError) return error(requiredError);
    if (parsed.options["--draft-version"] !== state.captionDraft.versionId) return error("The requested caption draft is not the current draft version.");
    if (parsed.options["--purpose"]!.length > 240) return error("The version purpose must be 240 characters or fewer.");
    return actionResult("media.cli.caption.save-version", {
      type: "media.action.save-caption-version",
      purpose: parsed.options["--purpose"]!,
    }, parsed.options);
  }

  if (commandName === "caption compare-versions") {
    const parsed = parseOptions(rest, ["--left-version", "--right-version", "--format"]);
    if (parsed.error) return error(parsed.error);
    const requiredError = requireOptions(parsed.options, ["--left-version", "--right-version"]);
    if (requiredError) return error(requiredError);
    return actionResult("media.cli.caption.compare-versions", {
      type: "media.action.compare-caption-versions",
      leftVersionId: parsed.options["--left-version"]!,
      rightVersionId: parsed.options["--right-version"]!,
    }, parsed.options);
  }

  return error(`Unknown command '${commandName}'. Use 'ghatana-media --help' to list supported commands.`);
}

export const mediaCliHelp = commandHelp;
