/** Media types admitted by the Increment-4A worker profile (`profiles/increment4a.yaml`). */
export const MEDIA_PDF = 'application/pdf' as const;
export const MEDIA_PNG = 'image/png' as const;
export const MEDIA_JPEG = 'image/jpeg' as const;
export const MEDIA_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
export const MEDIA_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;
export const MEDIA_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

/** Candidate languages declared by the Increment-4A profile. Languages outside
 * this set are `NOT_EVALUATED`, not unsupported by design. These are
 * candidates only — advertised capabilities are derived solely from ACCEPTED
 * `GET /v1/providers` records, never from this constant. */
export const INCREMENT4A_CANDIDATE_LANGUAGES = Object.freeze(['en', 'ne', 'hi', 'mr'] as const);

export const PROVIDER_DOCLING = 'ghatana.docling' as const;
export const PROVIDER_PADDLEOCR = 'ghatana.paddleocr' as const;
export const PROVIDER_GLINER = 'ghatana.gliner' as const;
export const PROVIDER_MINILM = 'ghatana.minilm' as const;
export const PROVIDER_HYBRID_PDF = 'ghatana.hybrid-pdf' as const;
export const PROVIDER_DOCLING_DOCX = 'ghatana.docling-docx' as const;
export const PROVIDER_DOCLING_PPTX = 'ghatana.docling-pptx' as const;
export const PROVIDER_DOCLING_XLSX = 'ghatana.docling-xlsx' as const;
export const PROVIDER_TESSERACTOCR = 'ghatana.tesseractocr' as const;
export const PROVIDER_RESILIENT_PARSER = 'ghatana.resilient-parser' as const;
