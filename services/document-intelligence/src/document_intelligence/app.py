from __future__ import annotations

import json
import asyncio
import logging
import os
from typing import Any

from .config import WorkerSettings
from .contracts import PROTOCOL_VERSION, RequestMetadata, parse_operation_generation, response, validate_provider_output
from .errors import WorkerError, sanitized_error
from .lifecycle import WorkerRuntime
from .observability import Timer, log_event
from .runtime.language_resolution import LanguageResolution, resolve_language
from .runtime.scheduler import BoundedScheduler
from .runtime.core_dumps import apply_core_dump_policy
from .runtime.determinism import apply_process_determinism


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    return default if raw is None else int(raw)


def _flag_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "on", "yes", "enabled", "bounded"}


def _build_scheduler(settings: WorkerSettings, runtime: WorkerRuntime) -> BoundedScheduler | None:
    """I6-56 admission scheduler — opt-in only.

    ``DOCUMENT_INTELLIGENCE_SCHEDULER`` unset/off keeps the default profile
    byte-identical: no scheduler is constructed and the executor takes its
    pre-I6 lane path unchanged.
    """
    if not _flag_env("DOCUMENT_INTELLIGENCE_SCHEDULER"):
        return None
    lane_capacity = sum(lane.capacity for lane in runtime.lanes.values())
    provider_cap = os.getenv("DOCUMENT_INTELLIGENCE_SCHEDULER_MAX_PROVIDER_IN_FLIGHT")
    tenant_queued = os.getenv("DOCUMENT_INTELLIGENCE_SCHEDULER_MAX_TENANT_QUEUED")
    share_raw = os.getenv("DOCUMENT_INTELLIGENCE_SCHEDULER_MAX_TENANT_SHARE", "1.0")
    return BoundedScheduler(
        max_in_flight=_int_env("DOCUMENT_INTELLIGENCE_SCHEDULER_MAX_IN_FLIGHT", max(1, lane_capacity)),
        max_queued=_int_env("DOCUMENT_INTELLIGENCE_SCHEDULER_MAX_QUEUED", settings.limits.max_queue),
        max_tenant_share=float(share_raw),
        max_provider_in_flight=int(provider_cap) if provider_cap else None,
        max_tenant_queued=int(tenant_queued) if tenant_queued else None,
    )


def _language_policy(settings: WorkerSettings) -> tuple[str | None, bool]:
    """(default_language, detection_enabled) for language resolution (I6-58).

    Both default to off so the default profile resolves identically to the
    pre-I6 path: an absent hint propagates None and providers reject it.
    """
    default_language = os.getenv("DOCUMENT_INTELLIGENCE_DEFAULT_LANGUAGE") or None
    if default_language is not None and default_language not in settings.request_languages:
        raise ValueError("DOCUMENT_INTELLIGENCE_DEFAULT_LANGUAGE must be an admitted request language")
    return default_language, _flag_env("DOCUMENT_INTELLIGENCE_LANGUAGE_DETECTION")

try:
    from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
    from fastapi.responses import JSONResponse
except ImportError:  # pragma: no cover - exercised only in minimal environments
    FastAPI = None  # type: ignore[assignment,misc]


def _json(value: str, limit: int) -> Any:
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit:
        raise WorkerError("LIMIT_EXCEEDED")
    try:
        return json.loads(value)
    except (TypeError, ValueError) as exc:
        raise WorkerError("INVALID_REQUEST") from exc


