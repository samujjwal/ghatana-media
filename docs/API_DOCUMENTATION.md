# Audio-Video Platform API Documentation

**Version:** 1.0.0  
**Last Updated:** March 30, 2026  
**Base URL:** `https://api.audio-video.ghatana.com` (Production)  
**Base URL:** `http://localhost:8000` (Development)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Streaming API](#streaming-api)
4. [Transcription API](#transcription-api)
5. [Recording API](#recording-api)
6. [WebSocket Events](#websocket-events)
7. [Error Codes](#error-codes)
8. [Rate Limits](#rate-limits)
9. [Code Examples](#code-examples)

---

## Overview

The Audio-Video Platform provides real-time media processing capabilities including:
- **Live Streaming**: RTMP/WebRTC streaming with adaptive bitrate
- **Transcription**: Real-time speech-to-text with multiple language support
- **Recording**: Cloud recording with automatic archival
- **AI Processing**: Content analysis, speaker diarization, sentiment analysis

### Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   Client    │─────▶│  API Gateway │─────▶│   Stream    │
│ (RTMP/WebRTC)│      │   (REST)     │      │   Service   │
└─────────────┘      └──────────────┘      └─────────────┘
                            │                      │
                            ▼                      ▼
                     ┌──────────────┐      ┌─────────────┐
                     │ Transcription│      │  Recording  │
                     │   Service    │      │   Service   │
                     └──────────────┘      └─────────────┘
```

---

## Authentication

All API requests require authentication using Bearer tokens.

### Request Headers

```http
Authorization: Bearer <your_access_token>
Content-Type: application/json
```

### Obtaining Access Token

```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your_password"
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "refresh_token_here",
  "expiresIn": 3600
}
```

---

## Streaming API

### Start Stream

Create a new live stream session.

**Endpoint:** `POST /api/v1/streams`

**Request:**
```json
{
  "title": "My Live Stream",
  "description": "Stream description",
  "settings": {
    "video": {
      "codec": "h264",
      "bitrate": 2500,
      "resolution": "1920x1080",
      "fps": 30
    },
    "audio": {
      "codec": "opus",
      "bitrate": 128,
      "sampleRate": 48000
    },
    "privacy": "public"
  }
}
```

**Response:** `201 Created`
```json
{
  "streamId": "stream_abc123",
  "rtmpUrl": "rtmp://live.audio-video.ghatana.com/live",
  "streamKey": "sk_xyz789",
  "webrtcUrl": "wss://webrtc.audio-video.ghatana.com/stream_abc123",
  "playbackUrl": "https://cdn.audio-video.ghatana.com/stream_abc123/index.m3u8",
  "createdAt": "2026-03-30T19:00:00Z"
}
```

### Get Stream Status

Get current status and metrics for a stream.

**Endpoint:** `GET /api/v1/streams/{streamId}`

**Response:** `200 OK`
```json
{
  "streamId": "stream_abc123",
  "status": "live",
  "title": "My Live Stream",
  "startedAt": "2026-03-30T19:00:00Z",
  "duration": 3600,
  "viewers": {
    "current": 42,
    "peak": 87,
    "total": 156
  },
  "quality": {
    "bitrate": 2480,
    "fps": 30,
    "resolution": "1920x1080",
    "droppedFrames": 12,
    "health": "excellent"
  },
  "bandwidth": {
    "inbound": 2.5,
    "outbound": 105.0
  }
}
```

### Update Stream Settings

Update stream configuration while live.

**Endpoint:** `PATCH /api/v1/streams/{streamId}`

**Request:**
```json
{
  "title": "Updated Stream Title",
  "settings": {
    "video": {
      "bitrate": 3000
    }
  }
}
```

**Response:** `200 OK`
```json
{
  "streamId": "stream_abc123",
  "updated": true,
  "appliedAt": "2026-03-30T19:30:00Z"
}
```

### Stop Stream

End a live stream session.

**Endpoint:** `POST /api/v1/streams/{streamId}/stop`

**Response:** `200 OK`
```json
{
  "streamId": "stream_abc123",
  "status": "ended",
  "endedAt": "2026-03-30T20:00:00Z",
  "duration": 3600,
  "recordingUrl": "https://cdn.audio-video.ghatana.com/recordings/stream_abc123.mp4"
}
```

### List Streams

Get list of streams with filtering and pagination.

**Endpoint:** `GET /api/v1/streams`

**Query Parameters:**
- `status` - Filter by status: `live`, `ended`, `scheduled`
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20, max: 100)
- `sortBy` - Sort field: `createdAt`, `viewers`, `duration`
- `order` - Sort order: `asc`, `desc`

**Response:** `200 OK`
```json
{
  "streams": [
    {
      "streamId": "stream_abc123",
      "title": "My Live Stream",
      "status": "live",
      "viewers": 42,
      "startedAt": "2026-03-30T19:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 156,
    "pages": 8
  }
}
```

---

## Transcription API

### Start Transcription

Enable real-time transcription for a stream.

**Endpoint:** `POST /api/v1/transcription/start`

**Request:**
```json
{
  "streamId": "stream_abc123",
  "language": "en-US",
  "options": {
    "realtime": true,
    "punctuation": true,
    "profanityFilter": false,
    "speakerDiarization": true,
    "maxSpeakers": 4
  }
}
```

**Response:** `200 OK`
```json
{
  "transcriptionId": "trans_xyz789",
  "streamId": "stream_abc123",
  "websocketUrl": "wss://transcription.audio-video.ghatana.com/trans_xyz789",
  "status": "active",
  "startedAt": "2026-03-30T19:00:00Z"
}
```

### Get Transcript

Retrieve completed transcript.

**Endpoint:** `GET /api/v1/transcription/{transcriptionId}`

**Response:** `200 OK`
```json
{
  "transcriptionId": "trans_xyz789",
  "streamId": "stream_abc123",
  "language": "en-US",
  "duration": 3600,
  "segments": [
    {
      "id": "seg_001",
      "speaker": "Speaker 1",
      "text": "Welcome to the stream!",
      "startTime": 0.0,
      "endTime": 2.5,
      "confidence": 0.98
    },
    {
      "id": "seg_002",
      "speaker": "Speaker 2",
      "text": "Thanks for having me.",
      "startTime": 3.0,
      "endTime": 5.2,
      "confidence": 0.95
    }
  ],
  "summary": {
    "totalWords": 1247,
    "speakers": 2,
    "topics": ["technology", "innovation"],
    "sentiment": "positive"
  }
}
```

### Export Transcript

Export transcript in various formats.

**Endpoint:** `GET /api/v1/transcription/{transcriptionId}/export`

**Query Parameters:**
- `format` - Export format: `txt`, `srt`, `vtt`, `json`

**Response:** `200 OK`
```
Content-Type: text/plain (for txt)
Content-Type: application/x-subrip (for srt)
Content-Type: text/vtt (for vtt)
Content-Type: application/json (for json)

[Formatted transcript content]
```

---

## Recording API

### Start Recording

Begin recording a stream.

**Endpoint:** `POST /api/v1/recordings/start`

**Request:**
```json
{
  "streamId": "stream_abc123",
  "format": "mp4",
  "quality": "1080p",
  "options": {
    "includeChat": true,
    "includeTranscript": true
  }
}
```

**Response:** `200 OK`
```json
{
  "recordingId": "rec_def456",
  "streamId": "stream_abc123",
  "status": "recording",
  "startedAt": "2026-03-30T19:00:00Z"
}
```

### Stop Recording

End recording and process the file.

**Endpoint:** `POST /api/v1/recordings/{recordingId}/stop`

**Response:** `200 OK`
```json
{
  "recordingId": "rec_def456",
  "status": "processing",
  "stoppedAt": "2026-03-30T20:00:00Z",
  "duration": 3600,
  "estimatedProcessingTime": 300
}
```

### Get Recording

Retrieve recording details and download URL.

**Endpoint:** `GET /api/v1/recordings/{recordingId}`

**Response:** `200 OK`
```json
{
  "recordingId": "rec_def456",
  "streamId": "stream_abc123",
  "status": "ready",
  "duration": 3600,
  "fileSize": 1073741824,
  "format": "mp4",
  "quality": "1080p",
  "downloadUrl": "https://cdn.audio-video.ghatana.com/recordings/rec_def456.mp4",
  "thumbnailUrl": "https://cdn.audio-video.ghatana.com/recordings/rec_def456_thumb.jpg",
  "expiresAt": "2026-04-30T00:00:00Z",
  "createdAt": "2026-03-30T19:00:00Z",
  "processedAt": "2026-03-30T20:05:00Z"
}
```

---

## WebSocket Events

### Real-time Captions

Connect to transcription WebSocket for live captions.

**URL:** `wss://transcription.audio-video.ghatana.com/trans_xyz789`

**Events:**

```javascript
// Connection
ws.on('open', () => {
  console.log('Connected to transcription service');
});

// Caption event
ws.on('caption', (data) => {
  console.log(data);
  // {
  //   "id": "cap_001",
  //   "text": "Hello world",
  //   "speaker": "Speaker 1",
  //   "timestamp": 1234567890,
  //   "confidence": 0.95,
  //   "isFinal": true
  // }
});

// Error event
ws.on('error', (error) => {
  console.error('Transcription error:', error);
});
```

### Stream Metrics

Real-time stream quality metrics.

**URL:** `wss://metrics.audio-video.ghatana.com/stream_abc123`

**Events:**

```javascript
ws.on('metrics', (data) => {
  console.log(data);
  // {
  //   "timestamp": 1234567890,
  //   "bitrate": 2480,
  //   "fps": 30,
  //   "droppedFrames": 2,
  //   "viewers": 42,
  //   "bandwidth": 2.5
  // }
});
```

---

## Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| `400` | Bad Request | Check request parameters |
| `401` | Unauthorized | Provide valid authentication token |
| `403` | Forbidden | Insufficient permissions |
| `404` | Not Found | Resource does not exist |
| `409` | Conflict | Resource already exists or state conflict |
| `422` | Unprocessable Entity | Validation error |
| `429` | Too Many Requests | Rate limit exceeded, retry after delay |
| `500` | Internal Server Error | Server error, contact support |
| `503` | Service Unavailable | Service temporarily unavailable |

### Error Response Format

```json
{
  "error": {
    "code": "STREAM_NOT_FOUND",
    "message": "Stream with ID 'stream_abc123' not found",
    "details": {
      "streamId": "stream_abc123"
    },
    "timestamp": "2026-03-30T19:00:00Z",
    "requestId": "req_xyz789"
  }
}
```

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Stream Creation | 10 requests | 1 hour |
| Stream Status | 100 requests | 1 minute |
| Transcription Start | 5 requests | 1 minute |
| General API | 1000 requests | 1 hour |

**Rate Limit Headers:**
```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1711825200
```

---

## Code Examples

### JavaScript/TypeScript

```typescript
import axios from 'axios';

const API_BASE_URL = 'https://api.audio-video.ghatana.com';
const ACCESS_TOKEN = 'your_access_token';

// Create stream
async function createStream() {
  const response = await axios.post(
    `${API_BASE_URL}/api/v1/streams`,
    {
      title: 'My Live Stream',
      settings: {
        video: { codec: 'h264', bitrate: 2500 },
        audio: { codec: 'opus', bitrate: 128 }
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data;
}

// Start transcription
async function startTranscription(streamId: string) {
  const response = await axios.post(
    `${API_BASE_URL}/api/v1/transcription/start`,
    {
      streamId,
      language: 'en-US',
      options: { realtime: true, speakerDiarization: true }
    },
    {
      headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
    }
  );
  
  return response.data;
}

// Connect to transcription WebSocket
function connectTranscription(websocketUrl: string) {
  const ws = new WebSocket(websocketUrl);
  
  ws.onopen = () => console.log('Connected');
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'caption') {
      console.log(`[${data.speaker}]: ${data.text}`);
    }
  };
  
  return ws;
}
```

### Python

```python
import requests
import websocket

API_BASE_URL = 'https://api.audio-video.ghatana.com'
ACCESS_TOKEN = 'your_access_token'

# Create stream
def create_stream():
    response = requests.post(
        f'{API_BASE_URL}/api/v1/streams',
        json={
            'title': 'My Live Stream',
            'settings': {
                'video': {'codec': 'h264', 'bitrate': 2500},
                'audio': {'codec': 'opus', 'bitrate': 128}
            }
        },
        headers={'Authorization': f'Bearer {ACCESS_TOKEN}'}
    )
    return response.json()

# Get stream status
def get_stream_status(stream_id):
    response = requests.get(
        f'{API_BASE_URL}/api/v1/streams/{stream_id}',
        headers={'Authorization': f'Bearer {ACCESS_TOKEN}'}
    )
    return response.json()

# WebSocket connection
def on_message(ws, message):
    import json
    data = json.loads(message)
    print(f"[{data['speaker']}]: {data['text']}")

def connect_transcription(websocket_url):
    ws = websocket.WebSocketApp(
        websocket_url,
        on_message=on_message
    )
    ws.run_forever()
```

### cURL

```bash
# Create stream
curl -X POST https://api.audio-video.ghatana.com/api/v1/streams \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Live Stream",
    "settings": {
      "video": {"codec": "h264", "bitrate": 2500},
      "audio": {"codec": "opus", "bitrate": 128}
    }
  }'

# Get stream status
curl -X GET https://api.audio-video.ghatana.com/api/v1/streams/stream_abc123 \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Start transcription
curl -X POST https://api.audio-video.ghatana.com/api/v1/transcription/start \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "streamId": "stream_abc123",
    "language": "en-US",
    "options": {"realtime": true}
  }'
```

---

## Multimodal Service API (gRPC)

**Package:** `com.ghatana.audio.video.multimodal.grpc`  
**Proto:** `multimodal_service.proto`  
**Service:** `MultimodalService`  
**Port:** 50055 (configurable via `MULTIMODAL_GRPC_PORT`)

All RPCs require the following metadata headers:
- `x-tenant-id`: Tenant identifier (required)
- `authorization`: Bearer JWT token (required)
- `x-correlation-id`: Correlation ID for tracing (optional, generated if absent)

### RPC Methods

#### `ProcessMultimodal`
Combined audio-visual analysis.

**Request:** `MultimodalRequest`
```
audio_data   bytes          - Raw audio bytes (WAV/MP3)
image_data   bytes          - Raw image bytes (JPEG/PNG)
video_data   bytes          - Raw video bytes (MP4)
text         string         - Contextual text
analysis_types []string     - e.g. ["combined", "sentiment"]
```

**Response:** `MultimodalResponse`
```
combined_analysis  string        - Combined narrative result
audio_analysis     AudioAnalysis - Transcription, sentiment, sounds
visual_analysis    VisualAnalysis - Scene description, objects, activities
processing_time_ms int64         - End-to-end latency in ms
```

#### `AnalyzeCrossModal`
Alignment analysis between audio and visual streams.

**Request:** `CrossModalRequest` — `audio_data`, `video_data`, `analysis_window_ms`  
**Response:** `CrossModalResponse` — `alignment_score` [0,1], `events[]`, `summary`

#### `GetInsights`
Aggregated insight extraction.

**Request:** `InsightsRequest` — `audio_data`, `video_data`, `image_data`, `text`, `insight_types`  
**Response:** `InsightsResponse` — `overall_sentiment`, `topics[]`, `entities[]`, `actions[]`, `confidence_scores`

#### `HealthCheck`
**Request:** `HealthCheckRequest` (empty)  
**Response:** `HealthCheckResponse` — `healthy: bool`, `message: string`

### Auth failure responses

| Scenario | gRPC Status |
|---|---|
| Missing auth header | `UNAUTHENTICATED` |
| Invalid/expired token | `UNAUTHENTICATED` |
| Valid token, wrong tenant scope | `PERMISSION_DENIED` |
| Rate limit exceeded | `RESOURCE_EXHAUSTED` |

---

## Support

- **Documentation:** https://docs.audio-video.ghatana.com
- **API Status:** https://status.audio-video.ghatana.com
- **Support Email:** support@ghatana.com
- **Discord:** https://discord.gg/ghatana

---

**Last Updated:** March 30, 2026  
**API Version:** 1.0.0
