export type LifecycleCandidatePack = {
  readonly schemaVersion: "ghatana.surface-experience-pack.v1";
  readonly surface: {
    readonly id: string;
    readonly kind: "PHYSICAL" | "LOGICAL" | "COMPOSITION" | "REPOSITORY";
    readonly admissionStatus: string;
    readonly programId: string;
    readonly boundPrograms: readonly string[];
    readonly unitIdentityPrefix?: string | null;
    readonly [key: string]: unknown;
  };
  readonly program: { readonly programId: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
};

export type LifecycleCandidatePayload = {
  readonly schemaVersion: "gtool.experience-show.v1";
  readonly mode: "OBSERVATION";
  readonly readOnly: true;
  readonly pack: LifecycleCandidatePack;
};

export function consumeLifecyclePackCandidate(input: {
  source: string;
  payload: LifecycleCandidatePayload | unknown;
  selector: { surfaceId: string; programId: string };
  supportedVersions?: readonly string[];
}):
  | { ok: true; mode: "TEST_ONLY"; version: string; nativeLifecycleStatus: "NOT_ADMITTED"; pack: LifecycleCandidatePack }
  | { ok: false; reason: string; version?: string };

export const lifecyclePackCandidateProtocol: Readonly<{
  source: string;
  packVersion: string;
  envelopeVersion: string;
}>;
