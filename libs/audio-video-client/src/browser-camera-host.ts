/** Concrete browser camera host backed by Permissions, getUserMedia and canvas JPEG encoding. */
import {
  BrowserCameraMediaDevicePort,
  type BrowserCameraCodecBinding,
  type BrowserCameraCodecPort,
  type BrowserCameraDevice,
  type BrowserCameraDevicePort,
  type CameraHostPermissionDisposition,
  type CameraHostPermissionPort,
  type CameraTrackSourceMetadata,
} from "./camera-capture-adapter.js";
import type { CaptureRequest } from "./capture-adapters.js";

export interface BrowserCameraHostOptions {
  /** Resolve host-owned source revisions; the browser itself does not expose device versions. */
  sourceVersionRef(deviceId: string): string | undefined;
  readonly maxFrameBytes?: number;
  readonly frameTimeoutMillis?: number;
  readonly maxPixels?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Injectable browser surface for deterministic host tests. */
  readonly browser?: {
    readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
    readonly permissions?: Pick<Permissions, "query">;
    readonly document?: Pick<Document, "createElement">;
  };
}

interface SizedBrowserCameraDevice extends BrowserCameraDevice { readonly width?: number; readonly height?: number }

type BrowserPermissionStatus = { state: PermissionState; addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void };

function deviceIdOf(identity: string): string | undefined {
  return identity.startsWith("camera:") && identity.length > "camera:".length
    ? identity.slice("camera:".length) : undefined;
}

function awaitHostStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function stopAllStreamTracks(stream: Pick<MediaStream, "getTracks">, knownTrack?: MediaStreamTrack): boolean {
  let failed = false;
  let tracks: readonly MediaStreamTrack[] = [];
  try { tracks = stream.getTracks(); } catch { failed = true; }
  if (knownTrack && !tracks.includes(knownTrack)) tracks = [...tracks, knownTrack];
  const attempted = new Set<MediaStreamTrack>();
  for (const item of tracks) {
    if (attempted.has(item)) continue;
    attempted.add(item);
    try { item.stop(); } catch { failed = true; /* continue attempting every owned track */ }
  }
  return failed;
}

