import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityContextBoundary } from "../components/MediaComponentFamilies";
import type { MediaActionPort, MediaContextPort, MediaDataPort } from "../ports";
import { canonicalMediaActionRequest } from "../ports";
import { MEDIA_SCREEN_COMPONENTS, MediaContractScreen, type MediaContractScreenProps } from "./MediaContractScreen";
import { MediaProductRenderer } from "./MediaProductRenderer";
import { validateMediaFamilyProjection } from "../components/MediaComponentRuntimeContracts";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";
import { MEDIA_LOCAL_ACTION_IDS } from "./MediaLocalActionContracts";

const data: MediaDataPort = {
  currentProjection: {
    title: "Resolve workspace context",
    description: "Return to the requested destination only after the host confirms context.",
    steps: [{ id: "identity", title: "Resolve identity", description: "Complete upstream identity handoff.", state: "current" }],
    currentStepId: "identity",
  },
};
const context: MediaContextPort = { locale: "en-US", direction: "ltr" };
const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "req-1" }));
const actionPort: MediaActionPort = { invoke };
const identityProps = {
  requestedDestinationRef: "media.view.find-projects",
  handoffState: "context-denied",
  safeReturnIntent: "media.action.return-to-requested-destination-after-identity-confirmation",
  state: "context-denied",
  variant: "context-denied",
  actionIntents: [],
  keyboardBehavior: "preserve-return-focus-and-destination-across-the-upstream-handoff",
} as const;
const instance = {
  componentId: "media.component.identity-context-boundary",
  props: identityProps,
} as const;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const screenContractDirectory = resolve(repositoryRoot, ".product-experience/pdp-3-product-experience/screen-contracts");