def _extract_payload(value: Any, limits: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != {"fields", "parsed"}:
        raise WorkerError("INVALID_REQUEST")
    fields = value["fields"]
    parsed = value["parsed"]
    if not isinstance(fields, list) or len(fields) > limits.max_candidates or not all(isinstance(field, dict) for field in fields):
        raise WorkerError("LIMIT_EXCEEDED" if isinstance(fields, list) else "INVALID_REQUEST")
    for field in fields:
        if set(field) - {"fieldId", "aliases", "valueType", "cardinality"} or not {"fieldId", "aliases", "valueType", "cardinality"}.issubset(field) or not isinstance(field["fieldId"], str) or not isinstance(field["aliases"], list) or any(not isinstance(alias, str) for alias in field["aliases"]) or not isinstance(field["valueType"], str) or not isinstance(field["cardinality"], str):
            raise WorkerError("INVALID_REQUEST")
    if not isinstance(parsed, dict) or set(parsed) - {"pages", "providerProvenance", "quality", "languageTag"} or not isinstance(parsed.get("pages"), list) or len(parsed["pages"]) > limits.max_pages:
        raise WorkerError("INVALID_REQUEST")
    text_size = 0
    block_count = 0
    line_count = 0
    for page in parsed["pages"]:
        if not isinstance(page, dict) or not isinstance(page.get("blocks"), list):
            raise WorkerError("INVALID_REQUEST")
        block_count += len(page["blocks"])
        for block in page["blocks"]:
            if not isinstance(block, dict) or not isinstance(block.get("lines"), list):
                raise WorkerError("INVALID_REQUEST")
            line_count += len(block["lines"])
            text_size += sum(len(line.get("text", "")) for line in block["lines"] if isinstance(line, dict) and isinstance(line.get("text", ""), str))
    if block_count > limits.max_blocks or line_count > limits.max_lines or text_size > limits.max_text_characters:
        raise WorkerError("LIMIT_EXCEEDED")
    return fields, parsed


def _embed_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"projection"} or not isinstance(value["projection"], dict):
        raise WorkerError("INVALID_REQUEST")
    return value["projection"]


