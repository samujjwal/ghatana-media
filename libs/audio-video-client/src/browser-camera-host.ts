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
      }).catch(() => listener("UNKNOWN"));
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
        stream.getTracks().forEach((item) => item.stop());
        throw new DOMException("aborted", "AbortError");
      }
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      if (!track || settings?.deviceId !== deviceId || options.sourceVersionRef(deviceId) !== request.sourceVersionRef) {
        stream.getTracks().forEach((item) => item.stop());
        throw new Error("browser did not bind the exact requested camera source revision");
      }
      const video = documentApi.createElement("video");
      const canvas = documentApi.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: false });
      if (!context) { stream.getTracks().forEach((item) => item.stop()); throw new Error("camera frame canvas is unavailable"); }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      let stopped = false;
      const stop = () => { if (stopped) return; stopped = true; video.pause(); video.srcObject = null; stream.getTracks().forEach((item) => item.stop()); };
      try { await video.play(); } catch (error) { stop(); throw error; }
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
        stop,
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