function readSourceList(source: string, key: "componentIds" | "actions"): string[] | undefined {
  if (key === "actions") return [...source.matchAll(/^\s+- actionId:\s*(\S+)\s*$/gmu)].map((match) => match[1]!);
  const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "mu").exec(source)?.[1];
  if (inline !== undefined) return inline.trim() ? inline.split(",").map((value) => value.trim()) : [];
  const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]+- [^\\n]*\\n?)+)`, "mu").exec(source)?.[1];
  return block?.split("\n").map((line) => /^\s+-\s+(.+)$/.exec(line)?.[1]?.trim()).filter((value): value is string => value !== undefined);
}

describe("Media contract screen composition", () => {
  it("keeps the immediate local-applied result allowlist exact to source local finality", () => {
    const actionSource = readFileSync(resolve(repositoryRoot, ".product-experience/pdp-3-product-experience/action-registry.yaml"), "utf8");
    const sourceLocalIds = actionSource.split(/(?=^- id: )/mu).flatMap((block) => {
      const id = /^- id: (.+)$/mu.exec(block)?.[1];
      const finality = /^  finality: (.+)$/mu.exec(block)?.[1] ?? "";
      return id && /(?:local-selection-only|local-only|local-draft-only|not-a-committed-result)/u.test(finality) ? [id] : [];
    }).sort();
    expect([...MEDIA_LOCAL_ACTION_IDS].sort()).toEqual(sourceLocalIds);
  });

  it("indexes every current screen contract with componentRefs and retains exact component order", () => {
    expect(Object.keys(MEDIA_SCREEN_COMPONENTS)).toHaveLength(47);
    for (const [screenId, contract] of Object.entries(MEDIA_SCREEN_COMPONENTS)) {
      expect(screenId).toMatch(/^media\.view\./u);
      expect(contract.componentRefs.every((id) => id.startsWith("media.component."))).toBe(true);
      expect(new Set(contract.actions).size).toBe(contract.actions.length);
    }
    expect(MEDIA_SCREEN_COMPONENTS["media.view.authenticate-and-select-context"].componentRefs)
      .toEqual(["media.component.identity-context-boundary"]);
    expect(MEDIA_SCREEN_COMPONENTS["media.view.select-source"].componentRefs).toEqual([
      "media.component.project-context-summary", "media.component.artifact-source-picker",
      "media.component.artifact-integrity-summary", "media.component.rights-retention-review",
    ]);
    expect(MEDIA_SCREEN_COMPONENTS["media.view.monitor-transcription"].componentRefs).toEqual([
      "media.component.job-status-card", "media.component.activity-recovery-feed",
    ]);
  });

  it("matches all source screen component/action identities, including the six completed anatomy compositions", () => {
    const sourceScreens = readdirSync(screenContractDirectory)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => {
        const source = readFileSync(resolve(screenContractDirectory, name), "utf8");
        return {
          screenId: /^screenId:\s*(\S+)\s*$/mu.exec(source)?.[1],
          componentIds: readSourceList(source, "componentIds"),
          actions: readSourceList(source, "actions"),
        };
      })
      .filter((screen) => typeof screen.screenId === "string");
    expect(sourceScreens).toHaveLength(47);
    expect(Object.keys(MEDIA_SCREEN_COMPONENTS).sort()).toEqual(sourceScreens.map((screen) => screen.screenId!).sort());
    for (const screen of sourceScreens) {
      expect(MEDIA_SCREEN_COMPONENTS[screen.screenId as keyof typeof MEDIA_SCREEN_COMPONENTS]).toEqual({
        componentRefs: screen.componentIds,
        actions: screen.actions,
      });
    }
  });

  it("routes a source-defined screen through MediaProductRenderer and renders denied context without leaking ready actions", () => {
    const props: MediaContractScreenProps = {
      screenId: "media.view.authenticate-and-select-context",
      instances: [instance],
      actions: [{ id: "media.action.return-to-requested-destination-after-identity-confirmation", label: "Return", enabled: false, disabledReason: "Context was denied." }],
      data,
      actionPort,
      context,
    };
    const element = MediaProductRenderer({ kind: "contract-screen", ...props });
    expect(element.type).toBe(MediaContractScreen);
    const html = renderToStaticMarkup(React.createElement(MediaProductRenderer, { kind: "contract-screen", ...props }));
    expect(html).toContain("Authenticate And Select Context");
    expect(html).toContain("context-denied");
    expect(html).toContain("media.view.find-projects");
    expect(html).toContain("Context was denied.");
    expect(html).toMatch(/<button[^>]*disabled=""/u);
  });

  it("fails closed when component refs differ and withholds actions not declared by the screen", () => {
    const invalid = React.createElement(MediaContractScreen, {
      screenId: "media.view.authenticate-and-select-context",
      instances: [],
      actions: [{ id: "media.action.return-to-requested-destination-after-identity-confirmation", label: "Return", enabled: true }],
      data,
      actionPort,
      context,
    });
    const invalidHtml = renderToStaticMarkup(invalid);
    expect(invalidHtml).toContain("does not match its source contract");
    expect(invalidHtml).not.toContain("Return</button>");

    const noIntent = React.createElement(IdentityContextBoundary, identityProps);
    expect(renderToStaticMarkup(noIntent)).not.toContain("Available component actions");

    const unsupportedScreenAction = React.createElement(MediaContractScreen, {
      screenId: "media.view.authenticate-and-select-context",
      instances: [instance],
      actions: [{ id: "media.action.invented", label: "Invented action", enabled: true }],
      data,
      actionPort,
      context,
    });
    const unsupportedHtml = renderToStaticMarkup(unsupportedScreenAction);
    expect(unsupportedHtml).toContain("not defined for this screen and were withheld");
    expect(unsupportedHtml).not.toContain("Invented action");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps identity handoff actions at screen level when the family contract declares display-only", () => {
    const action = { id: "media.action.return-to-requested-destination-after-identity-confirmation", label: "Return", enabled: true, payload: { destination: "media.view.find-projects" } };
    const element = React.createElement(MediaContractScreen, {
      screenId: "media.view.authenticate-and-select-context",
      instances: [instance],
      actions: [action],
      data,
      actionPort,
      context,
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Return");
    expect(html).toContain('data-component-id="media.component.identity-context-boundary"');
    expect(html).not.toContain("Available component actions");
    expect(html).not.toContain("style=");
  });

  it("withholds forged runtime component states before composing the screen", () => {
    const forged = React.createElement(MediaContractScreen, {
      screenId: "media.view.authenticate-and-select-context",
      instances: [{
        componentId: "media.component.identity-context-boundary",
        props: { ...identityProps, state: "ready" },
      }],
      actions: [{ id: "media.action.return-to-requested-destination-after-identity-confirmation", label: "Return", enabled: true }],
      data,
      actionPort,
      context,
    } as unknown as MediaContractScreenProps);
    const html = renderToStaticMarkup(forged);
    expect(html).toContain("does not match its source contract");
    expect(html).toContain("State is outside the exact family contract.");
    expect(html).not.toContain("Return</button>");
  });

  it("validates the exact family required props and closed state/action/keyboard unions at the renderer boundary", () => {
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", identityProps).valid).toBe(true);
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", { ...identityProps, state: "ready" }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", { ...identityProps, variant: "ready" }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", { ...identityProps, actionIntents: ["media.action.invented"] }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", { ...identityProps, keyboardBehavior: "tab order guessed" }).valid).toBe(false);
    const { requestedDestinationRef: _destination, ...missingRequired } = identityProps;
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", missingRequired).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.identity-context-boundary", { ...identityProps, unsupported: true }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.unknown", identityProps).valid).toBe(false);
  });

  it("validates nested source references and candidate values against the family input schema", () => {
    const sourcePicker = {
      workspaceRef: { tenantId: "tenant-a", workspaceId: "workspace-a" },
      targetProjectRef: { tenantId: "tenant-a", projectId: "project-a" },
      query: { text: "interview", mediaTypes: ["audio/wav"], limit: 20 },
      sourceCandidates: [{
        versionRef: { tenantId: "tenant-a", artifactId: "artifact-a", versionId: "v3" },
        mediaType: "audio/wav",
        access: "authorized",
        rightsDisposition: "permitted-with-scope",
        sourceName: "Interview",
      }],
      selectionState: "available",
      state: "selected",
      variant: "selected",
      actionIntents: ["media.action.choose-source"],
      keyboardBehavior: "native-selection-controls; complete-row-selection; visible-focus",
    };
    expect(validateMediaFamilyProjection("media.component.source-picker", sourcePicker).valid).toBe(true);
    expect(validateMediaFamilyProjection("media.component.source-picker", {
      ...sourcePicker,
      sourceCandidates: [null],
    }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.source-picker", {
      ...sourcePicker,
      sourceCandidates: [{ ...sourcePicker.sourceCandidates[0], versionRef: { artifactId: "artifact-a", versionId: "v3" } }],
    }).valid).toBe(false);
    expect(validateMediaFamilyProjection("media.component.source-picker", {
      ...sourcePicker,
      sourceCandidates: [{ ...sourcePicker.sourceCandidates[0], mediaType: "not a media type" }],
    }).valid).toBe(false);
  });

  it("blocks same-action double dispatch synchronously until the first request settles", async () => {
    let resolveFirst!: (value: { status: "request-acknowledged"; requestId: string }) => void;
    const hostInvoke = vi.fn(() => new Promise<{ status: "request-acknowledged"; requestId: string }>((resolve) => { resolveFirst = resolve; }));
    const guard = createMediaActionDispatchGuard({ invoke: hostInvoke });
    const context = { subjectRefs: ["tenant-a:caption-draft-7@v2"] };
    const first = guard.actionPort.invoke("media.action.save-caption-version", { draftRef: "caption-draft-7@v2" }, context);
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(true);
    const duplicate = await guard.actionPort.invoke("media.action.save-caption-version", { draftRef: "caption-draft-7@v2" }, context);
    expect(duplicate).toEqual({ status: "unavailable", reason: expect.stringContaining("already in flight") });
    expect(hostInvoke).toHaveBeenCalledTimes(1);
    resolveFirst({ status: "request-acknowledged", requestId: "req-1" });
    await expect(first).resolves.toEqual({ status: "request-acknowledged", requestId: "req-1" });
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(true);
    const requestCanonical = canonicalMediaActionRequest("media.action.save-caption-version", { draftRef: "caption-draft-7@v2" }, context);
    guard.observeReconciliations([{
      actionId: "media.action.save-caption-version", reconciliationRevision: "rev-foreign", requestId: "req-foreign", requestCanonical,
      subjectRefs: context.subjectRefs, disposition: "retry-authorized",
    }]);
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(true);
    guard.observeReconciliations([{
      actionId: "media.action.save-caption-version", reconciliationRevision: "rev-pending", requestId: "req-1", requestCanonical,
      subjectRefs: context.subjectRefs, disposition: "pending",
    }]);
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(true);
    guard.observeReconciliations([{
      actionId: "media.action.save-caption-version", reconciliationRevision: "rev-pending", requestId: "req-1", requestCanonical,
      subjectRefs: context.subjectRefs, disposition: "retry-authorized",
    }]);
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(true);
    guard.observeReconciliations([{
      actionId: "media.action.save-caption-version", reconciliationRevision: "rev-authorized", requestId: "req-1", requestCanonical,
      subjectRefs: context.subjectRefs, disposition: "retry-authorized",
    }]);
    expect(guard.isInFlight("media.action.save-caption-version")).toBe(false);
    expect(hostInvoke).toHaveBeenCalledTimes(1);
  });

  it("keeps the action locked when one immutable owner revision has conflicting dispositions", async () => {
    const actionId = "media.action.deliver-exact-version";
    const payload = { destinationRef: "destination-a" };
    const context = { subjectRefs: ["tenant-a:artifact-a@v3"] };
    const requestCanonical = canonicalMediaActionRequest(actionId, payload, context);
    const guard = createMediaActionDispatchGuard({ invoke: async () => ({ status: "request-acknowledged" as const, requestId: "req-1" }) });
    await guard.actionPort.invoke(actionId, payload, context);
    const base = { actionId, requestId: "req-1", requestCanonical, subjectRefs: context.subjectRefs, reconciliationRevision: "owner-revision-conflict" };
    guard.observeReconciliations([
      { ...base, disposition: "effect-resolved" },
      { ...base, disposition: "unknown" },
    ]);
    expect(guard.isInFlight(actionId)).toBe(true);
    guard.observeReconciliations([{ ...base, reconciliationRevision: "owner-revision-current", disposition: "retry-authorized" }]);
    expect(guard.isInFlight(actionId)).toBe(false);
  });

  it("canonicalizes non-ASCII payload keys by deterministic code-unit order", () => {
    const canonical = canonicalMediaActionRequest("media.action.inspect", { "ä": "accent", z: "ascii", "Ω": "greek" });
    expect(canonical).toBe('{"actionId":"media.action.inspect","payload":{"z":"ascii","ä":"accent","Ω":"greek"},"subjectRefs":[]}');
    expect(canonicalMediaActionRequest("media.action.inspect", { "Ω": "greek", "ä": "accent", z: "ascii" })).toBe(canonical);
  });

  it("releases only source-local actions on explicit local completion and validates before locking", async () => {
    const local = createMediaActionDispatchGuard({ invoke: async () => ({ status: "local-applied" as const }) });
    await expect(local.actionPort.invoke("media.action.seek-source", { sourceTime: "12/1" })).resolves.toEqual({ status: "local-applied" });
    expect(local.isInFlight("media.action.seek-source")).toBe(false);
    const consequential = createMediaActionDispatchGuard({ invoke: async () => ({ status: "local-applied" as const }) });
    await consequential.actionPort.invoke("media.action.deliver-exact-version", { destinationRef: "dest" }, { subjectRefs: ["tenant-a:artifact@v1"] });
    expect(consequential.isInFlight("media.action.deliver-exact-version")).toBe(true);

    const malformed = createMediaActionDispatchGuard({ invoke: vi.fn() });
    const cyclic: Record<string, string | number | boolean | null> = {};
    cyclic.self = cyclic as unknown as string;
    const result = await malformed.actionPort.invoke("media.action.save-caption-version", cyclic);
    expect(result.status).toBe("unavailable");
    expect(malformed.isInFlight("media.action.save-caption-version")).toBe(false);
  });

  it("does not reuse a stale exact retry record when a later dispatch has the same idempotency request", async () => {
    const actionId = "media.action.save-caption-version";
    const payload = { draftRef: "tenant-a:caption-draft@v2" };
    const subjects = { subjectRefs: ["tenant-a:caption-draft@v2"] };
    const requestCanonical = canonicalMediaActionRequest(actionId, payload, subjects);
    const guard = createMediaActionDispatchGuard({ invoke: async () => ({ status: "intent-accepted" as const }) });
    const stale = {
      actionId, requestId: null, requestCanonical, subjectRefs: subjects.subjectRefs,
      reconciliationRevision: "owner-revision-11", disposition: "retry-authorized" as const,
    };
    guard.observeReconciliations([stale]);
    await guard.actionPort.invoke(actionId, payload, subjects);
    expect(guard.isInFlight(actionId)).toBe(true);
    guard.observeReconciliations([stale]);
    expect(guard.isInFlight(actionId)).toBe(true);
    guard.observeReconciliations([{ ...stale, reconciliationRevision: "owner-revision-12" }]);
    expect(guard.isInFlight(actionId)).toBe(false);
  });

  it("accepts an exact owner result that races the dispatch promise", async () => {
    let resolveDispatch!: (value: { status: "request-acknowledged"; requestId: string }) => void;
    const actionId = "media.action.save-caption-version";
    const payload = { draftRef: "tenant-a:caption-draft@v2" };
    const subjects = { subjectRefs: ["tenant-a:caption-draft@v2"] };
    const requestCanonical = canonicalMediaActionRequest(actionId, payload, subjects);
    const guard = createMediaActionDispatchGuard({ invoke: () => new Promise((resolve) => { resolveDispatch = resolve; }) });
    const invocation = guard.actionPort.invoke(actionId, payload, subjects);
    guard.observeReconciliations([{
      actionId, requestId: "req-racing", requestCanonical, subjectRefs: subjects.subjectRefs,
      reconciliationRevision: "owner-revision-racing", disposition: "effect-resolved",
    }]);
    resolveDispatch({ status: "request-acknowledged", requestId: "req-racing" });
    await invocation;
    expect(guard.isInFlight(actionId)).toBe(false);
  });

  it("holds accepted and thrown outcomes until exact request/subject reconciliation or owner retry authorization", async () => {
    const accepted = createMediaActionDispatchGuard({ invoke: async () => ({ status: "intent-accepted" as const }) });
    await accepted.actionPort.invoke("media.action.continue-within-recorded-scope", undefined, { subjectRefs: ["tenant-a:voice-profile@v4"] });
    expect(accepted.isInFlight("media.action.continue-within-recorded-scope")).toBe(true);
    accepted.observeReconciliations([{
      actionId: "media.action.continue-within-recorded-scope", reconciliationRevision: "rev-foreign", requestId: "invented-request",
      requestCanonical: "different-request", subjectRefs: ["tenant-a:voice-profile@v4"], disposition: "retry-authorized",
    }]);
    expect(accepted.isInFlight("media.action.continue-within-recorded-scope")).toBe(true);

    const thrown = createMediaActionDispatchGuard({ invoke: async () => { throw new Error("connection lost after send"); } });
    await expect(thrown.actionPort.invoke("media.action.deliver-exact-version", { destinationRef: "destination-a" }, { subjectRefs: ["tenant-a:artifact-a@v3"] })).rejects.toThrow("connection lost after send");
    expect(thrown.isInFlight("media.action.deliver-exact-version")).toBe(true);
    const exactPayload = { destinationRef: "destination-a" };
    const exactSubjects = { subjectRefs: ["tenant-a:artifact-a@v3"] };
    const canonical = canonicalMediaActionRequest("media.action.deliver-exact-version", exactPayload, exactSubjects);
    thrown.observeReconciliations([{
      actionId: "media.action.deliver-exact-version", reconciliationRevision: "rev-foreign-subject", requestId: null, requestCanonical: canonical,
      subjectRefs: ["tenant-a:artifact-a@v4"], disposition: "retry-authorized",
    }]);
    expect(thrown.isInFlight("media.action.deliver-exact-version")).toBe(true);
    thrown.observeReconciliations([{
      actionId: "media.action.deliver-exact-version", reconciliationRevision: "rev-effect-unknown", requestId: null, requestCanonical: canonical,
      subjectRefs: exactSubjects.subjectRefs, disposition: "effect-resolved",
    }]);
    expect(thrown.isInFlight("media.action.deliver-exact-version")).toBe(true);
    thrown.observeReconciliations([{
      actionId: "media.action.deliver-exact-version", reconciliationRevision: "rev-retry", requestId: null, requestCanonical: canonical,
      subjectRefs: exactSubjects.subjectRefs, disposition: "retry-authorized",
    }]);
    expect(thrown.isInFlight("media.action.deliver-exact-version")).toBe(false);

    const unscoped = createMediaActionDispatchGuard({ invoke: async () => ({ status: "intent-accepted" as const }) });
    await unscoped.actionPort.invoke("media.action.save-caption-version", { draftRef: "caption@v2" });
    unscoped.observeReconciliations([{
      actionId: "media.action.save-caption-version", reconciliationRevision: "rev-empty-subject", requestId: null,
      requestCanonical: canonicalMediaActionRequest("media.action.save-caption-version", { draftRef: "caption@v2" }),
      subjectRefs: [], disposition: "retry-authorized",
    }]);
    expect(unscoped.isInFlight("media.action.save-caption-version")).toBe(true);
  });
});
