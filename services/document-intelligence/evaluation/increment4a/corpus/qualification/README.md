# Increment-4A language-provider qualification corpus

This corpus is split by language and provider surface. `ocr/hi` and `ocr/mr`
contain independently rendered Devanagari PNGs with checked-in ground truth;
`extraction/hi` and `extraction/mr` contain independent parsed-line fixtures,
positive entities, and negative/abstention cases.

The fixtures are safe synthetic text rendered with the local Noto Serif
Devanagari font. They are not copied from the existing Increment-3 corpus.
The extraction fixtures do not reuse OCR output, so OCR and GLiNER results are
measured independently.

The slices are tracked as follows: I4A-R11 is PaddleOCR HI/MR artifact-gated
OCR evidence, I4A-R12 is frozen-GLiNER HI/MR extraction measurement, and
I4A-R13 is Tesseract EN/NE/HI/MR measurement plus cancellation/resource
semantics.

Qualification rules:

- missing local model artifacts produce `NOT_RUN`, never a synthetic PASS;
- HI and MR are reported as separate language lanes;
- GLiNER reports precision, recall, F1, evidence accuracy, abstention rate, and
  negative maximum confidence using the existing 0.5 abstention floor;
- Tesseract reports EN, NE, HI, and MR only when the executable and all four
  traineddata files are locally available, and always records cancellation and
  bounded-output/resource checks;
- the frozen GLiNER model is not silently replaced. An optional `indic_ner`
  remediation may be considered only after a frozen-lane failure and only when
  a local, pinned artifact is available.
