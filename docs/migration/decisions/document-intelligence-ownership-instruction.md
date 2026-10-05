My recommendation is **no: the general OCR/document-intelligence stack should not move into `ghatana-media`**.

What should move to `ghatana-media` is only the **media-specific use of OCR/text recognition**—for example extracting scene text from video frames, reading text from an image while editing, or using detected text to drive search, overlays, accessibility, or composition. The reusable OCR/document-processing runtime should remain a Ghatana platform capability.

### Why

The current repository structure already shows that the OCR work is fundamentally broader than Media. `ghatana-shared` owns two reusable authorities:

- `@ghatana/documents` — governed document identity, immutable versions, access, retention, integrity, scanning, storage references, and lifecycle.
- `@ghatana/document-extraction` — provider-neutral parsing/extraction contracts and deterministic orchestration. It explicitly says it does **not** own OCR/parser implementations, model runtimes, storage, endpoints, queues, or product semantics.

That second package is particularly decisive. Its architecture is essentially:

```text
Governed document
      ↓
parser provider
      ↓
normalized parsed document
      ↓
template/schema matching
      ↓
field extraction
      ↓
validation/reconciliation
      ↓
confidence/review routing
```

That is **document intelligence**, not a Media-product workflow.

The concrete worker currently under:

```text
ghatana/
  services/media/modules/intelligence/
    document-intelligence-worker/
```

already consumes those Shared contracts and provides Docling, PaddleOCR, Tesseract, GLiNER, MiniLM and hybrid-PDF capabilities. It also handles:

```text
PDF
PNG
JPEG
DOCX
PPTX
XLSX
```

which is another strong sign that its real domain is documents rather than audio/video media.

Its placement under `services/media` is therefore something I would treat as an existing ownership mismatch to correct during the Media extraction, rather than carrying that coupling into the new repository.

## Recommended ownership

I would establish this:

```text
ghatana-shared
│
├── @ghatana/documents
│      governed document contracts
│
└── @ghatana/document-extraction
       provider-neutral extraction engine/contracts
             │
             ▼
ghatana
└── services/document-intelligence
       concrete reusable runtime
       ├── Docling
       ├── PaddleOCR
       ├── Tesseract
       ├── hybrid PDF
       ├── GLiNER
       ├── MiniLM
       └── future document providers
             │
       ┌─────┼────────────────┐
       ▼     ▼                ▼
 Data Cloud  Products      ghatana-media
```

I would use the name:

```text
services/document-intelligence
```

rather than `services/ocr`.

OCR is only one implementation capability. The current system already does substantially more:

- native PDF parsing;
- scanned-document OCR;
- Office parsing;
- layout/geometry;
- tables;
- semantic/entity extraction;
- schema-guided extraction;
- embeddings/similarity;
- provenance;
- quality assessment;
- provider fallback;
- multilingual handling;
- structured extraction.

Calling the service `ocr` would underspecify its domain almost immediately.

## Clean boundary

The resulting responsibilities should be:

| Capability | Owner |
|---|---|
| Governed document model | `ghatana-shared/@ghatana/documents` |
| Extraction contracts/engine | `ghatana-shared/@ghatana/document-extraction` |
| OCR/parser provider runtime | `ghatana/services/document-intelligence` |
| PDF/DOCX/PPTX/XLSX parsing | `ghatana/services/document-intelligence` |
| Schema-guided document extraction | `ghatana/services/document-intelligence` |
| Document review/confidence semantics | Shared contracts + consuming owner |
| Media artifact semantics | `ghatana-media` |
| Video-frame scene-text recognition | `ghatana-media` product capability |
| Image text used in Media editing | `ghatana-media` product capability |
| Captions from speech | `ghatana-media` |
| STT/TTS | `ghatana-media` |
| Text overlays/rendering | `ghatana-media` |
| Generic OCR implementation | **not Media-owned** |

### Important distinction: image ≠ necessarily Media-owned OCR

A JPEG or PNG being an image does not make its OCR a Media responsibility.

For example:

```text
receipt.jpg
invoice.png
passport-scan.png
form.png
whiteboard-photo.jpg
```

are **documents represented as images**.

They should naturally go through Document Intelligence.

Whereas:

```text
movie.mp4 frame 1860
      ↓
detect storefront text
      ↓
track text over frames
      ↓
make searchable / replace / translate / overlay
```

is a Media experience.

The distinction should therefore be **semantic intent**, not MIME type.

## Media should still expose OCR simply

I would not remove OCR from the Ghatana Media feature model.

A user should still be able to say:

```bash
ghatana-media understand text clip.mp4
ghatana-media understand text screenshot.png
```

or use the equivalent Web UI.

But internally:

```text
Media intent
    ↓
MediaTextRecognitionPort
    ↓
Document Intelligence public API
```

when that service is the appropriate execution provider.

The Media contract owns things such as:

```text
timestamp
frame range
track
bounding region
motion association
scene identity
timeline
overlay replacement
translation/render intent
```

