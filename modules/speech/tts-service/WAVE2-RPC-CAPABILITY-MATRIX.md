# TTS Wave 2 W0 disposition inventory

This package-local inventory is a non-authoritative projection of the current gRPC boundary and the 17 registered PDP-0 capability intents. The source of truth remains `tts_service.proto` and `.product-experience/pdp-0-product-truth/capabilities.yaml`. The inventory does not qualify a provider or assert voice rights, model quality, or release status.

## 11 gRPC RPCs

| RPC | Current disposition | Boundary |
|---|---|---|
| Synthesize | EXPLICITLY_NOT_ADMITTED | The gRPC route rejects before engine lookup because no exact admitted voice-language-rights profile exists; no default voice/language substitution is permitted. |
| StreamSynthesize | EXPLICITLY_NOT_ADMITTED | Handler rejects before engine lookup/session creation; no streaming provider is admitted at this gRPC boundary. |
| GetStatus | EXPLICITLY_NOT_ADMITTED | The proto requires `active_sessions`, but the engine status contract has no session count; the route fails before engine lookup rather than serialize an unknown value as zero. Provider diagnostics are not exposed. |
| GetMetrics | EXPLICITLY_NOT_ADMITTED | Proto3 has no presence for required `real_time_factor` and `active_sessions`; engine `requestCount` is not a successful-synthesis count. The route fails before engine lookup rather than imply zero or map unlike metrics. |
| GetVoices | PROVIDER_DEPENDENT | Lists engine-reported voice metadata; availability is not rights or qualification. |
| LoadVoice | EXPLICITLY_NOT_ADMITTED | Rejects before engine lookup until an authoritative model, license, owner-rights and consent profile is admitted. |
| CreateProfile | EXPLICITLY_NOT_ADMITTED | UNIMPLEMENTED until tenant/principal ownership, consent, purpose and retention are backed by an authoritative scoped store. |
| GetProfile | EXPLICITLY_NOT_ADMITTED | UNIMPLEMENTED until authoritative profile ownership and retention checks exist. |
| UpdateProfile | EXPLICITLY_NOT_ADMITTED | UNIMPLEMENTED until authoritative profile ownership and retention checks exist. |
| CloneVoice | EXPLICITLY_NOT_ADMITTED | UNIMPLEMENTED pending owner consent, biometric purpose and retention verification. |
| SubmitFeedback | NOT_IMPLEMENTED | UNIMPLEMENTED; no persistence or learning provider is wired. |

The proto advertises `PCM_S16LE`, `PCM_F32LE`, `WAV`, and `MP3`, but the gRPC handler currently accepts only the unspecified/PCM-S16LE mapping; the other encodings are rejected pending verifiable provider output. Enum presence does not mean the format is produced. Production composition requires explicit `LOCAL_ONNX` configuration, a readable model and matching digest plus declared profile metadata, but remains `NOT_ADMITTED` because trusted license, voice rights, hardware and quality evidence are absent. No model download, readiness claim, or synthetic fallback qualifies that boundary.

The shared `TtsEngine` API supports synthesis, a callback streaming interface, voice listing/loading, profiles and cloning. API presence does not prove the configured implementation supports a qualified positive effect. `TtsSynthesisEngine` is a standalone compatibility engine with no model integration and rejects synthesis as `NOT_ADMITTED`; do not conflate it with the injected shared-engine provider path.

## 17 PDP-0 capability intents

| Capability | Current disposition | Boundary |
|---|---|---|
| `media.speech.synthesis.text-to-speech` | EXPLICITLY_NOT_ADMITTED | Synthesize rejects before engine lookup because no exact admitted voice-language-rights profile exists. |
| `media.speech.synthesis.streaming` | EXPLICITLY_NOT_ADMITTED | gRPC stream is denied before engine/session access. |
| `media.speech.synthesis.multilingual` | EXPLICITLY_NOT_ADMITTED | No exact voice-language-rights profile is admitted for a speech effect; GetVoices remains informational only. |
| `media.speech.synthesis.cross-lingual` | NOT_IMPLEMENTED | No translation-plus-synthesis operation is wired. |
| `media.speech.synthesis.expressive` | EXPLICITLY_NOT_ADMITTED | No qualified expressive effect is established. |
| `media.speech.synthesis.control.prosody` | EXPLICITLY_NOT_ADMITTED | SSML parsing/control validation is not audible provider-effect proof. |
| `media.speech.synthesis.control.rate` | EXPLICITLY_NOT_ADMITTED | Non-neutral rate requires provider effect qualification. |
| `media.speech.synthesis.control.pitch` | EXPLICITLY_NOT_ADMITTED | Non-neutral pitch requires provider effect qualification. |
| `media.speech.synthesis.control.emotion-style` | EXPLICITLY_NOT_ADMITTED | No qualified emotion/style effect is established. |
| `media.speech.synthesis.control.pronunciation` | EXPLICITLY_NOT_ADMITTED | No qualified pronunciation effect is established. |
| `media.speech.synthesis.control.phoneme` | EXPLICITLY_NOT_ADMITTED | No qualified phoneme effect is established. |
| `media.speech.synthesis.speaker.condition` | EXPLICITLY_NOT_ADMITTED | No qualified speaker-conditioning provider or rights decision is wired. |
| `media.speech.synthesis.speaker.clone-authorized` | EXPLICITLY_NOT_ADMITTED | Clone RPC denied pending consent, biometric purpose and retention authority. |
| `media.speech.synthesis.voice.convert` | NOT_IMPLEMENTED | No voice-conversion operation is wired. |
| `media.speech.synthesis.speech-to-speech` | NOT_IMPLEMENTED | No speech-to-speech operation is wired. |
| `media.speech.synthesis.speech.translate` | NOT_IMPLEMENTED | No speech-translation operation is wired. |
| `media.speech.synthesis.dub` | NOT_IMPLEMENTED | No dubbing operation is wired. |

`PROVIDER_DEPENDENT` indicates a delegation/read path whose real provider result and rights remain unqualified. `EXPLICITLY_NOT_ADMITTED` indicates an intentional fail-closed boundary. Neither is a positive provider qualification.

For TTS-10, requested `en`, `ne`, `hi`, region-tagged variants, and default-language requests all fail `NOT_ADMITTED` before engine lookup: this source cut has no exact admitted voice-language-rights profile. `PersistentTtsService`'s accepted language codes are input-validation bounds only. Engine voice listings cannot establish a qualification pair or rights decision; GetVoices is informational and does not make the multilingual speech effect provider-dependent. Cross-lingual, voice conversion, speech-to-speech, speech translation, and dubbing remain `NOT_IMPLEMENTED` because no corresponding RPC or provider path exists.

TTS-11 coverage keeps the wire RPC census at 11. The TTS proto has no application-level protocol-version field or negotiation RPC. `TtsGrpcServer` installs the shared JWT/RBAC/tenant context chain and production-like transport policy; package tests cover missing bearer credentials, persistent-service missing tenant/principal, and production TLS configuration failure. These transport tests do not qualify synthesis or rights.
