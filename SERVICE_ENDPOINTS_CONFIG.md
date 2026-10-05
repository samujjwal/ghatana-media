# Audio-Video Service Endpoints Configuration

## Overview

The Audio-Video Desktop application uses environment variables to configure service endpoints instead of hardcoded localhost values. This allows for production deployment without code changes.

## Environment Variables

The following environment variables can be set to configure service endpoints:

| Environment Variable | Service | Default Value | Description |
|---------------------|---------|---------------|-------------|
| `VITE_AV_STT_ENDPOINT` | Speech-to-Text (STT) | `http://localhost:50051` | Endpoint for STT service |
| `VITE_AV_TTS_ENDPOINT` | Text-to-Speech (TTS) | `http://localhost:50052` | Endpoint for TTS service |
| `VITE_AV_AI_VOICE_ENDPOINT` | AI Voice | `http://localhost:50053` | Endpoint for AI Voice service |
| `VITE_AV_VISION_ENDPOINT` | Vision | `http://localhost:50054` | Endpoint for Vision service |
| `VITE_AV_MULTIMODAL_ENDPOINT` | Multimodal | `http://localhost:50055` | Endpoint for Multimodal service |

## Configuration Methods

### 1. Environment Variables (Recommended)

Set environment variables before building or running the application:

```bash
# Development
VITE_AV_STT_ENDPOINT=http://production-stt.example.com:50051 \
VITE_AV_TTS_ENDPOINT=http://production-tts.example.com:50052 \
VITE_AV_AI_VOICE_ENDPOINT=http://production-ai-voice.example.com:50053 \
VITE_AV_VISION_ENDPOINT=http://production-vision.example.com:50054 \
VITE_AV_MULTIMODAL_ENDPOINT=http://production-multimodal.example.com:50055 \
pnpm dev
```

### 2. Build-Time Configuration

For production builds, set the environment variables during the build process:

```bash
VITE_AV_STT_ENDPOINT=https://api.example.com/stt \
VITE_AV_TTS_ENDPOINT=https://api.example.com/tts \
pnpm build
```

### 3. Runtime Configuration (Tauri)

For Tauri desktop applications, you can set environment variables in the system environment before launching the app, or use Tauri's config store to persist settings.

## Default Behavior

If no environment variables are set, the application falls back to `localhost` endpoints for development:

- STT: `http://localhost:50051`
- TTS: `http://localhost:50052`
- AI Voice: `http://localhost:50053`
- Vision: `http://localhost:50054`
- Multimodal: `http://localhost:50055`

## Service Configuration Structure

Each service has the following configurable properties:

```typescript
{
  enabled: boolean;           // Whether the service is enabled
  endpoint: string;           // Service endpoint URL
  timeout: number;           // Request timeout in milliseconds (default: 30000)
  retries: number;            // Number of retry attempts (default: 3)
  customSettings: Record<string, unknown>; // Service-specific settings
}
```

## Updating Configuration at Runtime

The application provides a settings store that allows runtime configuration updates:

```typescript
import { useAudioVideoStore } from './hooks/useAudioVideoStore';

function SettingsComponent() {
  const { settings, updateSettings } = useAudioVideoStore();
  
  const updateEndpoint = (service: string, newEndpoint: string) => {
    updateSettings({
      services: {
        ...settings.services,
        [service]: {
          ...settings.services[service],
          endpoint: newEndpoint
        }
      }
    });
  };
  
  return (
    <input
      value={settings.services.stt.endpoint}
      onChange={(e) => updateEndpoint('stt', e.target.value)}
    />
  );
}
```

## Tauri Config Store Integration

The application can be extended to use Tauri's config store for persistent configuration:

```typescript
import { readConfigFile, writeConfigFile } from '@tauri-apps/plugin-config';

// Load configuration
const config = await readConfigFile('audio-video-config.json');

// Save configuration
await writeConfigFile('audio-video-config.json', {
  services: {
    stt: { endpoint: 'https://api.example.com/stt' }
  }
});
```

## Security Considerations

- **HTTPS in Production**: Always use HTTPS endpoints for production deployments
- **Authentication**: If services require authentication, configure API keys or tokens securely
- **Network Security**: Ensure firewalls and network policies allow access to service endpoints
- **Environment Variables**: Do not commit environment variables with sensitive data to version control

## Troubleshooting

### Service Unreachable

If a service endpoint is unreachable:

1. Verify the endpoint URL is correct
2. Check network connectivity
3. Ensure the service is running and accessible
4. Check firewall settings

### Configuration Not Loading

If environment variables are not being loaded:

1. Verify the variable name matches the expected format (`VITE_AV_*_ENDPOINT`)
2. Restart the application after setting environment variables
3. Check that the build process includes the environment variables

### Default Fallback

If you see `localhost` endpoints in production:

1. Verify environment variables are set before building
2. Check that the build process includes the environment variables
3. Ensure the application is using the production build, not development mode

## Migration Guide

### Before (Hardcoded Localhost)

```typescript
const defaultSettings = {
  services: {
    stt: {
      endpoint: 'http://localhost:50051', // Hardcoded
      // ...
    }
  }
};
```

### After (Environment Variables)

```typescript
function getServiceEndpoint(serviceName: string, defaultPort: number): string {
  const envVarName = `AV_${serviceName.toUpperCase().replace('-', '_')}_ENDPOINT`;
  return import.meta.env[`VITE_${envVarName}`] || `http://localhost:${defaultPort}`;
}

const defaultSettings = {
  services: {
    stt: {
      endpoint: getServiceEndpoint('stt', 50051), // Configurable
      // ...
    }
  }
};
```

## Future Enhancements

- [ ] Add Tauri config store integration for persistent settings
- [ ] Add settings UI in the application for endpoint configuration
- [ ] Add endpoint health checks
- [ ] Add support for multiple environment profiles (dev, staging, prod)
- [ ] Add endpoint validation and testing UI
