// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAdmissibleCaptionTimingRange, hasExactCaptionDraftIdentity, transcriptActionContext, TranscriptCaptionScreen } from "./TranscriptCaptionScreen";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";
import { canonicalMediaActionRequest, type MediaActionPort } from "../ports";
import type { TranscriptCaptionScreenProps } from "./TranscriptCaptionScreen";

afterEach(cleanup);

describe("transcript action context", () => {
  it("keeps host authorization subjects and binds exact transcript and caption versions", () => {
    const context = transcriptActionContext({
      id: "media.action.correct-caption",
      label: "Correct caption",
      enabled: true,
      subjectRefs: ["tenant:tenant-a", "source-version:source-v7"],
    }, ["source-version:source-v7", "transcript-version:transcript-v3", "caption-draft:draft-v2"]);

    expect(context.subjectRefs).toEqual([
      "tenant:tenant-a",
      "source-version:source-v7",
      "transcript-version:transcript-v3",
      "caption-draft:draft-v2",
    ]);
  });

  it("drops absent and blank version references without inventing an owner scope", () => {
    expect(transcriptActionContext(undefined, [undefined, "", "  ", "selected-version-v4"])).toEqual({
      subjectRefs: ["selected-version-v4"],
    });
  });
});

describe("caption source-clock timing range", () => {
  const qualifiedClock = {
    clockId: "source-clock-v7",
    ticksPerSecond: 48_000,
    durationTicks: 480_000,
  };

  it("admits only safe half-open ranges inside the exact source duration", () => {
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 0, 1)).toBe(true);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 100, 200)).toBe(true);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 200, 200)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 201, 200)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 0, 480_001)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, Number.MAX_SAFE_INTEGER + 1, 2)).toBe(false);
  });

  it("fails closed when the source clock tuple is incomplete or invalid", () => {
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, clockId: " " }, 0, 1)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, ticksPerSecond: 0 }, 0, 1)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, durationTicks: undefined }, 0, 1)).toBe(false);
  });
});

