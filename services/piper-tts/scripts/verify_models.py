#!/usr/bin/env python3
"""Verify downloaded Piper voice files against voices.manifest.json."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

APPROVED_VOICES = (
    "te_IN-padmavathi-medium",
    "te_IN-venkatesh-medium",
    "en_US-libritts_r-medium",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify Piper voice model files")
    parser.add_argument("--dest", default="models")
    parser.add_argument(
        "--require-all",
        action="store_true",
        help="Require every approved voice to be present",
    )
    args = parser.parse_args(argv)

    dest = Path(args.dest)
    manifest_path = dest / "voices.manifest.json"
    if not manifest_path.is_file():
        print(f"Missing manifest: {manifest_path}", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    voices = manifest.get("voices") or {}
    if args.require_all:
        for voice in APPROVED_VOICES:
            if voice not in voices:
                print(f"Manifest missing required voice: {voice}", file=sys.stderr)
                return 1

    errors = 0
    for voice, meta in voices.items():
        if voice not in APPROVED_VOICES:
            print(f"Unexpected voice in manifest: {voice}", file=sys.stderr)
            errors += 1
            continue
        for kind, key in (("model", "model"), ("config", "config"), ("modelCard", "modelCard")):
            name = meta.get(key)
            if not name:
                print(f"{voice}: missing {kind} filename", file=sys.stderr)
                errors += 1
                continue
            path = dest / name
            if not path.is_file() or path.stat().st_size == 0:
                print(f"{voice}: missing or empty {path}", file=sys.stderr)
                errors += 1
                continue
            expected = (meta.get("sha256") or {}).get(kind if kind != "modelCard" else "modelCard")
            # map: model/config/modelCard keys in sha256
            sha_key = {"model": "model", "config": "config", "modelCard": "modelCard"}[kind]
            expected = (meta.get("sha256") or {}).get(sha_key)
            if expected:
                actual = sha256_file(path)
                if actual.lower() != str(expected).lower():
                    print(
                        f"{voice}: SHA-256 mismatch for {kind} "
                        f"(expected {expected}, got {actual})",
                        file=sys.stderr,
                    )
                    errors += 1
            print(f"ok {voice} {kind} {path.stat().st_size} bytes")

    if errors:
        print(f"verify_failed errors={errors}", file=sys.stderr)
        return 1
    print("verify_ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
