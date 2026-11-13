FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCUMENT_INTELLIGENCE_ALLOW_REMOTE=false \
    DOCUMENT_INTELLIGENCE_HOST=127.0.0.1
WORKDIR /opt/document-intelligence
COPY pyproject.toml uv.lock README.md TESTING.md ./
COPY src ./src
COPY models ./models
COPY scripts ./scripts
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir '.[runtime,providers]'
RUN mkdir -p /tmp/document-intelligence && chown -R 65532:65532 /tmp/document-intelligence
USER 65532:65532
EXPOSE 8765
CMD ["python", "-m", "document_intelligence.app"]
