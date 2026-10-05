# AI Voice Deployment Guide

**Version:** 1.0.0
**Last Updated:** Implementation Complete
**Status:** Experimental / Internal Preview

---

## 📋 Overview

Complete guide for deploying AI Voice features (D3-D6) to production environments.

---

## 🎯 Deployment Checklist

### Pre-Deployment

- [ ] All code reviewed and approved
- [ ] All tests passing (90+ tests)
- [ ] Documentation complete
- [ ] Security audit passed
- [ ] Performance benchmarks met
- [ ] Staging environment tested
- [ ] Rollback plan prepared
- [ ] Monitoring configured
- [ ] Team trained

### Deployment

- [ ] Deploy to staging
- [ ] Run smoke tests
- [ ] Deploy to production
- [ ] Verify health checks
- [ ] Monitor metrics
- [ ] Enable features gradually

### Post-Deployment

- [ ] Monitor for 48 hours
- [ ] Gather user feedback
- [ ] Review error logs
- [ ] Performance analysis
- [ ] Documentation updates

---

## 🏗️ Infrastructure Requirements

### Server Requirements

**Python Service:**
- CPU: 8+ cores (16+ recommended)
- RAM: 16GB minimum (32GB+ recommended)
- GPU: NVIDIA GPU with 8GB+ VRAM (optional but recommended)
- Storage: 100GB+ SSD
- OS: Ubuntu 20.04+ or similar

**Rust Bridge:**
- Included in Tauri app
- No separate deployment needed

**Frontend (React):**
- Node.js 18+
- Served via Tauri or web server
- CDN for static assets (optional)

### Dependencies

**System Packages:**
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
    python3.11 \
    python3-pip \
    build-essential \
    libsndfile1 \
    ffmpeg \
    git

# macOS
brew install python@3.11 libsndfile ffmpeg
```

**Python Dependencies:**
```bash
pip install -r requirements.txt
# Contents:
# torch>=2.0.0
# torchaudio>=2.0.0
# numpy>=1.24.0
# librosa>=0.10.0
# soundfile>=0.12.0
# scipy>=1.10.0
# demucs>=4.0.0
# pytest>=7.4.0 (dev)
# psutil>=5.9.0 (testing)
```

**Node Dependencies:**
```bash
cd apps/desktop
pnpm install
```

---

## 🚀 Deployment Steps

### 1. Prepare Environment

```bash
# Clone repository
git clone <repo-url>
cd ghatana/products/shared-services/ai-voice

# Create virtual environment
python3.11 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r apps/desktop/src-tauri/python/requirements.txt
```

### 2. Configure Environment

```bash
# .env file
cat > .env << EOF
# Python
PYTHONPATH=./apps/desktop/src-tauri/python
PYTHON_ENV=production

# Models
DEMUCS_MODEL=htdemucs
MODEL_CACHE_DIR=/path/to/models

# Performance
USE_GPU=true
GPU_DEVICE=0
BATCH_SIZE=16

# Logging
LOG_LEVEL=INFO
LOG_FILE=/var/log/ai-voice/app.log

# Storage
TEMP_DIR=/tmp/ai-voice
OUTPUT_DIR=/var/lib/ai-voice/output
EOF
```

### 3. Build Rust Components

```bash
cd apps/desktop/src-tauri

# Development build
cargo build

# Production build
cargo build --release

# Run tests
cargo test
```

### 4. Build Frontend

```bash
cd apps/desktop

# Install dependencies
pnpm install

# Build for production
pnpm build

# Or build Tauri app
pnpm tauri build
```

### 5. Run Tests

```bash
# Python tests
cd apps/desktop/src-tauri/python
pytest tests/ -v

# Rust tests
cd apps/desktop/src-tauri
cargo test

# Integration tests
cd tests
pytest test_stem_separation_integration.py -v
```

### 6. Deploy to Staging

```bash
# Copy files to staging server
rsync -avz --exclude node_modules --exclude target \
    ./ user@staging:/opt/ai-voice/

