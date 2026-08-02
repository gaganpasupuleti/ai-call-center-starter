import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app
from app.model_registry import ModelRegistry
from app.transcriber import FakeTranscriber
from app.vad_engine import ThresholdVad


@pytest.mark.asyncio
async def test_healthz_and_readyz():
    settings = Settings(load_model_on_startup=False)
    registry = ModelRegistry(settings, loader=lambda: object())
    app = create_app(
        settings,
        registry=registry,
        transcriber=FakeTranscriber(),
        vad_factory=lambda: ThresholdVad(),
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/healthz")
        assert health.status_code == 200
        assert health.json()["ok"] is True
        ready = await client.get("/readyz")
        assert ready.status_code == 503
        registry.status.ready = True
        ready2 = await client.get("/readyz")
        assert ready2.status_code == 200
        assert ready2.json()["ready"] is True
