/** Public loopback-only client for exact-project-version render preview. */
import {
  MediaDevOnlyRenderExportClient,
  type DevRenderRequest,
  type DevRenderResult,
} from "./dev-render-export.js";
import type { MediaTransportConfig } from "./http-core.js";

export type {
  DevProjectRenderLineage,
  DevRenderFormat,
  DevRenderRequest,
  DevRenderResult,
  DevRenderSourceVersion,
} from "./dev-render-export.js";

/**
 * Accesses the local DEV_ONLY project-render routes through the same authenticated transport as the Media SDK.
 * Render results retain exact project, revision, timeline and source artifact-version references. Content reads
 * require the returned artifact version and verify the registered size, MIME type and digest before returning bytes.
 * This adapter is deliberately loopback-only and does not imply production admission or delivery.
 */
export class MediaDevOnlyProjectRenderClient {
  private readonly client: MediaDevOnlyRenderExportClient;

  public constructor(config: MediaTransportConfig) {
    this.client = new MediaDevOnlyRenderExportClient(config);
  }

  public renderProject(projectId: string, request: DevRenderRequest, signal?: AbortSignal): Promise<DevRenderResult> {
    return this.client.renderProject(projectId, request, signal);
  }

  public getRender(projectId: string, renderId: string, signal?: AbortSignal): Promise<DevRenderResult> {
    return this.client.getRender(projectId, renderId, signal);
  }

  public readRenderContent(render: DevRenderResult, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.client.readRenderContent(render, maxBytes, signal);
  }
}
