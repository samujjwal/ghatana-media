# Owner: Audio-Video

**Team:** Media Platform Team  
**Slack:** #platform-audio-video  
**On-call:** Media Platform on-call rotation  
**Architecture lead:** Media Platform Tech Lead  
**Boundary audit score:** 8/10 (2026-03-21) — reference implementation  

## Responsibility

The Audio-Video product provides **media streaming and processing capabilities**:

- Real-time audio/video streaming
- Media transcoding and format conversion
- Live session management
- Recording and playback

**Domain boundary:** Audio-Video owns all media domain logic. It uses Data-Cloud for event streaming and platform observability for health monitoring.

## Best Practice Note

Audio-Video is one of two **reference implementations** for product boundary hygiene (alongside Finance). Clean domain separation, clear ownership, no platform leakage.
