// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactSourcePicker, IntentLauncher, SourcePicker, type MediaComponentValue } from "./MediaComponentFamilies";

afterEach(cleanup);

describe("Media family selection accessibility", () => {
  it("explains why a candidate is disabled when no exact request adapter is available", () => {
    const html = renderToStaticMarkup(React.createElement(IntentLauncher, {
      state: "available",
      variant: "available",
      actionIntents: ["media.action.choose-intent"],
      keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus",
      chooseIntentAction: "media.action.choose-intent",
      intentOptions: [{
        intentRef: "media.intent.create",
        label: "Create media",
        availability: "available",
        reasonRef: null,
      }],
      actions: [{
        id: "media.action.choose-intent",
        label: "Choose intent",
        enabled: true,
        selectionPayloadAvailable: false,
        invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No adapter." })),
      }],
    }));

    const radio = /<input\b(?=[^>]*type="radio")([^>]*)>/u.exec(html)?.[1];
    const reasonId = /aria-describedby="([^"]+-selection-disabled-reason)"/u.exec(radio ?? "")?.[1];
    expect(html).toContain("<fieldset class=\"media-family__selection-group\"><legend>Intent Options</legend>");
    expect(radio).toContain('aria-disabled="true"');
    expect(radio).not.toContain('disabled=""');
    expect(reasonId).toBeDefined();
    expect(html).toContain(`id="${reasonId}"`);
    expect(html).toContain("Selection is unavailable because no exact selection-to-request adapter is defined.");
  });

  it("explains that selection awaits an eligible owner action when no action is projected", () => {
    const html = renderToStaticMarkup(React.createElement(IntentLauncher, {
      state: "unavailable-with-reason",
      variant: "unavailable-with-reason",
      actionIntents: ["media.action.choose-intent"],
      keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus",
      chooseIntentAction: "media.action.choose-intent",
      intentOptions: [{
        intentRef: "media.intent.create",
        label: "Create media",
        availability: "unavailable",
        reasonRef: "provider-not-admitted",
      }],
    }));

    expect(html).toContain("Selection is unavailable because the current owner projection has no eligible action.");
    const radio = /<input\b(?=[^>]*type="radio")([^>]*)>/u.exec(html)?.[1];
    const reasonId = /aria-describedby="([^"]+-selection-disabled-reason)"/u.exec(radio ?? "")?.[1];
    expect(radio).toContain('aria-disabled="true"');
    expect(radio).not.toContain('disabled=""');
    expect(reasonId).toBeDefined();
    expect(html).toContain(`id="${reasonId}"`);
  });

  it("keeps a disabled selection focusable and prevents activation", () => {
    const view = render(React.createElement(IntentLauncher, {
      state: "available",
      variant: "available",
      actionIntents: ["media.action.choose-intent"],
      keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus",
      chooseIntentAction: "media.action.choose-intent",
      intentOptions: [{
        intentRef: "media.intent.create",
        label: "Create media",
        availability: "available",
        reasonRef: null,
      }],
      actions: [{
        id: "media.action.choose-intent",
        label: "Choose intent",
        enabled: true,
        selectionPayloadAvailable: false,
        invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No adapter." })),
      }],
    }));
    const radio = view.getByRole("radio", { name: "Select Create media" });

    expect(radio.getAttribute("aria-disabled")).toBe("true");
    expect(radio.hasAttribute("disabled")).toBe(false);
    expect(radio.hasAttribute("tabindex")).toBe(false);
    expect((radio as HTMLInputElement).tabIndex).toBe(0);
    const descriptionId = radio.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)?.textContent)
      .toBe("Selection is unavailable because no exact selection-to-request adapter is defined.");

    radio.focus();
    expect(document.activeElement).toBe(radio);
    fireEvent.keyDown(radio, { key: " " });
    fireEvent.click(radio);
    fireEvent.keyUp(radio, { key: " " });
    expect((radio as HTMLInputElement).checked).toBe(false);
    expect(view.queryByRole("button", { name: "Choose intent" })).toBeNull();
  });

  it("passes the exact structured source version reference through the choose action adapter", async () => {
    const versionRef = { tenantId: "tenant-1", artifactId: "source-original", versionId: "v7" };
    const invoke = vi.fn(async (_selectedValue?: MediaComponentValue) => ({
      status: "request-acknowledged" as const,
      requestId: "choose-source-request",
    }));
    const view = render(React.createElement(SourcePicker, {
      workspaceRef: { tenantId: "tenant-1", workspaceId: "workspace-1" },
      targetProjectRef: { tenantId: "tenant-1", projectId: "project-1" },
      query: { text: "", mediaTypes: [], limit: 10 },
      sourceCandidates: [{
        versionRef,
        mediaType: "video/mp4",
        access: "authorized",
        rightsDisposition: "permitted-with-scope",
        sourceName: "source-original.mp4",
      }],
      selectionState: "available",
      state: "empty",
      variant: "empty",
      actionIntents: ["media.action.choose-source"],
      keyboardBehavior: "native-selection-controls; complete-row-selection; visible-focus",
      actions: [{
        id: "media.action.choose-source",
        label: "Choose source",
        enabled: true,
        selectionPayloadAvailable: true,
        invoke,
      }],
    }));

    fireEvent.click(view.getByRole("radio", { name: "Select source-original.mp4" }));
    fireEvent.click(view.getByRole("button", { name: "Choose source" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    expect(invoke.mock.calls[0]?.[0]).toBe(versionRef);
    expect(invoke.mock.calls[0]?.[0]).not.toBe("0");
  });

  it("allows one enabled option to be selected in a named single-choice group", () => {
    const invoke = vi.fn(async () => ({ status: "local-applied" as const }));
    const view = render(React.createElement(IntentLauncher, {
      state: "available",
      variant: "available",
      actionIntents: ["media.action.choose-intent"],
      keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus",
      chooseIntentAction: "media.action.choose-intent",
      intentOptions: [
        { intentRef: "media.intent.create", label: "Create media", availability: "available", reasonRef: null },
        { intentRef: "media.intent.edit", label: "Edit media", availability: "available", reasonRef: null },
      ],
      actions: [{
        id: "media.action.choose-intent",
        label: "Choose intent",
        enabled: true,
        selectionPayloadAvailable: true,
        invoke,
      }],
    }));
    const createOption = view.getByRole("radio", { name: "Select Create media" }) as HTMLInputElement;
    const editOption = view.getByRole("radio", { name: "Select Edit media" }) as HTMLInputElement;
    expect(view.getByRole("group", { name: "Intent Options" })).toBeTruthy();
    expect(createOption.name).toBe(editOption.name);

    fireEvent.click(createOption);
    expect(createOption.checked).toBe(true);
    expect(editOption.checked).toBe(false);
    fireEvent.click(editOption);
    expect(createOption.checked).toBe(false);
    expect(editOption.checked).toBe(true);
    expect(view.getByRole("button", { name: "Choose intent" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the prior radio selection when a change arrives after the action becomes unavailable", () => {
    const intentOptions = [
      { intentRef: "media.intent.create" as const, label: "Create media", availability: "available" as const, reasonRef: null },
      { intentRef: "media.intent.edit" as const, label: "Edit media", availability: "available" as const, reasonRef: null },
    ];
    const baseProps = {
      state: "available" as const,
      variant: "available" as const,
      actionIntents: ["media.action.choose-intent"] as const,
      keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus" as const,
      chooseIntentAction: "media.action.choose-intent" as const,
      intentOptions,
      actions: [{
        id: "media.action.choose-intent",
        label: "Choose intent",
        enabled: true,
        selectionPayloadAvailable: true,
        invoke: vi.fn(async () => ({ status: "local-applied" as const })),
      }],
    };
    const unavailableProps = {
      ...baseProps,
      actions: [{
        ...baseProps.actions[0],
        enabled: false,
        disabledReason: "Selection awaits a current owner projection.",
      }],
    };
    const view = render(React.createElement(IntentLauncher, baseProps));
    const createOption = view.getByRole("radio", { name: "Select Create media" }) as HTMLInputElement;

    fireEvent.click(createOption);
    expect(createOption.checked).toBe(true);
    view.rerender(React.createElement(IntentLauncher, unavailableProps));
    const currentCreateOption = view.getByRole("radio", { name: "Select Create media" }) as HTMLInputElement;
    const editOption = view.getByRole("radio", { name: "Select Edit media" }) as HTMLInputElement;
    expect(currentCreateOption.checked).toBe(true);
    expect(editOption.checked).toBe(false);
    expect(editOption.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(editOption, { target: { checked: true } });
    view.rerender(React.createElement(IntentLauncher, unavailableProps));

    expect((view.getByRole("radio", { name: "Select Create media" }) as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole("radio", { name: "Select Edit media" }) as HTMLInputElement).checked).toBe(false);
  });

  it("uses named radio groups for source and artifact version pickers", () => {
    const version = (artifactId: string, versionId: string) => ({
      tenantId: "tenant-1", artifactId, versionId,
    });
    const action = (id: string) => ({
      id,
      label: "Choose exact version",
      enabled: true,
      selectionPayloadAvailable: true,
      invoke: vi.fn(async () => ({ status: "local-applied" as const })),
    });
    const view = render(React.createElement(React.Fragment, null,
      React.createElement(SourcePicker, {
        workspaceRef: { tenantId: "tenant-1", workspaceId: "workspace-1" },
        targetProjectRef: { tenantId: "tenant-1", projectId: "project-1" },
        query: { text: "", mediaTypes: [], limit: 10 },
        sourceCandidates: [
          { versionRef: version("source-1", "v1"), mediaType: "video/mp4", access: "authorized", rightsDisposition: "permitted-with-scope", sourceName: "source-one.mp4" },
          { versionRef: version("source-2", "v3"), mediaType: "video/mp4", access: "authorized", rightsDisposition: "permitted-with-scope", sourceName: "source-two.mp4" },
        ],
        selectionState: "available", state: "empty", variant: "empty",
        actionIntents: ["media.action.choose-source"],
        keyboardBehavior: "native-selection-controls; complete-row-selection; visible-focus",
        actions: [action("media.action.choose-source")],
      }),
      React.createElement(ArtifactSourcePicker, {
        projectRef: { tenantId: "tenant-1", projectId: "project-1" },
        query: { text: "", mediaTypes: [], limit: 10 },
        artifactCandidates: [
          { versionRef: version("artifact-1", "v2"), mediaType: "video/mp4", access: "authorized", rightsDisposition: "permitted-with-scope", integrityDisposition: "verified" },
          { versionRef: version("artifact-2", "v4"), mediaType: "video/mp4", access: "authorized", rightsDisposition: "permitted-with-scope", integrityDisposition: "verified" },
        ],
        selectedVersionRef: undefined,
        selectionState: "available",
        selectionAction: "media.action.select-artifact-source",
        state: "empty", variant: "empty",
        actionIntents: ["media.action.select-artifact-source"],
        keyboardBehavior: "native-file-picker-and-labelled-source-choice; drag-and-drop-is-never-the-only-input",
        actions: [action("media.action.select-artifact-source")],
      }),
    ));

    expect(view.getByRole("group", { name: "Source Candidates" })).toBeTruthy();
    expect(view.getByRole("group", { name: "Artifact Candidates" })).toBeTruthy();
    expect(view.getAllByRole("radio")).toHaveLength(4);
    expect(view.getAllByRole("radio").every((radio) => radio.getAttribute("aria-pressed") === null)).toBe(true);
  });
});
