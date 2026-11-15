const ARTIFACT_NAMESPACE = "/api/v1/artifacts";
const DEV_PROJECT_NAMESPACE = "/dev/v1";
const CANONICAL_UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const OPAQUE_ID = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const routes = [
  { method: "POST", path: /^\/api\/v1\/artifacts\/uploads$/u },
  { method: "GET", path: new RegExp(`^/api/v1/artifacts/${CANONICAL_UUID}$`, "u") },
  { method: "GET", path: new RegExp(`^/api/v1/artifacts/uploads/${CANONICAL_UUID}$`, "u") },
  { method: "PUT", path: new RegExp(`^/api/v1/artifacts/uploads/${CANONICAL_UUID}/chunks/(?:0|[1-9][0-9]*)$`, "u"), maxChunkIndex: 2_147_483_647 },
  { method: "POST", path: new RegExp(`^/api/v1/artifacts/uploads/${CANONICAL_UUID}/complete$`, "u") },
];
const devProjectRoutes = [
  { method: "GET", path: /^\/dev\/v1\/context$/u },
  { method: "GET", path: /^\/dev\/v1\/artifact-upload-policy$/u },
  { method: "POST", path: /^\/dev\/v1\/projects$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/timelines$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/timelines/${OPAQUE_ID}/edits$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/restore$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/revisions/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY render and review lanes used by the "Render and review" panel.
  { method: "POST", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/renders$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/projects/${OPAQUE_ID}/renders/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/reviews$/u },
  // DEV_ONLY version-specific review (J-21): assigned-to-me list, per-version approval state of a lineage, and the exact
  // immutable version bytes for the assigned reviewer's player. Reads only.
  { method: "GET", path: /^\/dev\/v1\/reviews$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/versions$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/content$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/review-lineages/${OPAQUE_ID}$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/comments$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/decisions$`, "u") },
  // DEV_ONLY owner-assigned reviewer lane (assign and revoke; there is no DELETE).
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/assignments$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/assignments/${OPAQUE_ID}/revoke$`, "u") },
  // DEV_ONLY rights and consent lane (uploader statement, second-person confirmation, revocation, per-version list).
  { method: "POST", path: /^\/dev\/v1\/rights\/attestations$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/rights/attestations/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/rights/attestations/${OPAQUE_ID}/confirm$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/rights/attestations/${OPAQUE_ID}/revoke$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/rights/artifacts/${OPAQUE_ID}/versions/${OPAQUE_ID}/attestations$`, "u") },
  // DEV_ONLY versioned artifact intake used by the "Resumable upload" page (register a finalised upload as the next
  // version of a lineage, read the lineage with probes and the live processing-admission verdict; no DELETE).
  { method: "POST", path: /^\/dev\/v1\/intakes$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/intakes/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY hosted export lane used by the "Export this render artifact" control.
  { method: "POST", path: /^\/dev\/v1\/exports$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/exports/${OPAQUE_ID}$`, "u") },
  // Reconcile an unresolved export against the destination's own state (resume true|false in the body).
  { method: "POST", path: new RegExp(`^/dev/v1/exports/${OPAQUE_ID}/reconcile$`, "u") },
  // DEV_ONLY exact-version content read for verified previews/downloads. The version travels in If-Match (no query).
  { method: "GET", path: new RegExp(`^/dev/v1/artifacts/${OPAQUE_ID}/content$`, "u") },
  // DEV_ONLY local speech lane used by the "Voice synthesis" page (synthesis only; transcription is not proxied).
  { method: "GET", path: /^\/dev\/v1\/speech\/capabilities$/u },
  { method: "POST", path: /^\/dev\/v1\/speech\/syntheses$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/speech/outputs/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY human caption correction used by the "Caption correction" page (exact-version read and correct).
  { method: "POST", path: /^\/dev\/v1\/captions\/corrections$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/captions/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY creative-output lanes used by the "Creative outputs" page.
  { method: "POST", path: /^\/dev\/v1\/creative-outputs\/audio-repairs$/u },
  { method: "POST", path: /^\/dev\/v1\/creative-outputs\/simulations$/u },
  { method: "POST", path: /^\/dev\/v1\/creative-outputs\/spatial-glb$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/creative-outputs/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY audio restoration used by the "Audio restoration A/B" page (restore, compare, status, reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/audio\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/audio\/restorations$/u },
  { method: "POST", path: /^\/dev\/v1\/audio\/comparisons$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/audio/outputs/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY grounded cross-modal answers used by the "Grounded answers" page (ask, status, reopen; no DELETE).
  { method: "POST", path: /^\/dev\/v1\/grounded-answers$/u },
  { method: "GET", path: /^\/dev\/v1\/grounded-answers\/status$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/grounded-answers/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY translation and stock-voice dubbing used by the "Translate and dub" page (no DELETE, no voice sample).
  { method: "GET", path: /^\/dev\/v1\/translations\/capabilities$/u },
  { method: "POST", path: /^\/dev\/v1\/translations$/u },
  { method: "POST", path: /^\/dev\/v1\/translations\/revisions$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/translations/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/dubs$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/dubs/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY local vision lanes used by the "Video tracking" page (tracks, ROI analysis, reopen by output id).
  { method: "POST", path: /^\/dev\/v1\/vision\/tracks$/u },
  { method: "POST", path: /^\/dev\/v1\/vision\/roi-analyses$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/vision/outputs/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY video enhancement and measured comparison (J-08) used by the "Video comparison" page.
  { method: "POST", path: /^\/dev\/v1\/video\/enhancements$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/video/enhancements/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/video\/comparisons$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/video/comparisons/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY deterministic 2D animation (J-12) used by the "2D animation" page (status, render, reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/animations\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/animations\/renders$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/animations/renders/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY rights-checked reference-conditioned scenes (J-10) used by the "Reference scenes" page (status, reference set,
  // run, reopen, regeneration proof; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/reference-scenes\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/reference-scenes\/reference-sets$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/reference-scenes/reference-sets/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/reference-scenes\/runs$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/reference-scenes/runs/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reference-scenes/runs/${OPAQUE_ID}/regenerations$`, "u") },
  // DEV_ONLY deterministic 3D rig render (J-13) used by the "3D rig" page (status, render, reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/rigs\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/rigs\/renders$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/rigs/renders/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY scientific simulation (J-14/J-15) used by the "Scientific simulation" page (status, run, reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/simulations\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/simulations$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/simulations/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY bounded quality optimization (J-19) used by the "Quality optimization" page (status, search, cancel,
  // report reopen, lineage read, undo; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/quality\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/quality\/optimizations$/u },
  { method: "POST", path: new RegExp(`^/dev/v1/quality/optimizations/${OPAQUE_ID}/cancel$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/quality/optimizations/${OPAQUE_ID}$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/quality/lineages/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/quality/lineages/${OPAQUE_ID}/undo$`, "u") },
  // DEV_ONLY tracked region edit (J-11) used by the "Region edit" page (status, lineage, edit, undo; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/region-edits\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/region-edits\/lineages$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/region-edits/lineages/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/region-edits/lineages/${OPAQUE_ID}/(edits|undo)$`, "u") },
  // DEV_ONLY stems, foley, mix and loudness master (J-17) used by the "Stems and master" page (status, build stem, master,
  // reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/masters\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/masters\/stems$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/masters/stems/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/masters$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/masters/(?!(?:stems|status)$)${OPAQUE_ID}$`, "u") },
  // DEV_ONLY live capture sessions (J-29) used by the "Live capture" page (status, open, read, frames, end of stream, abort;
  // no DELETE). Frames are a binary POST; no query string is ever forwarded.
  { method: "GET", path: /^\/dev\/v1\/live-sessions\/status$/u },
  { method: "POST", path: /^\/dev\/v1\/live-sessions$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/live-sessions/(?!status$)${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/live-sessions/${OPAQUE_ID}/(?:frames|eos|abort)$`, "u") },
  // DEV_ONLY erasure and legal-hold lane used by the "Erasure and legal hold" page (plan, confirm-erase, receipt, hold,
  // release). The hold listing takes a query string and is deliberately not proxied; the plan carries active holds.
  { method: "GET", path: new RegExp(`^/dev/v1/erasure-plans/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/erasures$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/erasures/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: /^\/dev\/v1\/legal-holds$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/legal-holds/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/legal-holds/${OPAQUE_ID}/release$`, "u") },
  // DEV_ONLY multitrack composite render (J-18) used by the "Multitrack finished master" page (status, render, cancel, reopen; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/composite-renders\/capabilities$/u },
  { method: "POST", path: /^\/dev\/v1\/composite-renders$/u },
  { method: "POST", path: new RegExp(`^/dev/v1/composite-renders/${OPAQUE_ID}/cancel$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/composite-renders/${OPAQUE_ID}$`, "u") },
  // DEV_ONLY versioned storyboard (J-09) used by the "Brief to reviewed media" page (versions, readiness, render, review handoff; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/storyboards\/capabilities$/u },
  { method: "POST", path: /^\/dev\/v1\/storyboards$/u },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions/[0-9]{1,6}$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/readiness$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/renders$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions/[0-9]{1,6}/render$`, "u") },
  { method: "GET", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions/[0-9]{1,6}/review$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/storyboards/${OPAQUE_ID}/versions/[0-9]{1,6}/review$`, "u") },
  // DEV_ONLY observed local provider readiness used by the "Local providers" page (read-only; no DELETE).
  { method: "GET", path: /^\/dev\/v1\/providers\/catalog$/u },
];

function isCanonicalPath(requestUrl) {
  return !requestUrl.includes("?") && !requestUrl.includes("%") && !requestUrl.includes("\\")
    && !requestUrl.includes("//") && !requestUrl.split("/").some((segment) => segment === "." || segment === "..");
}

/** Match only the canonical upload API methods and raw path spellings. */
export function isAllowedArtifactProxyRequest(method, requestUrl) {
  if (typeof method !== "string" || typeof requestUrl !== "string" || !isCanonicalPath(requestUrl)) return false;
  const route = routes.find((candidate) => candidate.method === method && candidate.path.test(requestUrl));
  if (!route) return false;
  if (route.maxChunkIndex !== undefined) {
    const index = Number(requestUrl.slice(requestUrl.lastIndexOf("/") + 1));
    if (!Number.isSafeInteger(index) || index > route.maxChunkIndex) return false;
  }
  return true;
}

/** Match only the exact DEV_ONLY context/project/timeline routes and methods. */
export function isAllowedDevProjectProxyRequest(method, requestUrl) {
  if (typeof method !== "string" || typeof requestUrl !== "string" || !isCanonicalPath(requestUrl)) return false;
  return devProjectRoutes.some((route) => route.method === method && route.path.test(requestUrl));
}

/** Vite middleware rejects every request in the artifact namespace unless it is allowlisted. */
export function artifactProxyGuard(request, response, next) {
  const requestUrl = request.url ?? "/";
  const artifactRequest = requestUrl === ARTIFACT_NAMESPACE || requestUrl.startsWith(`${ARTIFACT_NAMESPACE}/`);
  const devProjectRequest = requestUrl === DEV_PROJECT_NAMESPACE || requestUrl.startsWith(`${DEV_PROJECT_NAMESPACE}/`);
  if (!artifactRequest && !devProjectRequest) return next();
  if ((artifactRequest && isAllowedArtifactProxyRequest(request.method, requestUrl))
    || (devProjectRequest && isAllowedDevProjectProxyRequest(request.method, requestUrl))) return next();
  response.statusCode = 404;
  response.setHeader("Cache-Control", "no-store");
  response.end("Local Media route is not allowlisted.");
}
