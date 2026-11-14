import { DevVoiceHostError } from "@audio-video/ui/screens";
import type {
  DevVoiceHostResponse, DevVoiceSynthesisPort, DevVoiceTimelinePlacement, DevVoiceTimelineRequest,
} from "@audio-video/ui/screens";
import { MediaDevProjectTimelineClient, MediaDevProjectTimelineError } from "@audio-video/client/dev-project-timeline";
import type { DevRationalTime, DevTimelineClip } from "@audio-video/client/dev-project-timeline";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";

export const VOICE_TIMELINE_ID = "timeline-main";
export const VOICE_SCENE_ID = "scene-voice";
export const VOICE_TRACK_ID = "audio-voice";
/** Audio clips are placed on a 24 fps story clock; ticks are floored so a clip never exceeds its source. */
const FRAME_RATE = 24;

const time = (ticks: number, clock: DevRationalTime["clock"]): DevRationalTime =>
  ({ ticks: String(ticks), rateNumerator: String(FRAME_RATE), rateDenominator: "1", clock });

/**
 * Loopback fetch adapter for the DEV_ONLY speech routes plus the project timeline that "Add to timeline" writes.
 * The token is read from page memory per call and never stored. A mutation whose outcome cannot be observed is
 * status 0 / OUTCOME_UNKNOWN so the UI retries the same requestId. The first placement creates one project with an
 * audio track; later placements append to that same project at its current head and are idempotent by clip id.
 */
export function createDevVoiceSynthesisClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevVoiceSynthesisPort & { readonly projectId: () => string | null } {
  const fetcher = options.fetch ?? fetch;
  const timeline = new MediaDevProjectTimelineClient({
    baseUrl: options.origin, bearerToken: options.bearerToken, fetch: fetcher as typeof fetch,
  });
  let projectId: string | null = null;

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevVoiceHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevVoiceHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevVoiceHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevVoiceHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevVoiceHostError(code, response.status, message, details);
  }

  const randomId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

  async function addToTimeline(request: DevVoiceTimelineRequest): Promise<DevVoiceTimelinePlacement> {
    try {
      const ticks = Math.max(1, Math.floor((request.durationMillis * FRAME_RATE) / 1000));
      const clipFor = (start: number): DevTimelineClip => ({
        clipId: request.clipId, sceneId: VOICE_SCENE_ID, trackId: VOICE_TRACK_ID,
        source: { artifactId: request.artifactId, artifactVersionId: request.artifactVersionId },
        sourceIn: time(0, "SOURCE_PRESENTATION"), sourceOut: time(ticks, "SOURCE_PRESENTATION"),
        storyStart: time(start, "STORY"), storyDuration: time(ticks, "STORY"),
      });
      if (projectId === null) {
        const context = await timeline.getContext();
        const created = await timeline.createProject({
          selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
          title: "Voice synthesis", requestId: `voice-project-${randomId()}`,
        });
        const withTimeline = await timeline.createTimeline(created.project.projectId, {
          expectedHeadRevisionId: created.initialRevision.revisionId, timelineId: VOICE_TIMELINE_ID,
        });
        const edited = await timeline.editTimeline(created.project.projectId, VOICE_TIMELINE_ID, {
          expectedHeadRevisionId: withTimeline.revision.revisionId,
          edits: [
            { type: "addScene", sceneId: VOICE_SCENE_ID, order: 0 },
            { type: "addTrack", trackId: VOICE_TRACK_ID, sceneId: VOICE_SCENE_ID, trackKind: "AUDIO", order: 0 },
            { type: "putClip", clip: clipFor(0) },
          ],
        });
        projectId = created.project.projectId;
        return { projectId, timelineId: VOICE_TIMELINE_ID, revisionId: edited.revision.revisionId, clipId: request.clipId, trackId: VOICE_TRACK_ID };
      }
      const current = await timeline.getProject(projectId);
      const head = current.currentRevision.revisionId;
      const graph = current.currentRevision.timelines.find((candidate) => candidate.graph.timelineId === VOICE_TIMELINE_ID)?.graph;
      const existing = graph?.clips.find((clip) => clip.clipId === request.clipId);
      if (existing) {
        // Idempotent: the same synthesis is already on the timeline at this head.
        return { projectId, timelineId: VOICE_TIMELINE_ID, revisionId: head, clipId: request.clipId, trackId: VOICE_TRACK_ID };
      }
      let end = 0;
      for (const clip of graph?.clips ?? []) {
        if (clip.trackId === VOICE_TRACK_ID) end = Math.max(end, Number(clip.storyStart.ticks) + Number(clip.storyDuration.ticks));
      }
      const edited = await timeline.editTimeline(projectId, VOICE_TIMELINE_ID, {
        expectedHeadRevisionId: head, edits: [{ type: "putClip", clip: clipFor(end) }],
      });
      return { projectId, timelineId: VOICE_TIMELINE_ID, revisionId: edited.revision.revisionId, clipId: request.clipId, trackId: VOICE_TRACK_ID };
    } catch (error) {
      if (error instanceof MediaDevProjectTimelineError) {
        throw new DevVoiceHostError(error.code, error.status, error.message);
      }
      throw error;
    }
  }

  return {
    getCapabilities: () => call("GET", "/dev/v1/speech/capabilities", undefined, false),
    synthesize: (request) => call("POST", "/dev/v1/speech/syntheses", request, true),
    readArtifactContent: createDevArtifactContentClient(options),
    addToTimeline,
    projectId: () => projectId,
  };
}
