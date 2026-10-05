# Audio-Video Integration Tests

This directory contains integration tests for the audio-video product suite, testing end-to-end workflows and service interactions.

## Test Structure

```
integration-tests/
├── src/test/java/com/ghatana/audio/video/integration/
│   ├── AudioVideoIntegrationTest.java     # Basic service integration
│   └── FullWorkflowIntegrationTest.java    # Complete workflow testing
└── README.md
```

## Test Coverage

### AudioVideoIntegrationTest

- Service health and readiness
- Network communication between services
- Environment configuration validation
- Concurrent request handling
- Health maintenance under load

### FullWorkflowIntegrationTest

- Complete STT workflow (audio → text)
- Complete TTS workflow (text → audio)
- Bidirectional workflow testing
- Network communication verification
- Load testing with concurrent access

## Running Tests

### Prerequisites

- Docker and Docker Compose installed
- Testcontainers configuration
- Sufficient memory for container orchestration

### Environment Variables

```bash
# Service images (optional, defaults shown)
STT_IMAGE=ghatana/stt-service:latest
TTS_IMAGE=ghatana/tts-service:latest

# Test configuration
TEST_TIMEOUT=180
CONCURRENT_REQUESTS=10
```

### Running Tests

```bash
# Run all integration tests
./gradlew integrationTest

# Run specific test class
./gradlew integrationTest --tests "*AudioVideoIntegrationTest"

# Run with custom configuration
STT_IMAGE=custom-stt:latest ./gradlew integrationTest
```

## Test Configuration

### Testcontainers Setup

- Uses Docker containers for real service testing
- Network isolation for service communication
- Health check validation
- Automatic cleanup

### Service Configuration

- STT Service: Port 50051 (gRPC), 8080 (HTTP)
- TTS Service: Port 50052 (gRPC), 8080 (HTTP)
- Shared network for inter-service communication
- Configurable models and voices

## Test Data

### Audio Data

- Simplified test audio generation
- WAV format compatibility
- Configurable sample rates

### Text Data

- Multi-language support
- Variable length texts
- Special character handling

## Expected Outcomes

### Success Criteria

- All services start and become healthy
- Services can communicate over network
- Basic STT/TTS operations complete
- Services handle concurrent requests
- Health maintained under load

### Failure Handling

- Graceful degradation for missing services
- Proper error logging and reporting
- Container cleanup on failure
- Timeout handling for long-running operations

## Integration with CI/CD

### GitLab CI Integration

```yaml
integration-test:
  stage: test
  image: openjdk:21-jdk
  services:
    - docker:dind
  script:
    - ./gradlew integrationTest
  artifacts:
    reports:
      junit: "integration-tests/build/test-results/integrationTest/TEST-*.xml"
  tags:
    - docker
```

### Local Development

- Use Docker Compose for local testing
- Configure service images appropriately
- Monitor container logs for debugging

## Troubleshooting

### Common Issues

1. **Container Startup Timeout**: Increase `TEST_TIMEOUT`
2. **Network Communication**: Verify network alias configuration
3. **Memory Constraints**: Allocate sufficient Docker memory
4. **Port Conflicts**: Ensure ports are available

### Debugging

- Check container logs: `docker logs <container-id>`
- Verify network connectivity: `docker network inspect`
- Monitor resource usage: `docker stats`

## Future Enhancements

### Additional Test Scenarios

- Real audio file processing
- Multi-language support testing
- Performance benchmarking
- Chaos engineering tests
- Security integration testing

### Test Data Management

- External test data sets
- Automated audio generation
- Speech synthesis validation
- Accuracy measurement

### Monitoring Integration

- Metrics collection during tests
- Performance baseline tracking
- Alert integration for test failures
