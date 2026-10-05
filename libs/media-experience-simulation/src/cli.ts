import type { MediaAction, MediaExperienceState } from "./model.js";

export type MediaCliFormat = "human" | "json" | "jsonl";

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
  job inspect --job <id>
  job cancel --job <id>
  job reconcile --job <id>
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

  if (commandName === "job inspect" || commandName === "job cancel" || commandName === "job reconcile") {
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
    const reconcile = commandName === "job reconcile";
    return actionResult(
      reconcile ? "media.cli.job.reconcile" : cancel ? "media.cli.job.cancel" : "media.cli.job.inspect",
      { type: reconcile ? "media.action.reconcile-job" : cancel ? "media.action.request-cancellation" : "media.action.inspect-job" },
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