# SSH to staging
ssh user@staging

# Start services
cd /opt/ai-voice
source venv/bin/activate
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### 7. Smoke Tests

```bash
# Test stem separation
curl -X POST http://staging:8000/api/separate \
    -F "audio=@test.wav"

# Test health endpoint
curl http://staging:8000/health

# Monitor logs
tail -f /var/log/ai-voice/app.log
```

### 8. Deploy to Production

```bash
# Blue-green deployment recommended
# Deploy to "green" environment first

# Copy to production
rsync -avz staging:/opt/ai-voice/ production:/opt/ai-voice-green/

# Switch traffic
# Update load balancer to point to green environment

# Monitor for issues
# If issues, rollback to blue environment
```

---

## 🐳 Docker Deployment (Recommended)

### Dockerfile

```dockerfile
FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libsndfile1 \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements
COPY apps/desktop/src-tauri/python/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY apps/desktop/src-tauri/python/ ./python/

# Create directories
RUN mkdir -p /tmp/ai-voice /var/lib/ai-voice/output

# Set environment
ENV PYTHONPATH=/app/python
ENV PYTHON_ENV=production

# Expose port (if running as service)
EXPOSE 8000

# Run application
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  ai-voice:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./models:/models
      - ./output:/var/lib/ai-voice/output
      - ./logs:/var/log/ai-voice
    environment:
      - PYTHONPATH=/app/python
      - MODEL_CACHE_DIR=/models
      - USE_GPU=true
      - LOG_LEVEL=INFO
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Deploy with Docker

```bash
# Build image
docker build -t ai-voice:latest .

# Run container
docker-compose up -d

# View logs
docker-compose logs -f

# Scale (if needed)
docker-compose up -d --scale ai-voice=3
```

---

## 📊 Monitoring & Observability

### Health Checks

```python
# Add to FastAPI app
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": "1.0.0",
        "gpu_available": torch.cuda.is_available(),
        "timestamp": time.time()
    }

@app.get("/ready")
async def readiness_check():
    # Check if models are loaded
    return {"status": "ready"}
```

### Metrics Collection

```python
# Prometheus metrics
from prometheus_client import Counter, Histogram, Gauge

# Counters
separation_requests = Counter('stem_separation_requests_total', 'Total stem separation requests')
separation_errors = Counter('stem_separation_errors_total', 'Total separation errors')

# Histograms
separation_duration = Histogram('stem_separation_duration_seconds', 'Separation duration')

# Gauges
active_separations = Gauge('stem_separations_active', 'Active separations')
```

### Logging Configuration

```python
import logging
from logging.handlers import RotatingFileHandler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        RotatingFileHandler(
            '/var/log/ai-voice/app.log',
            maxBytes=10485760,  # 10MB
            backupCount=5
        ),
        logging.StreamHandler()
    ]
)
```

### Dashboard (Grafana)

```yaml
# Example Grafana dashboard config
dashboards:
  - name: "AI Voice Metrics"
    panels:
      - title: "Requests per Second"
        type: "graph"
        metric: "rate(stem_separation_requests_total[5m])"
      
      - title: "Error Rate"
        type: "graph"
        metric: "rate(stem_separation_errors_total[5m])"
      
      - title: "Processing Duration"
        type: "graph"
        metric: "stem_separation_duration_seconds"
      
      - title: "Active Separations"
        type: "gauge"
        metric: "stem_separations_active"
```

---

## 🔒 Security Considerations

### Environment Security

```bash
# Restrict file permissions
chmod 600 .env
chmod 700 scripts/

# Use secrets management
# AWS Secrets Manager, HashiCorp Vault, etc.
```

### API Security

```python
# Add authentication
from fastapi import Depends, HTTPException, Security
from fastapi.security import APIKeyHeader

API_KEY_HEADER = APIKeyHeader(name="X-API-Key")

