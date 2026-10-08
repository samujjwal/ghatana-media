import React from "react";
import { createRoot } from "react-dom/client";
import { Badge, Button, EmptyState, FileUpload, Select, TextArea, TextField } from "@ghatana/design-system";
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
    <FileUpload label="Source media" multiple dragAndDrop={false} showPreview={false} helperText="The host receives the selected files." />
    <EmptyState title="No selection" />
    <EmptyState className="gh-empty-state--panel" title="No media yet" description="unbreakable-description-overflow-check-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz" action={<Button>Review and continue with this exceptionally long workflow label</Button>} />
  </main>,
);
