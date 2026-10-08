import React from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, Select, TextArea, TextField } from "@ghatana/design-system";
import "@ghatana/tokens/tokens.css";
import "@ghatana/design-system/strict-csp-controls.css";

createRoot(document.getElementById("root")!).render(
  <main aria-label="Shared strict CSP control fixture">
    <Button fullWidth>Save</Button>
    <Button loading>Loading</Button>
    <Button disabled>Disabled</Button>
    <Badge tone="success" variant="soft">Ready</Badge>
    <Select label="Format" fullWidth options={[{ value: "audio", label: "Audio" }]} error="Invalid format" />
    <TextArea label="Notes" size="sm" resize="none" />
    <TextField label="Title" size="lg" fullWidth />
  </main>,
);
