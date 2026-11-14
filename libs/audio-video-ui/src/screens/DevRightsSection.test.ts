// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevRightsSection } from "./DevRightsSection";
import { DevOutputsHostError, type DevHostResponse, type DevProjectOutputsPort } from "./devProjectOutputs";
import { confirmGate, describeRightsFailure, parseRightsAttestation, parseRightsVersionView, revokeGate } from "./devRights";

afterEach(cleanup);

const DIGEST = "a".repeat(64);
const VERSION = `sha256:${DIGEST}`;
const ARTIFACT = { artifactId: "art-1", artifactVersionId: VERSION };
const UPLOADER = "test-principal-uploader";
const REVIEWER = "test-principal-reviewer";

const attestation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  attestationId: "att-1", artifactId: "art-1", artifactVersionId: VERSION, contentSha256: DIGEST,
  attestingPrincipalId: UPLOADER, attestedAt: "2026-11-14T10:00:00Z", statementKind: "MEDIA_RIGHTS",
  scopes: ["PROCESSING", "EXTERNAL_DELIVERY"], basis: "TEST basis for a synthetic fixture", supportingDocumentArtifactRef: null,
  requestedConfirmerPrincipalId: null, expiresAt: null, requiresSecondPersonConfirmation: true, status: "PENDING_CONFIRMATION",
  confirmation: null, revocation: null, scope: "DEV_ONLY", establishesApproval: false, ...over,
});
const admission = (verdicts: Partial<Record<string, string>> = {}): Record<string, unknown> => Object.fromEntries(
  ["PROCESSING", "VOICE_OR_LIKENESS_USE", "EXTERNAL_DELIVERY"].map((scope) => [scope, {
    scope, verdict: verdicts[scope] ?? "DENIED", reasons: [], attestationIds: [], requiresSecondPersonConfirmation: scope !== "PROCESSING" }]));
const listing = (records: Record<string, unknown>[], verdicts: Partial<Record<string, string>> = {}): unknown => ({
  artifactId: "art-1", artifactVersionId: VERSION, attestations: records, admission: admission(verdicts), scope: "DEV_ONLY", establishesApproval: false,
});
const confirmed = (over: Record<string, unknown> = {}): Record<string, unknown> => attestation({
  status: "CONFIRMED", confirmation: { confirmingPrincipalId: REVIEWER, confirmedAt: "2026-11-14T11:00:00Z", note: "TEST note" }, ...over });
const ok = (status: number, body: unknown): Promise<DevHostResponse> => Promise.resolve({ status, body });
const reject = (status: number, code: string): Promise<never> => Promise.reject(new DevOutputsHostError(code, status, code));

type Mocked = { [K in keyof Required<DevProjectOutputsPort>]: ReturnType<typeof vi.fn> } & { principalId?: string };
function port(principalId: string | undefined, over: Record<string, unknown> = {}): Mocked {
  return {
    ...(principalId ? { principalId } : {}),
    listRightsAttestations: vi.fn(() => ok(200, listing([]))),
    createRightsAttestation: vi.fn(() => ok(201, attestation())),
    getRightsAttestation: vi.fn(() => ok(200, attestation())),
    confirmRightsAttestation: vi.fn(() => ok(200, confirmed())),
    revokeRightsAttestation: vi.fn(() => ok(200, attestation({ status: "REVOKED", revocation: { revokedByPrincipalId: UPLOADER, revokedAt: "2026-11-14T12:00:00Z", reason: "TEST withdrawn" } }))),
    ...over,
  } as never;
}
const mount = (outputs: Mocked, artifact: { artifactId: string; artifactVersionId: string } | null = ARTIFACT, locked = false) =>
  render(React.createElement(DevRightsSection, { outputs: outputs as unknown as DevProjectOutputsPort, locked, artifact }));
const status = (): HTMLElement => document.getElementById("rights-status")!;

