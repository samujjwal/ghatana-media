/**
 * PDP-3 proposal inventory of observed wire-route families. OpenAPI and the
 * runtime route manifest are wire-projection inputs, not semantic authority.
 * Existing exported names and route values remain for source compatibility.
 */
/** Observed OpenAPI/runtime-manifest routes; semantic mapping is pending. */
export const canonicalMediaHttpRoutes = Object.freeze({
  beginUpload: "/api/v1/artifacts/uploads",
  getUpload: "/api/v1/artifacts/uploads/{uploadId}",
  appendChunk: "/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}",
  completeUpload: "/api/v1/artifacts/uploads/{uploadId}/complete",
  getArtifact: "/api/v1/artifacts/{artifactId}",
  submitJob: "/api/v1/jobs",
  getJob: "/api/v1/jobs/{jobId}",
  cancelJob: "/api/v1/jobs/{jobId}/cancel",
  listProviders: "/api/v1/providers",
  health: "/api/v1/health",
} as const);

/** Representative existing operation-client compatibility routes; unchanged. */
export const legacyCompatibilityRoutes = Object.freeze({
  transcribe: "/api/v1/media/transcriptions",
  synthesize: "/api/v1/media/syntheses",
  operations: "/api/v1/media/operations/{operationId}",
  uploads: "/api/v1/media/uploads",
  artifacts: "/api/v1/media/artifacts/{artifactId}",
  providers: "/api/v1/media/providers/capabilities",
} as const);

/**
 * Backward-compatible export name and value. These paths identify observed
 * wire-projection inputs only; they do not confer semantic authority.
 */
export const mediaHttpRouteAuthority = "contracts/openapi/media.yaml + config/route-manifest.json" as const;
