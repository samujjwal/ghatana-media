// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobRecoveryScreen, type CanonicalJobReadClient } from "./JobRecoveryScreen";
import type { MediaActionPort, MediaContextPort, MediaDataPort } from "../ports";
import { canonicalMediaActionRequest } from "../ports";

const baseProps = {
  data: {
    currentProjection: {
      title: "Check job outcome",
      description: "Read the current owner status for this exact job.",
      steps: [{ id: "observe", title: "Observe status", description: "Read the same job.", state: "current" as const }],
      currentStepId: "observe",
    },
    operationObservation: { state: "READY", progress: { kind: "none" as const } },
  } satisfies MediaDataPort,
  actions: [],
  actionPort: { invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No action dispatched." })) } satisfies MediaActionPort,
  context: { locale: "en-US" } satisfies MediaContextPort,
  job: { jobId: "job-canonical-17" },
};

describe("JobRecoveryScreen canonical read", () => {
  it("keeps an acknowledged host action locked until the same request has fresh owner reconciliation", async () => {
    const actionId = "media.action.retry-job";
    const subjectRefs = ["job:job-canonical-17"];
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-17" }));
    const props = {
      ...baseProps,
      actions: [{ id: actionId, label: "Retry job", enabled: true, subjectRefs }],
      actionPort: { invoke },
    };
    const { rerender } = render(React.createElement(JobRecoveryScreen, props));

    fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry job" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Request acknowledged (request-17). Completion remains unobserved.")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);

    const reconciliation = {
      actionId,
      requestId: "request-17",
      requestCanonical: canonicalMediaActionRequest(actionId, undefined, { subjectRefs }),
      subjectRefs,
      reconciliationRevision: "owner-revision-2",
      disposition: "retry-authorized" as const,
    };
    rerender(React.createElement(JobRecoveryScreen, {
      ...props,
      data: { ...props.data, actionReconciliations: [reconciliation] },
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry job" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it("shows loading and terminal status only after the injected canonical reader returns", async () => {
    let resolveRead: ((value: { jobId: string; status: "COMPLETED"; version: number }) => void) | undefined;
    const canonicalJobReadClient: CanonicalJobReadClient = {
      getJob: vi.fn(() => new Promise<{ jobId: string; status: "COMPLETED"; version: number }>((resolve) => { resolveRead = resolve; })),
    };
    render(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(screen.getByText("Loading canonical job status…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh canonical status" }).hasAttribute("disabled")).toBe(true);

    resolveRead?.({ jobId: "job-canonical-17", status: "COMPLETED", version: 8 });
    expect(await screen.findByText("Terminal status observed: COMPLETED (version 8).")).toBeTruthy();
    expect(canonicalJobReadClient.getJob).toHaveBeenCalledWith("job-canonical-17", expect.any(AbortSignal));
  });

  it("distinguishes denied, unknown, and server-reported unknown outcomes", async () => {
    const deniedClient: CanonicalJobReadClient = {
      getJob: vi.fn(async () => { throw Object.assign(new Error("forbidden"), { statusCode: 403 }); }),
    };
    const { rerender } = render(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient: deniedClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(await screen.findByText("Canonical job status read was denied. No status is disclosed.")).toBeTruthy();

    const unavailableClient: CanonicalJobReadClient = { getJob: vi.fn(async () => { throw new Error("network unavailable"); }) };
    rerender(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient: unavailableClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(await screen.findByText("Canonical job status is unknown. Reconcile the same job before taking another action.")).toBeTruthy();

    const unknownClient: CanonicalJobReadClient = {
      getJob: vi.fn(async () => ({ jobId: "job-canonical-17", status: "OUTCOME_UNKNOWN" as const, version: 9 })),
    };
    rerender(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient: unknownClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(await screen.findByText("Canonical job reports OUTCOME_UNKNOWN. Reconcile the same job before retrying.")).toBeTruthy();
  });

  it("fails closed when a canonical response has the wrong identity, status, or version", async () => {
    const malformedSnapshots: readonly unknown[] = [
      { jobId: "another-job", status: "COMPLETED", version: 2 },
      { jobId: "job-canonical-17", status: "CANCEL_REQUESTED", version: 2 },
      { jobId: "job-canonical-17", status: "COMPLETED", version: 0 },
      { jobId: "job-canonical-17", status: "COMPLETED", version: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const snapshot of malformedSnapshots) {
      const canonicalJobReadClient: CanonicalJobReadClient = {
        getJob: vi.fn(async () => snapshot as Awaited<ReturnType<CanonicalJobReadClient["getJob"]>>),
      };
      const { unmount } = render(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
      expect(await screen.findByText("Canonical job status is unknown. Reconcile the same job before taking another action.")).toBeTruthy();
      expect(screen.queryByText(/Terminal status observed/u)).toBeNull();
      unmount();
    }
  });

  it("does not retain a previous job's canonical read when the selected identity changes", async () => {
    const canonicalJobReadClient: CanonicalJobReadClient = {
      getJob: vi.fn(async (jobId) => ({ jobId, status: "FAILED" as const, version: 3 })),
    };
    const { rerender } = render(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(await screen.findByText("Terminal status observed: FAILED (version 3).")).toBeTruthy();

    rerender(React.createElement(JobRecoveryScreen, {
      ...baseProps,
      job: { jobId: "job-canonical-18" },
      canonicalJobReadClient,
    }));
    expect(screen.getByText("Canonical status has not been refreshed in this view.")).toBeTruthy();
  });

  it("aborts the in-flight canonical read when the selected job changes", () => {
    let requestSignal: AbortSignal | undefined;
    const canonicalJobReadClient: CanonicalJobReadClient = {
      getJob: vi.fn((_jobId, signal) => {
        requestSignal = signal;
        return new Promise(() => undefined);
      }),
    };
    const { rerender } = render(React.createElement(JobRecoveryScreen, { ...baseProps, canonicalJobReadClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh canonical status" }));
    expect(requestSignal?.aborted).toBe(false);

    rerender(React.createElement(JobRecoveryScreen, {
      ...baseProps,
      job: { jobId: "job-canonical-18" },
      canonicalJobReadClient,
    }));

    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByText("Canonical status has not been refreshed in this view.")).toBeTruthy();
  });
});
