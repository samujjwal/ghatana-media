# Media Intelligence verification records

This page indexes local contract tests and runtime authority checks for media
artifacts, jobs, streams, consent, and privacy. It is not a production-evidence
generator or release-readiness claim.

## Experience browser audit

`pnpm test:experience-browser` runs the Media-owned Explorer preview through
all 29 scenarios, 147 Specification records, 47 valid Product proposal routes,
the inline artifact-verification specialization, Verify, keyboard navigation,
accessible-name checks, and six responsive viewports. The current audit passed
with no console/page errors or horizontal overflow and produced review
fixed-viewport screenshots under `/tmp/media-experience-browser-audit`; a repeat
run produced identical SHA-1 hashes for all eight captures.

The audit proves deterministic browser behavior and geometry. It does not
replace human visual/accessibility review, a pixel-reference comparison, or
Tools-native Evidence Generator receipts.
