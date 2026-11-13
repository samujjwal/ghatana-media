# Host integration

The canonical host was resolved in the separate `gharbatai` checkout:

`products/org/apps/api/src/modules/document-extraction/`

The scaffold is present, linked to the frozen Shared package and Media client, and intentionally not mounted in the Org API application. It is a non-activating composition boundary only; governed `CLEAN` content admission, persistence, review and product decisions remain Increment 4 work.

The composition factory wraps each adapter with the frozen Shared capability-admission helper before exporting the parser, field-extraction, and embedding ports. It rejects disabled configuration and non-loopback worker URLs.
