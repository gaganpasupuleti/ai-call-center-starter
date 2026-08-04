"""FastAPI speech-to-text service: Silero VAD + Faster-Whisper."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

from .config import Settings, settings as default_settings
from .model_registry import ModelRegistry
from .protocol import (
    ProtocolError,
    error_event,
    parse_start_message,
    pong_event,
    ready_event,
)
from .session import StreamSession
from .transcriber import FasterWhisperTranscriber, FakeTranscriber
from .vad import SpeechSegmenter
from .vad_engine import ThresholdVad, create_vad

logger = logging.getLogger("speech-to-text")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def create_app(
    settings: Settings | None = None,
    *,
    registry: ModelRegistry | None = None,
    transcriber=None,
    vad_factory=None,
) -> FastAPI:
    cfg = settings or default_settings
    model_registry = registry or ModelRegistry(cfg)
    active_transcriber = transcriber
    if active_transcriber is None:
        active_transcriber = FasterWhisperTranscriber(model_registry, cfg)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = cfg
        app.state.registry = model_registry
        app.state.transcriber = active_transcriber
        app.state.vad_factory = vad_factory
        if cfg.load_model_on_startup and not isinstance(active_transcriber, FakeTranscriber):
            try:
                await asyncio.to_thread(model_registry.load)
                logger.info(
                    "whisper_ready model=%s device=%s compute=%s",
                    cfg.whisper_model,
                    cfg.whisper_device,
                    cfg.whisper_compute_type,
                )
            except Exception:
                logger.exception("whisper_load_failed")
        yield

    app = FastAPI(title="speech-to-text", lifespan=lifespan)
    # Available even before lifespan for unit tests / import checks.
    app.state.settings = cfg
    app.state.registry = model_registry
    app.state.transcriber = active_transcriber
    app.state.vad_factory = vad_factory

    @app.get("/healthz")
    async def healthz():
        return {
            "ok": True,
            "service": "speech-to-text",
            "provider": "faster-whisper",
            "vad": "silero-onnx",
        }

    @app.get("/readyz")
    async def readyz():
        reg: ModelRegistry = app.state.registry
        body = {
            "ready": bool(reg.status.ready),
            "model": reg.status.model,
            "device": reg.status.device,
            "computeType": reg.status.compute_type,
        }
        if not reg.status.ready:
            return JSONResponse(status_code=503, content=body)
        return body

    @app.websocket("/v1/stream")
    async def stream(ws: WebSocket):
        await ws.accept()
        if not await _authorize(ws, cfg.service_token):
            await ws.send_json(
                error_event("unauthorized", "Invalid or missing service token.", False)
            )
            await ws.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        session: StreamSession | None = None
        try:
            first = await ws.receive()
            if first.get("type") == "websocket.disconnect":
                return
            if "text" not in first:
                await ws.send_json(
                    error_event("invalid_start", "Expected JSON start message.", False)
                )
                await ws.close(code=1008)
                return
            try:
                payload = json.loads(first["text"])
                start = parse_start_message(payload)
            except ProtocolError as exc:
                await ws.send_json(error_event(exc.code, exc.message, False))
                await ws.close(code=1008)
                return
            except json.JSONDecodeError:
                await ws.send_json(
                    error_event("invalid_start", "Malformed JSON start message.", False)
                )
                await ws.close(code=1008)
                return

            segmenter = SpeechSegmenter(
                _make_vad(app, cfg),
                sample_rate=cfg.sample_rate,
                window_samples=cfg.vad_window_samples,
                threshold=cfg.vad_threshold,
                min_speech_ms=cfg.vad_min_speech_ms,
                min_silence_ms=cfg.vad_min_silence_ms,
                max_utterance_ms=cfg.vad_max_utterance_ms,
                pre_roll_ms=cfg.vad_pre_roll_ms,
                speech_pad_ms=cfg.vad_speech_pad_ms,
            )

            async def emit(event: dict[str, Any]) -> None:
                await ws.send_json(event)

            session = StreamSession(
                stream_sid=start["streamSid"],
                call_sid=start.get("callSid"),
                language=start["language"],
                segmenter=segmenter,
                transcriber=app.state.transcriber,
                emit=emit,
            )
            await ws.send_json(
                ready_event(
                    start["streamSid"],
                    sample_rate=cfg.sample_rate,
                    vad_window=cfg.vad_window_samples,
                )
            )

            while True:
                message = await ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if "bytes" in message and message["bytes"] is not None:
                    await session.push_mulaw(message["bytes"])
                    continue
                if "text" in message and message["text"] is not None:
                    try:
                        data = json.loads(message["text"])
                    except json.JSONDecodeError:
                        await ws.send_json(
                            error_event("protocol_error", "Malformed JSON message.")
                        )
                        continue
                    msg_type = data.get("type")
                    if msg_type == "ping":
                        await ws.send_json(pong_event())
                    elif msg_type == "stop":
                        await session.stop()
                        break
                    else:
                        await ws.send_json(
                            error_event("protocol_error", "Unsupported message type.")
                        )
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("stream_error")
            try:
                await ws.send_json(
                    error_event(
                        "internal_error",
                        "Speech service encountered an internal error.",
                        retryable=True,
                    )
                )
            except Exception:
                pass
        finally:
            if session is not None:
                if not session.closed:
                    try:
                        await session.stop()
                    except Exception:
                        pass
                snap = session.snapshot_diagnostics()
                app.state.last_session_diagnostics = {
                    "streamSid": session.stream_sid,
                    **snap,
                }
                logger.info(
                    "stt_session_diagnostics streamSid=%s %s",
                    session.stream_sid,
                    snap,
                )

    @app.get("/v1/diagnostics/last")
    async def last_diagnostics():
        """Private/safe counters only — no audio. Used by staging operators."""
        snap = getattr(app.state, "last_session_diagnostics", None) or {}
        return {"ok": True, "diagnostics": snap}

    app.state.last_session_diagnostics = {}
    return app


async def _authorize(ws: WebSocket, token: str) -> bool:
    if not token:
        return True
    header = ws.headers.get("authorization") or ws.headers.get("Authorization") or ""
    expected = f"Bearer {token}"
    return header.strip() == expected


def _make_vad(app: FastAPI, cfg: Settings):
    factory = getattr(app.state, "vad_factory", None)
    if factory:
        return factory()
    try:
        return create_vad(onnx_path=cfg.silero_onnx_path or None)
    except Exception:
        logger.warning("silero_unavailable_using_threshold_vad")
        return ThresholdVad()


app = create_app()
