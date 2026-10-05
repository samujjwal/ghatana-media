#!/bin/bash
# Start all Audio-Video backend services

set -e

echo "Starting Audio-Video Backend Services..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a service is already running
check_service() {
    local port=$1
    local name=$2
    if nc -z localhost $port 2>/dev/null; then
        echo -e "${YELLOW}$name is already running on port $port${NC}"
        return 0
    fi
    return 1
}

# Function to wait for a service to be ready
wait_for_service() {
    local port=$1
    local name=$2
    local timeout=30
    local count=0
    
    echo "Waiting for $name to be ready..."
    while ! nc -z localhost $port 2>/dev/null; do
        sleep 1
        count=$((count + 1))
        if [ $count -ge $timeout ]; then
            echo -e "${RED}Timeout waiting for $name${NC}"
            return 1
        fi
    done
    echo -e "${GREEN}$name is ready on port $port${NC}"
    return 0
}

# Build Java services if needed
echo "Building Java services..."
cd "$PROJECT_ROOT"
./gradlew :modules:speech:stt-service:build :modules:speech:tts-service:build :modules:vision:vision-service:build :modules:intelligence:multimodal-service:build -q

# Start STT Service
if ! check_service 50051 "STT Service"; then
    echo -e "${GREEN}Starting STT Service on port 50051...${NC}"
    STT_GRPC_PORT=50051 \
    java -jar "$PROJECT_ROOT/modules/speech/stt-service/build/libs/stt-service.jar" &
    STT_PID=$!
    echo $STT_PID > /tmp/stt-service.pid
    wait_for_service 50051 "STT Service"
fi

# Start TTS Service
if ! check_service 50052 "TTS Service"; then
    echo -e "${GREEN}Starting TTS Service on port 50052...${NC}"
    TTS_GRPC_PORT=50052 \
    java -jar "$PROJECT_ROOT/modules/speech/tts-service/build/libs/tts-service.jar" &
    TTS_PID=$!
    echo $TTS_PID > /tmp/tts-service.pid
    wait_for_service 50052 "TTS Service"
fi

# Start AI Voice Service (Python)
if ! check_service 50053 "AI Voice Service"; then
    echo -e "${GREEN}Starting AI Voice Service on port 50053...${NC}"
    cd "$PROJECT_ROOT/modules/intelligence/ai-voice"
    python grpc_server.py &
    AI_VOICE_PID=$!
    echo $AI_VOICE_PID > /tmp/ai-voice-service.pid
    wait_for_service 50053 "AI Voice Service"
fi

# Start Vision Service
if ! check_service 50054 "Vision Service"; then
    echo -e "${GREEN}Starting Vision Service on port 50054...${NC}"
    VISION_GRPC_PORT=50054 \
    java -jar "$PROJECT_ROOT/modules/vision/vision-service/build/libs/vision-service.jar" &
    VISION_PID=$!
    echo $VISION_PID > /tmp/vision-service.pid
    wait_for_service 50054 "Vision Service"
fi

# Start Multimodal Service
if ! check_service 50055 "Multimodal Service"; then
    echo -e "${GREEN}Starting Multimodal Service on port 50055...${NC}"
    MULTIMODAL_GRPC_PORT=50055 \
    java -jar "$PROJECT_ROOT/modules/intelligence/multimodal-service/build/libs/multimodal-service.jar" &
    MULTIMODAL_PID=$!
    echo $MULTIMODAL_PID > /tmp/multimodal-service.pid
    wait_for_service 50055 "Multimodal Service"
fi

echo ""
echo -e "${GREEN}All services started successfully!${NC}"
echo ""
echo "Services:"
echo "  - STT:        http://localhost:50051"
echo "  - TTS:        http://localhost:50052"
echo "  - AI Voice:   http://localhost:50053"
echo "  - Vision:     http://localhost:50054"
echo "  - Multimodal: http://localhost:50055"
echo ""
echo "Use ./stop-services.sh to stop all services"
