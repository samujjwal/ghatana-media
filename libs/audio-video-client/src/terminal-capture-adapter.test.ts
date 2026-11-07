import { describe, expect, it } from "vitest";
import {
  CaptureNotAdmittedError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureAdapterEligibility,
  type CaptureRequest,
} from "./capture-adapters";
import {
  normalizeTerminalText,
  TerminalCaptureAdapter,
  TerminalCaptureError,
  type TerminalSession,
} from "./terminal-capture-adapter";

const admitted: CaptureAdapterEligibility = { check: () => "ADMITTED" };

const request: CaptureRequest = {
  kind: "TERMINAL",
  sourceIdentity: "terminal:pty-7",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/pty-7/v1",
  sourceVersionRef: "pty-7@v1",
  secretsRef: "secrets/capture-terminal",
  frameClockRef: "clock/monotonic",
};

interface FakeSession extends TerminalSession {
  detachCalls: number;
}

/** Scripted session: yields chunks then null; geometry mutable per step. */
function fakeSession(
  chunks: ReadonlyArray<Uint8Array>,
  geometry = { cols: 80, rows: 24 },
): FakeSession {
  let index = 0;
  const session: FakeSession = {
    detachCalls: 0,
    read: () => Promise.resolve(index < chunks.length ? chunks[index++] : null),
    geometry: () => geometry,
    detach: function () {
      this.detachCalls += 1;
      return Promise.resolve();
    },
  };
  return session;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("TerminalCaptureAdapter", () => {
  it("captures a normalized timed transcript preserving rights/version/clock echo", async () => {
    const session = fakeSession([enc("$ echo hi\nhi\n"), enc("$ exit\n")]);
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session });
    const frame = await adapter.capture(request);
    const transcript = new TextDecoder().decode(frame.bytes).trim().split("\n").map((l) => JSON.parse(l));
    expect(transcript).toHaveLength(2);
    expect(transcript[0].text).toBe("$ echo hi\nhi\n");
    expect(transcript[0].cols).toBe(80);
    expect(transcript[1].t).toBeGreaterThanOrEqual(transcript[0].t);
    expect(frame.exactRightsScope).toBe("rights/pty-7/v1");
    expect(frame.sourceVersionRef).toBe("pty-7@v1");
    expect(frame.frameClockRef).toBe("clock/monotonic");
    expect(session.detachCalls).toBe(1);
  });

  it("strips ANSI escapes including injected color/cursor sequences", async () => {
    const session = fakeSession([enc("\x1b[31mred\x1b[0m \x1b[2J\x1b[Hclean\x1b]8;;http://evil\x07link\x1b]8;;\x07\n")]);
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session });
    const frame = await adapter.capture(request);
    const text = JSON.parse(new TextDecoder().decode(frame.bytes)).text;
    expect(text).toBe("red cleanlink\n");
  });

  it("records geometry changes across TTY resizes", async () => {
    const geometry = { cols: 80, rows: 24 };
    const chunks = [enc("before\n"), enc("after\n")];
    let index = 0;
    const session: FakeSession = {
      detachCalls: 0,
      read: () => {
        if (index === 1) { geometry.cols = 132; geometry.rows = 43; }
        return Promise.resolve(index < chunks.length ? chunks[index++] : null);
      },
      geometry: () => geometry,
      detach() { this.detachCalls += 1; return Promise.resolve(); },
    };
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session });
    const frame = await adapter.capture(request);
    const lines = new TextDecoder().decode(frame.bytes).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].cols).toBe(80);
    expect(lines[1].cols).toBe(132);
    expect(lines[1].rows).toBe(43);
  });

  it("redacts built-in secret shapes and host patterns before emitting bytes", async () => {
    const session = fakeSession([enc(
      "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" +
      "curl -H 'Authorization: Bearer abcdefghijklmnop1234'\n" +
      "token=supersecretvalue\n" +
      "-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----\n",
    )]);
    const adapter = new TerminalCaptureAdapter({
      resolveSession: () => session,
      redactPatterns: [/hunter2/g],
    });
    const frame = await adapter.capture({ ...request, secretsRef: "secrets/host-scoped" });
    const text = new TextDecoder().decode(frame.bytes);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(text).not.toContain("supersecretvalue");
    expect(text).not.toContain("PRIVATE KEY-----\nxyz");
    expect(text).toContain("‹REDACTED›");
  });

  it("rejects a resolver that returns a non-session — no off-session capture", async () => {
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => "/tmp/any" as unknown as TerminalSession });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(TerminalCaptureError);
  });

  it("rejects mismatched request kinds before resolving any session", async () => {
    let resolved = 0;
    const adapter = new TerminalCaptureAdapter({
      resolveSession: () => { resolved += 1; return fakeSession([]); },
    });
    await expect(adapter.capture({ ...request, kind: "BROWSER" })).rejects.toBeInstanceOf(TypeError);
    expect(resolved).toBe(0);
  });

  it("enforces the byte bound mid-stream and still detaches exactly once", async () => {
    const session = fakeSession([enc("x".repeat(4096)), enc("y".repeat(4096))]);
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session, maxBytes: 5000 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(TerminalCaptureError);
    expect(session.detachCalls).toBe(1);
  });

  it("honors the session duration bound", async () => {
    const chunks = [enc("a\n"), enc("b\n"), enc("c\n")];
    let index = 0;
    const session: FakeSession = {
      detachCalls: 0,
      read: () => new Promise((res) => setTimeout(() => res(index < chunks.length ? chunks[index++] : null), 5)),
      geometry: () => ({ cols: 80, rows: 24 }),
      detach() { this.detachCalls += 1; return Promise.resolve(); },
    };
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session, maxSessionMillis: 1 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(TerminalCaptureError);
    expect(session.detachCalls).toBe(1);
  });

  it("bounds a host read that never settles and detaches the explicit session", async () => {
    const session: FakeSession = {
      detachCalls: 0,
      read: () => new Promise(() => undefined),
      geometry: () => ({ cols: 80, rows: 24 }),
      detach() { this.detachCalls += 1; return Promise.resolve(); },
    };
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session, maxSessionMillis: 20 });
    await expect(adapter.capture(request)).rejects.toBeInstanceOf(TerminalCaptureError);
    expect(session.detachCalls).toBe(1);
  });

  it("external detach unblocks an in-flight capture and closes once", async () => {
    let detached = false;
    const session: FakeSession = {
      detachCalls: 0,
      read: () => new Promise((res) => {
        const timer = setInterval(() => { if (detached) { clearInterval(timer); res(null); } }, 5);
      }),
      geometry: () => ({ cols: 80, rows: 24 }),
      detach() { detached = true; this.detachCalls += 1; return Promise.resolve(); },
    };
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => session });
    const pending = adapter.capture(request);
    await new Promise((r) => setTimeout(r, 20));
    await adapter.detach();
    const frame = await pending;
    expect(session.detachCalls).toBe(1);
    expect(frame.bytes.byteLength).toBe(0);
  });

  it("rejects invalid constructor bounds", () => {
    expect(() => new TerminalCaptureAdapter({ resolveSession: () => fakeSession([]), maxBytes: 0 })).toThrow(TypeError);
    expect(() => new TerminalCaptureAdapter({ resolveSession: () => fakeSession([]), maxSessionMillis: 0 })).toThrow(TypeError);
    // @ts-expect-error missing resolver must fail fast
    expect(() => new TerminalCaptureAdapter({})).toThrow(TypeError);
  });

  it("passes through the admission seam — unwired eligibility rejects before capture", async () => {
    const adapter = new TerminalCaptureAdapter({ resolveSession: () => fakeSession([enc("x\n")]) });
    await expect(
      captureWithAdmission(noAdmittedCaptureAdapter, adapter, request),
    ).rejects.toBeInstanceOf(CaptureNotAdmittedError);
    const adapter2 = new TerminalCaptureAdapter({ resolveSession: () => fakeSession([enc("x\n")]) });
    await expect(
      captureWithAdmission(admitted, adapter2, request),
    ).resolves.toBeDefined();
  });
});

describe("normalizeTerminalText", () => {
  it("normalizes CRLF/CR and strips control bytes", () => {
    expect(normalizeTerminalText("a\r\nb\rc\x00d\x7f\n")).toBe("a\nb\ncd\n");
  });
});
