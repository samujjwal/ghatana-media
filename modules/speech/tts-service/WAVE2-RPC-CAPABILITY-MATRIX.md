# TTS Wave 2 W0 disposition inventory

This package-local inventory is a non-authoritative projection of the current gRPC boundary and the 17 registered PDP-0 capability intents. The source of truth remains `tts_service.proto` and `.product-experience/pdp-0-product-truth/capabilities.yaml`. The inventory does not qualify a provider or assert voice rights, model quality, or release status.

## 11 gRPC RPCs

| RPC | Current disposition | Boundary |
|---|---|---|
| Synthesize | PROVIDER_DEPENDENT | Delegates to the injected shared `TtsEngine`; real model/license/voice rights and decoded speech quality are not qualified. The standalone `TtsSynthesisEngine` fails `NOT_ADMITTED`. |
| StreamSynthesize | EXPLICITLY_NOT_ADMITTED | Handler rejects before engine lookup/session creation; no streaming provider is admitted at this gRPC boundary. |
| GetStatus | IMPLEMENTED | Projects shared engine status; response does not establish model readiness or quality. |
| GetMetrics | IMPLEMENTED | Projects shared engine counters/latency/memory observations. |
| GetVoices | PROVIDER_DEPENDENT | Lists engine-reported voice metadata; availability is not rights or qualification. |
| LoadVoice | PROVIDER_DEPENDENT | Delegates to engine; no model/voice profile or rights admission is established here. |
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
| `media.speech.synthesis.text-to-speech` | PROVIDER_DEPENDENT | Shared engine dispatch exists; admitted real speech output is unqualified. |
| `media.speech.synthesis.streaming` | EXPLICITLY_NOT_ADMITTED | gRPC stream is denied before engine/session access. |
| `media.speech.synthesis.multilingual` | PROVIDER_DEPENDENT | Language-filtered voice listing exists; language coverage/output need provider evidence. |
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