def create_app(settings: WorkerSettings | None = None, runtime: WorkerRuntime | None = None) -> Any:
    if FastAPI is None:
        raise RuntimeError("FastAPI is required to create the worker app")
    settings = settings or WorkerSettings.from_env()
    # OCR-RUN-21/25: process-global controls must be applied before provider
    # instances and their native model runtimes are initialized.
    apply_process_determinism(settings.determinism_envelope)
    apply_core_dump_policy(strict=True)
    runtime = runtime or WorkerRuntime.create(settings)
    logger = logging.getLogger("document_intelligence")
    # I6-56: scheduler enforcement is opt-in; when unset the executor keeps
    # its sealed per-provider lane behavior unchanged.
    scheduler = _build_scheduler(settings, runtime)
    if scheduler is not None:
        runtime.provider_executor.scheduler = scheduler
    # I6-58: language resolution policy.  Defaults (no default language,
    # detection off) make resolution a strict no-op for existing flows.
    language_default, language_detection = _language_policy(settings)

    def not_ready_response() -> JSONResponse:
        payload = runtime.health.readyz()
        return JSONResponse({
            "status": "not_ready",
            "reasonCode": payload.get("reasonCode") or "MODEL_UNAVAILABLE",
        }, status_code=503)

    app = FastAPI(title="ghatana-document-intelligence", version="0.1.0", docs_url=None, redoc_url=None)
    app.state.runtime = runtime

    @app.on_event("startup")
    async def startup() -> None:
        app.state.startup_task = asyncio.create_task(runtime.start(), name="document-intelligence-startup")

    @app.on_event("shutdown")
    async def shutdown() -> None:
        startup_task = getattr(app.state, "startup_task", None)
        if startup_task is not None:
            await asyncio.gather(startup_task, return_exceptions=True)
        await runtime.shutdown()

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return runtime.health.healthz()

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        payload = runtime.health.readyz()
        return JSONResponse(payload, status_code=200 if payload["status"] == "ready" else 503)

    @app.get("/v1/providers")
    async def providers() -> Any:
        if not runtime.health.ready or runtime.health.shutting_down:
            return not_ready_response()
        return {"protocolVersion": PROTOCOL_VERSION, "providers": runtime.models.admitted_catalog(runtime.settings.enabled_providers)}

    @app.get("/v1/runtime-assets")
    async def runtime_assets() -> Any:
        if not runtime.health.ready or runtime.health.shutting_down:
            return not_ready_response()
        rows = runtime.models.runtime_asset_roots("ghatana.paddleocr")
        # The expected language surface is the admitted authority, not a
        # hard-coded pair: the frozen Increment-3 baseline admits en/ne while
        # the Increment-4A profile admits en/ne/hi/mr.
        accepted = runtime.models.accepted_capabilities("ghatana.paddleocr") or {}
        expected_languages = set(accepted.get("languages", []))
        return {
            "providerRef": "ghatana.paddleocr",
            "languageModels": rows,
            "status": "ready" if {row["language"] for row in rows} == expected_languages and all(row["ready"] for row in rows) else "not_ready",
            # Internal providers required by admitted composite routes (e.g.
            # the Tesseract fallback) are readiness material but never part of
            # the public provider catalog.
            "internalDependencies": [
                {"providerRef": dependency, "ready": runtime.models.ready(dependency)}
                for dependency in runtime.internal_dependencies
            ],
        }

    async def execute(metadata: RequestMetadata, data: bytes, operation_kind: str) -> JSONResponse:
        operation = None
        temporary_run = None
        temporary_path = None
        resolved_language = metadata.language_hint
        try:
            if not runtime.health.ready or runtime.health.shutting_down:
                raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=metadata.provider_ref)
            committed = await runtime.operations.get_outcome(metadata.operation_id, metadata.operation_generation)
            if committed is not None:
                return JSONResponse(committed.response, status_code=committed.status_code)
            # I6-58: resolve the working language through the authority order
            # validatedRequestHint -> profileDefault -> detection -> none.
            # An absent hint with no policy default keeps resolving to None,
            # preserving the provider-side UNSUPPORTED_LANGUAGE rejection.
            resolution: LanguageResolution = resolve_language(
                metadata.language_hint,
                media_type=metadata.media_type or "",
                candidate_languages=settings.request_languages,
                default_language=language_default,
                detection_enabled=language_detection,
            )
            resolved_language = resolution.language
            runtime.capability_admission.require(metadata.provider_ref, operation_kind, metadata.media_type, resolved_language)
            operation = await runtime.operations.begin(
                metadata.operation_id,
                metadata.provider_ref,
                metadata.timeout_ms,
                metadata.operation_generation,
            )
            try:
                # I6-85: each admitted operation gets a private 0700 namespace;
                # cleanup never recursively touches the shared temp root.
                temporary_run = runtime.temporary_files.create_run()
                temporary_path = temporary_run.write(data)
            except ValueError as exc:
                raise WorkerError("LIMIT_EXCEEDED") from exc
            with Timer() as timer:
                if operation_kind == "parse":
                    output = await runtime.provider_executor.parse(metadata.provider_ref, data, media_type=metadata.media_type, language=resolved_language, limits={**metadata.limits, "maxPages": settings.limits.max_pages}, deadline=operation.deadline, token=operation.token, operation_id=metadata.operation_id)
                elif operation_kind == "extract":
                    payload = _json(data.decode("utf-8"), settings.limits.max_metadata_bytes)
                    fields, parsed = _extract_payload(payload, settings.limits)
                    output = await runtime.provider_executor.extract(metadata.provider_ref, parsed, fields, deadline=operation.deadline, token=operation.token, language=resolved_language, operation_id=metadata.operation_id)
                else:
                    payload = _json(data.decode("utf-8"), settings.limits.max_metadata_bytes)
                    output = await runtime.provider_executor.embed(metadata.provider_ref, _embed_payload(payload), deadline=operation.deadline, token=operation.token, operation_id=metadata.operation_id)
                output_payload = response(metadata.operation_id, metadata.provider_ref, output)
                validate_provider_output(output_payload, settings.limits)
                if not await runtime.operations.publish_success(operation, output_payload):
                    raise WorkerError("CANCELLED", provider_ref=metadata.provider_ref)
                log_event(logger, operationId=metadata.operation_id, providerRef=metadata.provider_ref, mediaType=metadata.media_type, language=resolved_language, inputByteCount=len(data), elapsedMs=timer.elapsed_ms(), status="success")
                return JSONResponse(output_payload)
        except WorkerError as exc:
            if operation is not None:
                error_payload = exc.envelope(metadata.operation_id)
                await runtime.operations.publish_failure(operation, error_payload, 409 if exc.code == "DUPLICATE_OPERATION" else 429 if exc.code == "PROVIDER_BUSY" else 400 if not exc.retryable else 503)
            log_event(logger, operationId=metadata.operation_id, providerRef=metadata.provider_ref, mediaType=metadata.media_type, language=resolved_language, inputByteCount=len(data), elapsedMs=0, status="failure", failureCategory=exc.code)
            status = 409 if exc.code == "DUPLICATE_OPERATION" else 429 if exc.code == "PROVIDER_BUSY" else 400 if not exc.retryable else 503
            return JSONResponse(exc.envelope(metadata.operation_id), status_code=status)
        except Exception as exc:  # sanitized at the process boundary
            return JSONResponse(sanitized_error(exc, metadata.operation_id, metadata.provider_ref), status_code=500)
        finally:
            if temporary_run is not None:
                temporary_run.cleanup_all()
            else:
                runtime.temporary_files.cleanup(temporary_path)
            if operation is not None:
                await runtime.operations.finish(operation)

    @app.post("/v1/parse")
    async def parse(
        metadata: str = Form(...),
        file: UploadFile = File(...),
        operation_generation: str | None = Header(default=None, alias="X-Operation-Generation"),
    ) -> JSONResponse:
        try:
            raw = _json(metadata, settings.limits.max_metadata_bytes)
            parsed = RequestMetadata.parse(
                raw,
                settings.limits,
                media_type_required=True,
                allowed_media_types=settings.allowed_media_types,
                allowed_languages=settings.request_languages,
                operation_generation_header=operation_generation,
            )
        except WorkerError as exc:
            return JSONResponse(exc.envelope("invalid-request"), status_code=400)
        # Reject before reading the upload: readiness may still be waiting on
        # internal provider initialization or frozen-authority validation.
        if not runtime.health.ready or runtime.health.shutting_down:
            error = WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=parsed.provider_ref)
            return JSONResponse(error.envelope(parsed.operation_id), status_code=503)
        data = await file.read(settings.limits.max_upload_bytes + 1)
        if len(data) > settings.limits.max_upload_bytes:
            return JSONResponse(WorkerError("LIMIT_EXCEEDED").envelope(parsed.operation_id), status_code=413)
        return await execute(parsed, data, "parse")

    @app.post("/v1/extract")
    async def extract(
        metadata: dict[str, Any],
        operation_generation: str | None = Header(default=None, alias="X-Operation-Generation"),
    ) -> JSONResponse:
        try:
            parsed = RequestMetadata.parse(
                {key: value for key, value in metadata.items() if key != "payload"},
                settings.limits,
                media_type_required=False,
                allowed_media_types=settings.allowed_media_types,
                allowed_languages=settings.request_languages,
                operation_generation_header=operation_generation,
            )
        except WorkerError as exc:
            return JSONResponse(exc.envelope("invalid-request"), status_code=400)
        raw = metadata.get("payload")
        if not isinstance(raw, dict):
            return JSONResponse(WorkerError("INVALID_REQUEST").envelope(parsed.operation_id), status_code=400)
        return await execute(parsed, json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), "extract")

    @app.post("/v1/embed")
    async def embed(
        metadata: dict[str, Any],
        operation_generation: str | None = Header(default=None, alias="X-Operation-Generation"),
    ) -> JSONResponse:
        try:
            parsed = RequestMetadata.parse(
                {key: value for key, value in metadata.items() if key != "projection"},
                settings.limits,
                media_type_required=False,
                allowed_media_types=settings.allowed_media_types,
                allowed_languages=settings.request_languages,
                operation_generation_header=operation_generation,
            )
        except WorkerError as exc:
            return JSONResponse(exc.envelope("invalid-request"), status_code=400)
        raw = metadata.get("projection")
        if not isinstance(raw, dict):
            return JSONResponse(WorkerError("INVALID_REQUEST").envelope(parsed.operation_id), status_code=400)
        return await execute(parsed, json.dumps({"projection": raw}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), "embed")

    @app.delete("/v1/operations/{operation_id}")
    async def cancel(
        operation_id: str,
        operation_generation: str = Header(..., alias="X-Operation-Generation"),
    ) -> Any:
        try:
            generation = parse_operation_generation(operation_generation)
        except WorkerError as exc:
            return JSONResponse(exc.envelope(operation_id), status_code=400)
        cancelled = await runtime.operations.cancel(operation_id, generation)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "operationId": operation_id,
            "operationGeneration": generation,
            "cancelled": cancelled,
        }

    return app


if FastAPI is None:
    app = None
else:
    try:
        app = create_app()
    except Exception:
        # Importing the module remains safe in tooling and test environments where
        # the runtime model directory is intentionally not provisioned.
        app = None


def main() -> None:
    import uvicorn

    settings = WorkerSettings.from_env()
    uvicorn.run("document_intelligence.app:app", host=settings.host, port=settings.port, log_level="info")
