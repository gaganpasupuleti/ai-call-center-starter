# Kokoro is deployed from the pinned external image (not built from this repo):
#   ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0
#
# Railway dashboard / CLI:
#   Image: ghcr.io/remsky/kokoro-fastapi-cpu:v0.7.0
#   Port: 8880
#   Healthcheck path: /v1/audio/voices
#   Public domain: NONE (private networking only)
#   Suggested resources: 4 vCPU / 4 GB RAM
#   Serverless/sleeping: OFF during Phase 4E latency measurements
#
# Redeploy manually when changing the image tag. Do not use :latest.