/** Builds a fail-closed browser port. Permission `prompt` is UNKNOWN; this adapter never prompts. */
export function createBrowserCameraMediaDevicePort(options: BrowserCameraHostOptions): BrowserCameraMediaDevicePort {
  const media = options.browser?.mediaDevices ?? (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
  const permissionApi = options.browser?.permissions ?? (typeof navigator === "undefined" ? undefined : navigator.permissions);
  const documentApi = options.browser?.document ?? (typeof document === "undefined" ? undefined : document);
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
  const timeoutMillis = options.frameTimeoutMillis ?? 2_000;
  const maxPixels = options.maxPixels ?? 8_294_400;
  const maxWidth = options.maxWidth ?? 4_096;
  const maxHeight = options.maxHeight ?? 4_096;
  for (const [name, value] of [["maxFrameBytes", maxFrameBytes], ["frameTimeoutMillis", timeoutMillis],
    ["maxPixels", maxPixels], ["maxWidth", maxWidth], ["maxHeight", maxHeight]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }

  const permission: CameraHostPermissionPort = {
    async check(): Promise<CameraHostPermissionDisposition> {
      if (!permissionApi?.query) return "UNKNOWN";
      try {
        const status = await permissionApi.query({ name: "camera" as PermissionName });
        return status.state === "granted" ? "GRANTED" : status.state === "denied" ? "DENIED" : "UNKNOWN";
      } catch { return "UNKNOWN"; }
    },
    subscribe(_request, listener) {
      if (!permissionApi?.query) return () => undefined;
      let status: BrowserPermissionStatus | undefined;
      let active = true;
      void permissionApi.query({ name: "camera" as PermissionName }).then((value) => {
        if (!active) return;
        status = value as BrowserPermissionStatus;
        const changed = () => listener(status?.state === "granted" ? "GRANTED" : status?.state === "denied" ? "DENIED" : "UNKNOWN");
        status.addEventListener("change", changed);
        // Keep removal paired with the exact listener.
        unsubscribeChange = () => status?.removeEventListener("change", changed);
      }).catch(() => { if (active) listener("UNKNOWN"); });
      let unsubscribeChange: () => void = () => {};
      return () => { active = false; unsubscribeChange(); };
    },
  };

  const devices: BrowserCameraDevicePort = {
    async openExact(request: CaptureRequest, signal: AbortSignal): Promise<BrowserCameraDevice> {
      const deviceId = deviceIdOf(request.sourceIdentity);
      if (!media?.getUserMedia || !documentApi || !deviceId || options.sourceVersionRef(deviceId) !== request.sourceVersionRef) {
        throw new Error("requested browser camera source is unavailable or has a different revision");
      }
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const stream = await media.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId } } });
      // getUserMedia cannot be cancelled reliably. If cancellation wins while
      // the browser prompt/device startup is pending, release the late stream
      // before touching DOM media elements or exposing the device.
      if (signal.aborted) {
        stopAllStreamTracks(stream);
        throw new DOMException("aborted", "AbortError");
      }
      let track: MediaStreamTrack | undefined;
      let settings: MediaTrackSettings | undefined;
      let openedSourceVersion: string | undefined;
      try {
        track = stream.getVideoTracks()[0];
        settings = track?.getSettings();
        openedSourceVersion = options.sourceVersionRef(deviceId);
      } catch (error) {
        stopAllStreamTracks(stream, track);
        throw error;
      }
      if (!track || settings?.deviceId !== deviceId || openedSourceVersion !== request.sourceVersionRef) {
        stopAllStreamTracks(stream, track);
        throw new Error("browser did not bind the exact requested camera source revision");
      }
      let video: HTMLVideoElement;
      let canvas: HTMLCanvasElement;
      let context: CanvasRenderingContext2D | null;
      try {
        // DOM setup can fail after getUserMedia has activated the camera. Keep
        // the stream local until every required host object is ready, and
        // release it on every setup error before the adapter can own a track.
        video = documentApi.createElement("video");
        canvas = documentApi.createElement("canvas");
        context = canvas.getContext("2d", { willReadFrequently: false });
        if (!context) throw new Error("camera frame canvas is unavailable");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
      } catch (error) {
        stopAllStreamTracks(stream, track);
        throw error;
      }
      let stopped = false;
      let listenerRemovalAttempted = false;
      let cleanupFailure: Error | null = null;
      const recordCleanupFailure = () => {
        // Do not retain host exception text: it may contain device details.
        cleanupFailure ??= new Error("camera stream cleanup failed");
      };
      const stop = () => {
        if (!stopped) {
          stopped = true;
          // Cleanup must reach every track even when a DOM cleanup operation
          // throws (for example, a detached or host-managed media element).
          try { video.pause(); } catch { recordCleanupFailure(); }
          try { video.srcObject = null; } catch { recordCleanupFailure(); }
          if (stopAllStreamTracks(stream, track)) recordCleanupFailure();
        }
        if (cleanupFailure) throw cleanupFailure;
      };
      // A camera can be unplugged while the session is idle. Observe the
      // device-state transition directly so its stream is released without
      // waiting for a later frame request to discover `readyState !== live`.
      // Event dispatch must not leak a cleanup exception as an unhandled host
      // callback throw. The later explicit close still reports the failure.
      const onTrackEnded = () => { try { stop(); } catch { /* surfaced by explicit close */ } };
      const stopWithListenerCleanup = () => {
        if (!listenerRemovalAttempted) {
          listenerRemovalAttempted = true;
          try { track.removeEventListener("ended", onTrackEnded); } catch { recordCleanupFailure(); }
        }
        stop();
      };
      try { track.addEventListener("ended", onTrackEnded, { once: true }); }
      catch (error) {
        try { stopWithListenerCleanup(); } catch { /* preserve startup failure */ }
        throw error;
      }
      try {
        // Browser playback startup may remain pending after the host permission
        // changes. Do not leave an already opened camera stream alive while
        // waiting for that promise to settle.
        await awaitHostStartup(video.play(), signal);
        // The track may end while play() is pending (for example, if the
        // camera is unplugged). Do not expose a device whose stream has
        // already been torn down by the ended handler.
        if (stopped || track.readyState !== "live") {
          throw new Error("requested browser camera became unavailable during startup");
        }
      } catch (error) { stopWithListenerCleanup(); throw error; }
      const browserDevice: SizedBrowserCameraDevice = {
        sourceIdentity: request.sourceIdentity,
        sourceVersionRef: request.sourceVersionRef,
        width: settings.width,
        height: settings.height,
        async readFrame(frameSignal) {
          if (stopped || signal.aborted || frameSignal.aborted || track.readyState !== "live") return null;
          const width = video.videoWidth; const height = video.videoHeight;
          if (!width || !height) throw new Error("camera frame dimensions are unavailable");
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
            || width > maxWidth || height > maxHeight || width * height > maxPixels) {
            throw new Error("browser camera dimensions exceed configured pixel bounds");
          }
          canvas.width = width; canvas.height = height; context.drawImage(video, 0, 0, width, height);
          const blob = await new Promise<Blob>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("camera frame encoding timed out")), timeoutMillis);
            canvas.toBlob((result) => { clearTimeout(timer); result ? resolve(result) : reject(new Error("browser camera JPEG encoding failed")); }, "image/jpeg");
          });
          if (stopped || signal.aborted || frameSignal.aborted || track.readyState !== "live") return null;
          if (blob.size === 0 || blob.size > maxFrameBytes) throw new Error("browser camera frame exceeded the configured byte bound");
          return new Uint8Array(await blob.arrayBuffer());
        },
        stop: stopWithListenerCleanup,
      };
      return browserDevice;
    },
  };

  const codecs: BrowserCameraCodecPort = {
    async bind(request, device): Promise<BrowserCameraCodecBinding> {
      if (device.sourceIdentity !== request.sourceIdentity || device.sourceVersionRef !== request.sourceVersionRef) {
        throw new Error("camera codec cannot bind a different source revision");
      }
      const sizedDevice = device as SizedBrowserCameraDevice;
      if (!sizedDevice.width || !sizedDevice.height) throw new Error("browser camera dimensions are unavailable");
      const metadata: CameraTrackSourceMetadata = {
        sourceIdentity: request.sourceIdentity, sourceVersionRef: request.sourceVersionRef,
        allowedSignals: ["VIDEO"], selectedSignals: ["VIDEO"], syncPolicyRef: "sync-policy/independent-video:v1",
        codecDisposition: "AVAILABLE", codecProfileRef: "codec-profile/browser-jpeg:v1", codecId: "jpeg",
        mimeType: "image/jpeg", width: sizedDevice.width, height: sizedDevice.height,
        sourceClockRef: null, sourceStreamRef: null, sourceOriginRef: null, sourceTimeBase: null,
      };
      return { sourceMetadata: metadata, async encode(bytes, signal) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (bytes.byteLength === 0 || bytes.byteLength > maxFrameBytes) throw new Error("encoded camera frame is outside configured bounds");
        return { bytes: Uint8Array.from(bytes) };
      }, close() {} };
    },
  };
  return new BrowserCameraMediaDevicePort(permission, devices, codecs);
}