async def verify_api_key(api_key: str = Security(API_KEY_HEADER)):
    if api_key != os.getenv("API_KEY"):
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key

# Use in routes
@app.post("/api/separate", dependencies=[Depends(verify_api_key)])
async def separate_stems(...):
    ...
```

### Rate Limiting

```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.post("/api/separate")
@limiter.limit("10/minute")
async def separate_stems(...):
    ...
```

---

## 🔄 Rollback Procedures

### Automated Rollback

```bash
#!/bin/bash
# rollback.sh

# Switch back to previous version
CURRENT_VERSION=$(cat /opt/ai-voice/version.txt)
PREVIOUS_VERSION=$(cat /opt/ai-voice/previous_version.txt)

echo "Rolling back from $CURRENT_VERSION to $PREVIOUS_VERSION"

# Stop current version
systemctl stop ai-voice

# Restore previous version
rsync -avz /opt/ai-voice-backup/ /opt/ai-voice/

# Start previous version
systemctl start ai-voice

# Verify health
curl -f http://localhost:8000/health || exit 1

echo "Rollback complete"
```

### Manual Rollback

1. Stop current service
2. Restore from backup
3. Restart service
4. Verify functionality
5. Monitor logs

---

## 📈 Performance Tuning

### GPU Optimization

```python
# Use mixed precision
torch.set_float32_matmul_precision('high')

# Optimize memory
torch.cuda.empty_cache()

# Use TorchScript (for production)
model = torch.jit.script(model)
model.save("model_optimized.pt")
```

### CPU Optimization

```python
# Set thread count
torch.set_num_threads(8)

# Use ONNX Runtime
import onnxruntime as ort
session = ort.InferenceSession("model.onnx")
```

### Caching

```python
from functools import lru_cache

@lru_cache(maxsize=128)
def get_model(model_name: str):
    return load_model(model_name)
```

---

## 🧪 Staging Environment

### Setup

```bash
# Create staging environment
docker-compose -f docker-compose.staging.yml up -d

# Run integration tests
pytest tests/integration/ --staging

# Load test
locust -f loadtest.py --host=http://staging:8000
```

### Validation

- [ ] All features working
- [ ] Performance acceptable
- [ ] No errors in logs
- [ ] Metrics collecting
- [ ] Alerts functioning

---

## 📊 Production Monitoring

### Key Metrics

1. **Requests per second**
2. **Error rate (%)**
3. **Processing duration (p50, p95, p99)**
4. **GPU utilization (%)**
5. **Memory usage (GB)**
6. **Active connections**

### Alerts

```yaml
alerts:
  - name: "High Error Rate"
    condition: error_rate > 5%
    action: notify_team
  
  - name: "Slow Processing"
    condition: p95_duration > 30s
    action: scale_up
  
  - name: "High Memory"
    condition: memory_usage > 90%
    action: restart_service
```

---

## 🆘 Troubleshooting

### Common Issues

**1. Service won't start**
```bash
# Check logs
tail -n 100 /var/log/ai-voice/app.log

# Check permissions
ls -la /opt/ai-voice

# Check dependencies
pip list | grep torch
```

**2. High memory usage**
```bash
# Monitor memory
watch -n 1 'free -h'

# Profile Python
python -m memory_profiler app.py
```

**3. Slow processing**
```bash
# Check GPU
nvidia-smi

# Profile code
python -m cProfile -o output.prof app.py
```

---

## 📞 Support Contacts

- **Technical Lead:** [Contact Info]
- **DevOps:** [Contact Info]
- **On-Call:** [Contact Info]

---

## 📚 Additional Resources

- [Integration Guide](./INTEGRATION_GUIDE.md)
- [API Documentation](./API_DOCUMENTATION.md)
- [Architecture Overview](./AI_VOICE_IMPLEMENTATION_PLAN.md)

---

**Last Updated:** Implementation Complete
**Version:** 1.0.0
**Status:** Experimental / Internal Preview