describe("caption text draft dispatch", () => {
  const actionId = "media.action.correct-caption";
  const segment = {
    id: "segment-1", startTime: "0.0", endTime: "1.0", startTick: 0, endTick: 48_000,
    text: "Original wording",
  };

  function props(overrides: Partial<TranscriptCaptionScreenProps> = {}): TranscriptCaptionScreenProps {
    return {
      data: {
        currentProjection: {
          title: "Correct captions", description: "Edit a session-local draft.",
          steps: [{ id: "edit", title: "Edit", description: "Correct caption text.", state: "current" }],
          currentStepId: "edit",
        },
      },
      actions: [{ id: actionId, label: "Correct caption", enabled: true,
        subjectRefs: ["source@v7", "transcript@v3", "draft@v4"] }],
      actionPort: { invoke: vi.fn(async () => ({ status: "local-applied" as const })) },
      context: { locale: "en-US" },
      transcript: {
        view: "correct-captions", sourceArtifactId: "artifact-1", sourceArtifactVersionId: "artifact-version-7",
        parentVersionKind: "TRANSCRIPT_VERSION", parentVersionId: "transcript@v3", captionDraftRevision: 4,
        sourceArtifactVersion: "source@v7",
        transcriptVersion: "transcript@v3", captionDraftVersion: "draft@v4",
        segments: [segment],
      },
      ...overrides,
    };
  }

  it("does not dispatch a text correction when no local draft writer is available", () => {
    const invoke = vi.fn(async () => ({ status: "local-applied" as const }));
    render(React.createElement(TranscriptCaptionScreen, props({
      actionPort: { invoke },
    })));

    expect((screen.getByLabelText("Caption text for segment segment-1") as HTMLTextAreaElement).disabled).toBe(true);
    const apply = screen.getByRole("button", { name: "Apply caption correction" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires exact source, typed parent, and expected draft revision before dispatch", () => {
    const invoke = vi.fn(async () => ({ status: "local-applied" as const }));
    const incomplete = props({
      transcript: {
        view: "correct-captions", sourceArtifactVersion: "source@v7",
        transcriptVersion: "transcript@v3", captionDraftVersion: "draft@v4", segments: [segment],
      },
      actionPort: { invoke },
      onCaptionEdit: vi.fn(),
    });
    expect(hasExactCaptionDraftIdentity(incomplete.transcript)).toBe(false);
    render(React.createElement(TranscriptCaptionScreen, incomplete));
    const apply = screen.getByRole("button", { name: "Apply caption correction" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByText(/Exact source, typed parent, and caption draft revision are required/)).toBeTruthy();
    fireEvent.click(apply);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("dispatches only the host-projected draft text and binds the exact displayed versions", async () => {
    const invoke = vi.fn(async () => ({ status: "local-applied" as const }));
    const onCaptionEdit = vi.fn();
    const initial = props({ actionPort: { invoke }, onCaptionEdit });
    const view = render(React.createElement(TranscriptCaptionScreen, initial));
    const editor = screen.getByLabelText("Caption text for segment segment-1");
    fireEvent.change(editor, { target: { value: "Corrected wording" } });
    expect(onCaptionEdit).toHaveBeenCalledWith("segment-1", "Corrected wording");
    expect(invoke).not.toHaveBeenCalled();

    view.rerender(React.createElement(TranscriptCaptionScreen, props({
      actionPort: { invoke }, onCaptionEdit,
      transcript: {
        ...initial.transcript,
        segments: [{ ...segment, text: "Corrected wording" }],
      },
    })));
    fireEvent.click(screen.getByRole("button", { name: "Apply caption correction" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith(actionId, {
      segmentId: "segment-1", text: "Corrected wording",
    }, { subjectRefs: [
      "source@v7", "transcript@v3", "draft@v4",
      "source-artifact:artifact-1", "source-version:artifact-version-7",
      "parent:TRANSCRIPT_VERSION:transcript@v3", "caption-draft:draft@v4", "caption-draft-revision:4",
    ] });
  });
});

describe("caption version save recovery", () => {
  it("holds an acknowledged save until exact owner resolution and denies stale retries", async () => {
    const actionId = "media.action.save-caption-version";
    const payload = { purpose: "corrected captions" };
    const context = { subjectRefs: ["source@v7", "transcript@v3", "draft@v4"] };
    const guard = createMediaActionDispatchGuard({
      invoke: async () => ({ status: "request-acknowledged" as const, requestId: "save-request-1" }),
    });

    await guard.actionPort.invoke(actionId, payload, context);
    expect(guard.isInFlight(actionId)).toBe(true);
    const blocked = await guard.actionPort.invoke(actionId, payload, context);
    expect(blocked.status).toBe("unavailable");

    guard.observeReconciliations([{
      actionId,
      reconciliationRevision: "owner-revision-1",
      requestId: "save-request-1",
      requestCanonical: canonicalMediaActionRequest(actionId, payload, context),
      subjectRefs: context.subjectRefs,
      disposition: "effect-resolved",
    }]);
    expect(guard.isInFlight(actionId)).toBe(false);
  });

  it("releases an explicit denied save so corrected authority can be projected", async () => {
    const actionId = "media.action.save-caption-version";
    const guard = createMediaActionDispatchGuard({
      invoke: async () => ({ status: "denied" as const, reason: "source version is no longer current" }),
    });
    const result = await guard.actionPort.invoke(actionId, {}, { subjectRefs: ["source@v7", "draft@v4"] });
    expect(result.status).toBe("denied");
    expect(guard.isInFlight(actionId)).toBe(false);
  });

  it("keeps the screen save lock across a parent port replacement until exact reconciliation", async () => {
    const actionId = "media.action.save-caption-version";
    const context = { subjectRefs: [
      "source@v7", "transcript@v3", "draft@v4",
      "source-artifact:artifact-1", "source-version:artifact-version-7",
      "parent:TRANSCRIPT_VERSION:transcript@v3", "caption-draft:draft@v4", "caption-draft-revision:4",
    ] };
    const payload = {};
    const firstPort: MediaActionPort = { invoke: async () => ({ status: "request-acknowledged", requestId: "save-request-rerender" }) };
    const replacementInvoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "save-request-duplicate" }));
    const props: TranscriptCaptionScreenProps = {
      data: {
        currentProjection: {
          title: "Correct captions", description: "Edit a versioned caption.",
          steps: [{ id: "edit", title: "Edit", description: "Correct caption text.", state: "current" }],
          currentStepId: "edit",
        },
        actionReconciliations: [],
      },
      actions: [{ id: actionId, label: "Save caption version", enabled: true, subjectRefs: context.subjectRefs }],
      actionPort: firstPort,
      context: { locale: "en-US" },
      transcript: {
        view: "correct-captions", sourceArtifactVersion: "source@v7", transcriptVersion: "transcript@v3",
        sourceArtifactId: "artifact-1", sourceArtifactVersionId: "artifact-version-7",
        parentVersionKind: "TRANSCRIPT_VERSION", parentVersionId: "transcript@v3",
        captionDraftVersion: "draft@v4", captionDraftRevision: 4, segments: [],
      },
    };
    const view = render(React.createElement(TranscriptCaptionScreen, props));
    fireEvent.click(screen.getByRole("button", { name: "Save caption version" }));
    expect(await screen.findByText("Request acknowledged (save-request-rerender); completion remains unobserved.")).toBeTruthy();

    view.rerender(React.createElement(TranscriptCaptionScreen, {
      ...props,
      actionPort: { invoke: replacementInvoke },
    }));
    const saveButton = screen.getByRole("button", { name: "Save caption version" });
    expect(saveButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(saveButton);
    expect(replacementInvoke).not.toHaveBeenCalled();

    view.rerender(React.createElement(TranscriptCaptionScreen, {
      ...props,
      actionPort: { invoke: replacementInvoke },
      data: {
        ...props.data,
        actionReconciliations: [{
          actionId,
          reconciliationRevision: "save-owner-rev-2",
          requestId: "save-request-rerender",
          requestCanonical: canonicalMediaActionRequest(actionId, payload, context),
          subjectRefs: context.subjectRefs,
          disposition: "effect-resolved",
        }],
      },
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save caption version" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save caption version" }));
    await waitFor(() => expect(replacementInvoke).toHaveBeenCalledTimes(1));
  });
});
