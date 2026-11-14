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
  { method: "GET", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/comments$`, "u") },
  { method: "POST", path: new RegExp(`^/dev/v1/reviews/${OPAQUE_ID}/decisions$`, "u") },
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