describe("DevRightsSection", () => {
  it("says so and offers nothing when the host has no rights lane", () => {
    mount({ principalId: UPLOADER } as never);
    expect(screen.getByText(/does not expose the DEV_ONLY rights lane/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record my statement/iu })).toBeNull();
  });

  it("reads the exact version on mount and shows no admission before any statement", async () => {
    const outputs = port(UPLOADER);
    mount(outputs);
    await waitFor(() => expect(status().textContent).toMatch(/No rights statement exists for this exact version/u));
    expect(outputs.listRightsAttestations).toHaveBeenCalledWith("art-1", VERSION);
    const list = screen.getByLabelText("Admission by scope");
    expect(within(list).getAllByRole("listitem").map((item) => item.getAttribute("data-verdict"))).toEqual(["DENIED", "DENIED", "DENIED"]);
    expect(screen.getByText(/never inherits an earlier version/u)).toBeTruthy();
    expect(screen.getByText(/not a legal determination and not human approval/u)).toBeTruthy();
  });

  it("lets the uploader state rights only with scopes, a basis and an explicit acknowledgement, and never sends a principal", async () => {
    const outputs = port(UPLOADER, { listRightsAttestations: vi.fn()
      .mockImplementationOnce(() => ok(200, listing([])))
      .mockImplementation(() => ok(200, listing([attestation()]))) });
    mount(outputs);
    await waitFor(() => expect(outputs.listRightsAttestations).toHaveBeenCalledTimes(1));
    const submit = screen.getByRole("button", { name: "Record my statement" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/PROCESSING$/u));
    fireEvent.click(screen.getByLabelText(/EXTERNAL_DELIVERY \(needs a second person\)/u));
    expect(screen.getByText(/admitted only after a different person confirms/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Basis/u), { target: { value: "TEST basis for a synthetic fixture" } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I am stating this as myself/u));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(outputs.createRightsAttestation).toHaveBeenCalledTimes(1));
    const request = outputs.createRightsAttestation.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toEqual({ artifactId: "art-1", artifactVersionId: VERSION, statementKind: "MEDIA_RIGHTS",
      scopes: ["PROCESSING", "EXTERNAL_DELIVERY"], basis: "TEST basis for a synthetic fixture" });
    expect(Object.keys(request).some((key) => /principal/iu.test(key))).toBe(false);
    await waitFor(() => expect(status().textContent).toMatch(/Recorded statement att-1 by test-principal-uploader/u));
    expect(status().textContent).toMatch(/not admitted for voice or likeness use or external delivery until a different person confirms/u);
    const record = await screen.findByText("att-1");
    expect(record.closest("li")!.getAttribute("data-status")).toBe("PENDING_CONFIRMATION");
    expect(screen.getByText(/Not confirmed yet/u)).toBeTruthy();
  });

  it("refuses to let the statement's own author confirm it and never calls the host", async () => {
    const outputs = port(UPLOADER, { listRightsAttestations: vi.fn(() => ok(200, listing([attestation()]))) });
    mount(outputs);
    const confirm = await screen.findByRole("button", { name: "Confirm statement att-1" }) as HTMLButtonElement;
    fireEvent.click(screen.getByLabelText(/I have read the statement/u));
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/A second person must confirm it/u)).toBeTruthy();
    fireEvent.click(confirm);
    expect(outputs.confirmRightsAttestation).not.toHaveBeenCalled();
  });

  it("lets a second person open a statement by id, review it and confirm it", async () => {
    const outputs = port(REVIEWER);
    mount(outputs, null);
    fireEvent.change(screen.getByLabelText("Statement ID to review and confirm"), { target: { value: "att-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Open statement" }));
    const confirm = await screen.findByRole("button", { name: "Confirm statement att-1" }) as HTMLButtonElement;
    expect(outputs.getRightsAttestation).toHaveBeenCalledWith("att-1");
    expect(screen.getByText("TEST basis for a synthetic fixture")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have read the statement/u));
    fireEvent.change(screen.getByLabelText(/Confirmation note/u), { target: { value: "TEST note" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(outputs.confirmRightsAttestation).toHaveBeenCalledWith("att-1", { note: "TEST note" }));
    await waitFor(() => expect(status().textContent).toMatch(/Confirmed statement att-1 as test-principal-reviewer/u));
    expect(screen.getByText(/Confirmed by/u).textContent).toMatch(/test-principal-reviewer/u);
  });

  it("disables confirmation when the uploader asked a different person", async () => {
    const outputs = port(REVIEWER, { getRightsAttestation: vi.fn(() => ok(200, attestation({ requestedConfirmerPrincipalId: "test-principal-other" }))) });
    mount(outputs, null);
    fireEvent.change(screen.getByLabelText("Statement ID to review and confirm"), { target: { value: "att-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Open statement" }));
    const confirm = await screen.findByRole("button", { name: "Confirm statement att-1" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/asked a different person to confirm/u)).toBeTruthy();
  });

  it("revokes only with a reason and an acknowledgement and shows who revoked", async () => {
    const outputs = port(UPLOADER, { listRightsAttestations: vi.fn(() => ok(200, listing([confirmed()], { EXTERNAL_DELIVERY: "ADMITTED", PROCESSING: "ADMITTED" }))) });
    mount(outputs);
    const revoke = await screen.findByRole("button", { name: "Revoke statement att-1" }) as HTMLButtonElement;
    expect(within(screen.getByLabelText("Admission by scope")).getAllByRole("listitem").map((item) => item.getAttribute("data-verdict")))
      .toEqual(["ADMITTED", "DENIED", "ADMITTED"]);
    fireEvent.click(screen.getByLabelText(/I have read the statement/u));
    expect(revoke.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Revocation reason"), { target: { value: "TEST withdrawn" } });
    expect(revoke.disabled).toBe(false);
    fireEvent.click(revoke);
    await waitFor(() => expect(outputs.revokeRightsAttestation).toHaveBeenCalledWith("att-1", { reason: "TEST withdrawn" }));
    await waitFor(() => expect(status().textContent).toMatch(/Revoked statement att-1 by test-principal-uploader/u));
  });

  it("shows a refused self-confirmation and an unavailable authority honestly, never as success", async () => {
    const outputs = port(REVIEWER, {
      getRightsAttestation: vi.fn(() => ok(200, attestation())),
      confirmRightsAttestation: vi.fn(() => reject(403, "SELF_CONFIRMATION_REFUSED")),
    });
    mount(outputs, null);
    fireEvent.change(screen.getByLabelText("Statement ID to review and confirm"), { target: { value: "att-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Open statement" }));
    const confirm = await screen.findByRole("button", { name: "Confirm statement att-1" });
    fireEvent.click(screen.getByLabelText(/I have read the statement/u));
    fireEvent.click(confirm);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/SELF_CONFIRMATION_REFUSED/u);
    expect(alert.getAttribute("data-outcome")).toBe("denied");
    expect(status().textContent).toMatch(/cannot confirm it/u);

    cleanup();
    const down = port(UPLOADER, { listRightsAttestations: vi.fn(() => reject(503, "RIGHTS_STATE_UNAVAILABLE")) });
    mount(down);
    const unavailable = await screen.findByRole("alert");
    expect(unavailable.getAttribute("data-outcome")).toBe("unavailable");
    expect(screen.queryByLabelText("Admission by scope")).toBeNull();
  });

  it("rejects a response for a different version or one that claims approval", async () => {
    const wrongVersion = port(UPLOADER, { listRightsAttestations: vi.fn(() => ok(200, { ...(listing([]) as object), artifactVersionId: `sha256:${"c".repeat(64)}` })) });
    mount(wrongVersion);
    expect((await screen.findByRole("alert")).textContent).toMatch(/INVALID_RESPONSE/u);
    cleanup();
    const approving = port(UPLOADER, { listRightsAttestations: vi.fn(() => ok(200, listing([attestation({ establishesApproval: true })]))) });
    mount(approving);
    expect((await screen.findByRole("alert")).textContent).toMatch(/INVALID_RESPONSE/u);
  });

  it("locks every mutating control while the workspace is locked", async () => {
    const outputs = port(REVIEWER, { listRightsAttestations: vi.fn(() => ok(200, listing([attestation()]))) });
    mount(outputs, ARTIFACT, true);
    const confirm = await screen.findByRole("button", { name: "Confirm statement att-1" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Record my statement" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("devRights helpers", () => {
  it("parses a valid attestation and refuses a self-confirmed or non-DEV_ONLY one", () => {
    expect(parseRightsAttestation(attestation()).status).toBe("PENDING_CONFIRMATION");
    expect(() => parseRightsAttestation(attestation({ scope: "PRODUCTION" }))).toThrow();
    expect(() => parseRightsAttestation(attestation({ confirmation: { confirmingPrincipalId: UPLOADER, confirmedAt: "x", note: null } }))).toThrow();
    expect(() => parseRightsAttestation(attestation({ scopes: [] }))).toThrow();
    expect(() => parseRightsAttestation(attestation({ status: "APPROVED" }))).toThrow();
  });

  it("requires an admission entry for every scope and a matching version", () => {
    expect(parseRightsVersionView(listing([attestation()]), ARTIFACT).admission).toHaveLength(3);
    const missing = { ...(listing([]) as Record<string, unknown>), admission: { PROCESSING: { scope: "PROCESSING", verdict: "DENIED", reasons: [] } } };
    expect(() => parseRightsVersionView(missing, ARTIFACT)).toThrow();
    expect(() => parseRightsVersionView(listing([attestation({ artifactVersionId: `sha256:${"d".repeat(64)}` })]), ARTIFACT)).toThrow();
  });

  it("derives the confirm and revoke gates", () => {
    const pending = parseRightsAttestation(attestation());
    expect(confirmGate(pending, undefined).allowed).toBe(false);
    expect(confirmGate(pending, UPLOADER).allowed).toBe(false);
    expect(confirmGate(pending, REVIEWER).allowed).toBe(true);
    expect(confirmGate(parseRightsAttestation(attestation({ requestedConfirmerPrincipalId: "someone" })), REVIEWER).allowed).toBe(false);
    expect(confirmGate(parseRightsAttestation(attestation({ scopes: ["PROCESSING"], requiresSecondPersonConfirmation: false, status: "NOT_REQUIRED_TO_CONFIRM" })), REVIEWER).allowed).toBe(false);
    expect(confirmGate(parseRightsAttestation(confirmed()), "test-principal-third").allowed).toBe(false);
    expect(revokeGate(pending, UPLOADER).allowed).toBe(true);
    expect(revokeGate(pending, REVIEWER).allowed).toBe(false);
    expect(revokeGate(parseRightsAttestation(confirmed()), REVIEWER).allowed).toBe(true);
    expect(revokeGate(parseRightsAttestation(attestation({ status: "REVOKED" })), UPLOADER).allowed).toBe(false);
  });

  it("maps host failures to typed outcomes", () => {
    expect(describeRightsFailure(new DevOutputsHostError("SELF_CONFIRMATION_REFUSED", 403, "x")).tone).toBe("denied");
    expect(describeRightsFailure(new DevOutputsHostError("ATTESTATION_ALREADY_CONFIRMED", 409, "x")).text).toMatch(/already confirmed/u);
    expect(describeRightsFailure(new DevOutputsHostError("OUTCOME_UNKNOWN", 0, "x")).tone).toBe("unknown");
    expect(describeRightsFailure(new DevOutputsHostError("RIGHTS_STATE_UNAVAILABLE", 503, "x")).tone).toBe("unavailable");
    expect(describeRightsFailure(new Error("boom")).tone).toBe("unknown");
  });
});
