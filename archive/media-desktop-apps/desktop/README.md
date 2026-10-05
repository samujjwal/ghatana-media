# Audio-Video Desktop Application

A unified desktop application for all audio-video processing capabilities, combining Speech-to-Text, Text-to-Speech, AI Voice, Computer Vision, and Multimodal processing into a single, cohesive user experience.

## Features

### 🎤 Speech-to-Text (STT)

- Real-time audio transcription
- Multiple language support
- Configurable models and settings
- Audio visualization during recording

### 🔊 Text-to-Speech (TTS)

- Natural voice synthesis
- Multiple voice options
- Configurable speech parameters
- Audio playback controls

### 🤖 AI Voice Processing

- Text enhancement and improvement
- Language translation
- Content summarization
- Style transfer capabilities

### 👁️ Computer Vision

- Image object detection
- Image classification
- Visual content analysis
- Bounding box visualization

### 🔄 Multimodal Processing

- Combined audio-video-text analysis
- Cross-modal insights
- Comprehensive data processing
- Unified result presentation

## Architecture

### Shared Libraries

- **@ghatana/audio-video-product-types**: TypeScript type definitions
- **@ghatana/audio-video-product-client**: Unified service client
- **@ghatana/audio-video-product-ui**: Shared React components

### Desktop Application

- **Frontend**: React 19 + TypeScript + Tailwind CSS
- **Backend**: Tauri 2 + Rust
- **State Management**: Zustand
- **Build Tool**: Vite

### Service Integration

- gRPC communication with backend services
- Configurable endpoints and timeouts
- Health monitoring and status tracking
- Error handling and retry logic

## Development

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Tauri CLI
- Docker (for backend services)

### Setup

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build application
pnpm build

# Run Tauri application
pnpm tauri dev
```

### Configuration

Environment variables are configured through:

- `.env` files for development
- Tauri configuration for production
- Runtime settings panel

## Project Structure

```
apps/desktop/
├── src/
│   ├── components/          # React components
│   ├── hooks/               # Custom hooks
│   ├── services/            # Service integration
│   ├── types/               # TypeScript types
│   └── utils/               # Utility functions
├── src-tauri/               # Tauri backend
│   ├── src/                 # Rust source code
│   ├── Cargo.toml           # Rust dependencies
│   └── tauri.conf.json      # Tauri configuration
└── package.json             # Node.js dependencies
```

## Usage

### Starting the Application

1. Launch the desktop application
2. Navigate between service tabs
3. Configure settings as needed
4. Process content using available services

### Service Workflows

1. **STT**: Record audio → Get transcription
2. **TTS**: Enter text → Generate speech
3. **AI Voice**: Input text → Process with AI
4. **Vision**: Upload image → Analyze content
5. **Multimodal**: Combine inputs → Get insights

## Configuration

### Service Endpoints

- STT: `http://localhost:50051`
- TTS: `http://localhost:50052`
- AI Voice: `http://localhost:50053`
- Vision: `http://localhost:50054`
- Multimodal: `http://localhost:50055`

### Settings

- Theme: Light/Dark/Auto
- Language: Multiple options
- Performance: GPU acceleration, caching
- Accessibility: High contrast, reduced motion

## Building and Deployment

### Development Build

```bash
pnpm tauri dev
```

### Production Build

```bash
pnpm build
pnpm tauri build
```

### Distribution

- Windows: `.exe` installer
- macOS: `.dmg` package
- Linux: `.deb`/`.rpm` packages

## Troubleshooting

### Common Issues

1. **Service Connection**: Ensure backend services are running
2. **Audio Permissions**: Grant microphone access for STT
3. **File Access**: Grant file system access for uploads
4. **Performance**: Adjust settings for hardware capabilities

### Debug Mode

Enable debug mode for detailed logging:

```bash
TAURI_DEBUG=true pnpm tauri dev
```

## Contributing

1. Follow the established code patterns
2. Use TypeScript for all new code
3. Add comprehensive tests
4. Update documentation
5. Submit pull requests

## License

MIT License - see LICENSE file for details.
