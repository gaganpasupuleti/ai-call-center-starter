#!/usr/bin/env python3
"""Download approved Piper Telugu voices (not used by unit tests)."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

APPROVED_VOICES = (
    "te_IN-padmavathi-medium",
    "te_IN-venkatesh-medium",
)

# Path layout under rhasspy/piper-voices
VOICE_PATHS = {
    "te_IN-padmavathi-medium": "te/te_IN/padmavathi/medium",
    "te_IN-venkatesh-medium": "te/te_IN/venkatesh/medium",
}

HF_REPO = "rhasspy/piper-voices"
# Exact commit inspected near Phase 4D hash recording (not floating main).
DEFAULT_REVISION = "9f967d15e9ccdf43078586d1476ee70f314401bd"

# Phase 4D recorded SHA-256 digests (must match after download).
EXPECTED_SHA256 = {
    "te_IN-padmavathi-medium": {
        "model": "414aa5960d91ceb6e45bbdf8c27fdc71af09f205130d7be4e99470f3c2cfa57d",
        "config": "6c86e4ee99d379815f78a75f23cdad62ccf50370062dd915c233d6e22de7109f",
        "modelCard": "8cdccd0ca4c26d1e949431f03180bcf9eaeb3c013f627087c6a806a3f7487b07",
    },
    "te_IN-venkatesh-medium": {
        "model": "dfaa5b7833cd48d946f3fe18c9c934aaa4e8590aac6922fddf34783a694c3c87",
        "config": "59bad556763d1f24b3434201d7bdee275bb1a70db3e1c65d38e6c3d39b224343",
        "modelCard": "1e72b79b6453653bd6c43722f80fb34f429dbeccaf18116480d6faa20b01e685",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            with partial.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
        partial.replace(dest)
    except Exception:
        if partial.exists():
            partial.unlink(missing_ok=True)
        raise


def voice_urls(voice: str, revision: str) -> dict[str, str]:
    if voice not in VOICE_PATHS:
        raise ValueError(f"Voice '{voice}' is not approved for this service")
    base = f"https://huggingface.co/{HF_REPO}/resolve/{revision}/{VOICE_PATHS[voice]}"
    return {
        "model": f"{base}/{voice}.onnx",
        "config": f"{base}/{voice}.onnx.json",
        "modelCard": f"{base}/MODEL_CARD",
    }


def download_voice(voice: str, dest: Path, revision: str) -> dict:
    urls = voice_urls(voice, revision)
    model_path = dest / f"{voice}.onnx"
    config_path = dest / f"{voice}.onnx.json"
    card_path = dest / f"{voice}.MODEL_CARD"

    for kind, url, path in (
        ("model", urls["model"], model_path),
        ("config", urls["config"], config_path),
        ("modelCard", urls["modelCard"], card_path),
    ):
        print(f"Downloading {voice} {kind}…")
        try:
            download(url, path)
        except urllib.error.HTTPError as exc:
            raise SystemExit(
                f"Failed to download {voice} {kind} (HTTP {exc.code}). "
                "Partial downloads were discarded."
            ) from exc
        except Exception as exc:
            raise SystemExit(
                f"Failed to download {voice} {kind}: {exc}. "
                "Partial downloads were discarded."
            ) from exc
        if not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"Downloaded file missing or empty: {path}")

    # Piper http_server expects MODEL_CARD beside models when present under HF tree;
    # also keep a flat copy named after the voice for our verify script.
    flat_card = dest / "MODEL_CARD"
    if voice == APPROVED_VOICES[0] or not flat_card.exists():
        flat_card.write_bytes(card_path.read_bytes())

    return {
        "model": model_path.name,
        "config": config_path.name,
        "modelCard": card_path.name,
        "source": {
            "repository": HF_REPO,
            "revision": revision,
            "path": VOICE_PATHS[voice],
        },
        "sha256": {
            "model": sha256_file(model_path),
            "config": sha256_file(config_path),
            "modelCard": sha256_file(card_path),
        },
    }


def verify_expected_hashes(voice: str, sha256: dict[str, str]) -> None:
    expected = EXPECTED_SHA256.get(voice)
    if not expected:
        raise SystemExit(f"No expected hashes recorded for voice {voice}")
    for kind, digest in expected.items():
        actual = sha256.get(kind)
        if actual != digest:
            raise SystemExit(
                f"Hash mismatch for {voice} {kind}: expected {digest}, got {actual}"
            )
    print(f"Hash OK for {voice}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download approved Piper Telugu voices")
    parser.add_argument("--dest", default="models", help="Destination directory")
    parser.add_argument(
        "--revision",
        default=DEFAULT_REVISION,
        help="Hugging Face revision (branch, tag, or commit SHA)",
    )
    parser.add_argument(
        "--voices",
        default=",".join(APPROVED_VOICES),
        help="Comma-separated approved voice ids only",
    )
    parser.add_argument(
        "--require-expected-hashes",
        action="store_true",
        help="Fail if downloaded digests do not match Phase 4D recorded hashes",
    )
    args = parser.parse_args(argv)

    if args.revision == "main":
        print(
            "WARNING: floating revision 'main' is discouraged; "
            f"prefer pinned {DEFAULT_REVISION}",
            file=sys.stderr,
        )

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    requested = [v.strip() for v in args.voices.split(",") if v.strip()]
    for voice in requested:
        if voice not in APPROVED_VOICES:
            print(
                f"Refusing to download unapproved voice '{voice}'. "
                f"Allowed: {', '.join(APPROVED_VOICES)}",
                file=sys.stderr,
            )
            return 2

    manifest = {
        "repository": HF_REPO,
        "revision": args.revision,
        "voices": {},
    }
    existing_path = dest / "voices.manifest.json"
    if existing_path.is_file():
        try:
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
            if isinstance(existing.get("voices"), dict):
                manifest["voices"].update(existing["voices"])
        except json.JSONDecodeError:
            pass
    for voice in requested:
        meta = download_voice(voice, dest, args.revision)
        if args.require_expected_hashes:
            verify_expected_hashes(voice, meta["sha256"])
        manifest["voices"][voice] = meta

    manifest_path = dest / "voices.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
