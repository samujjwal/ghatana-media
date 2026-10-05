#!/bin/bash
# Stop all Audio-Video backend services

echo "Stopping Audio-Video Backend Services..."

# Function to stop a service
stop_service() {
    local pid_file=$1
    local name=$2
    
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping $name (PID: $pid)..."
            kill "$pid"
            rm "$pid_file"
        else
            echo "$name is not running"
            rm "$pid_file"
        fi
    else
        echo "$name is not running"
    fi
}

# Stop services
stop_service "/tmp/stt-service.pid" "STT Service"
stop_service "/tmp/tts-service.pid" "TTS Service"
stop_service "/tmp/ai-voice-service.pid" "AI Voice Service"
stop_service "/tmp/vision-service.pid" "Vision Service"
stop_service "/tmp/multimodal-service.pid" "Multimodal Service"

echo ""
echo "All services stopped."
