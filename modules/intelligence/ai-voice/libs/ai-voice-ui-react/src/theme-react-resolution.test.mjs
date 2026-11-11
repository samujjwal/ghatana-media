import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("installed @ghatana/theme React peer resolution", () => {
  it("resolves React and the automatic JSX runtime from the installed theme package", () => {
    const packageRequire = createRequire(import.meta.url);
    const themeManifest = packageRequire.resolve("@ghatana/theme/package.json");
    const themeRequire = createRequire(themeManifest);
    const hostReact = packageRequire.resolve("react");
    const hostJsxRuntime = packageRequire.resolve("react/jsx-runtime");

    expect(themeRequire.resolve("react")).toBe(hostReact);
    expect(themeRequire.resolve("react/jsx-runtime")).toBe(hostJsxRuntime);
  });
});