Document Intelligence returns reusable recognition facts such as:

```text
text
geometry
language
confidence
page/image coordinates
provider provenance
```

That is a healthy anti-corruption boundary.

## Video OCR needs an additional Media layer

There is one important reason not to blindly make all visual OCR a document API call.

Video text recognition often requires:

```text
frame sampling
shot boundaries
temporal tracking
region persistence
motion compensation
duplicate suppression
time ranges
subtitle/text distinction
text appearance/disappearance
```

Those are genuine Media semantics.

So I would define:

```text
MediaSceneTextEngine
```

or preferably the less implementation-heavy capability:

```text
media.understand.scene-text
```

with flow:

```text
video
 ↓
frame/shot selection
 ↓
text-region detection
 ↓
OCR provider
 ↓
temporal association
 ↓
SceneTextTrack
```

The OCR provider can be Document Intelligence.

The track belongs to Media.

## What I would move during the new-repo extraction

When `ghatana-media` is created, I would **not move** this tree wholesale:

```text
services/media/modules/intelligence/document-intelligence-worker
```

Instead split it.

### Move/stay in Ghatana

Create:

```text
ghatana/
  services/document-intelligence/
    launcher/
    runtime/
    providers/
      docling/
      paddleocr/
      tesseract/
      hybrid-pdf/
      gliner/
      minilm/
    delivery/
      api/
      sdk/
    evaluation/
    qualification/
    config/
```

Migrate the current worker there with behavior-preserving movement first.

Do **not redesign it while relocating it**.

Preserve its existing:

```text
qualification authority
provider identities
profiles
capability admissions
model manifests
evaluation datasets
routing rules
shared-contract lock
cancellation semantics
offline behavior
provenance
```

and then harden/refactor after parity.

### Move to `ghatana-media`

Only Media adapters/use cases should move:

```text
ghatana-media/
  capabilities/
    understand/
      scene-text/
      image-text/

  integrations/
    document-intelligence/

  domain/
    scene-text/
```

Potential types:

```text
SceneTextObservation
SceneTextTrack
SceneTextRegion
FrameTextObservation
TextAppearanceInterval
TextReplacementIntent
```

Do **not** copy the Shared `ParsedDocument` or extraction schema into Media.

## One more architectural improvement

I would make Document Intelligence itself consume **AI Inference** when it genuinely needs generic model execution, following the same rule we established for Media:

```text
Document Intelligence
   owns:
     parsing semantics
     OCR semantics
     extraction semantics
     capability qualification

AI Inference
   owns:
     generic model/provider routing
     model credentials
     quota
     model fleet
     provider failover
```

Local fixed OCR/parser implementations such as deterministic Tesseract/Docling/Paddle deployments can remain service-owned provider adapters when that is the appropriate design; we do not need to force every local library invocation through AI Inference.

## Dependency direction

The clean result becomes:

```text
                    ghatana-shared
              ┌──────────┴──────────┐
              │                     │
       @ghatana/documents   @ghatana/document-extraction
                                  │
                                  ▼
                    ghatana/document-intelligence
                       │          │
                       │          └──── AI Inference
                       │
                public API/SDK
                ┌──────┼───────────┐
                ▼      ▼           ▼
          ghatana-media  Data Cloud  other products
```

Critically:

```text
ghatana-media
     X
does NOT become the OCR dependency
for the rest of Ghatana.
```

That would be the main architectural problem if we carried the document-intelligence worker into the new standalone Media product.

## Recommendation for the Media migration plan

I would change the extraction inventory classification from something equivalent to:

```text
document-intelligence-worker
→ MOVE_TO_MEDIA
```

to:

```text
document-intelligence-worker
→ REHOME_TO_GHATANA_DOCUMENT_INTELLIGENCE
```

and classify its components individually:

```text
Shared extraction contracts
    → KEEP_IN_GHATANA_SHARED

generic OCR/parser worker
    → MOVE_TO_GHATANA_SERVICES_DOCUMENT_INTELLIGENCE

qualification/evaluation assets
    → MOVE_WITH_DOCUMENT_INTELLIGENCE

Media-specific adapter
    → REBUILD_THIN_ADAPTER_IN_GHATANA_MEDIA

video scene-text semantics
    → GHATANA_MEDIA

generic document extraction semantics
    → GHATANA_SHARED + DOCUMENT_INTELLIGENCE
```

### Final recommendation

**Create `ghatana-media` without the generic Document Intelligence/OCR worker.**

At the same time, graduate the existing worker out of the old Media hierarchy into:

```text
ghatana/services/document-intelligence
```

while keeping its canonical provider-neutral contracts in:

```text
ghatana-shared/@ghatana/documents
ghatana-shared/@ghatana/document-extraction
```

Then let `ghatana-media` consume Document Intelligence for OCR where appropriate and own only the **media-specific temporal/scene semantics around recognized text**.

That gives us much cleaner reuse, prevents a platform capability from becoming dependent on a product, and makes the new `ghatana-media` boundary substantially stronger.