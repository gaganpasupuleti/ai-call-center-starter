#!/usr/bin/env python3
"""Download Faster-Whisper and Silero ONNX assets for offline runtime."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def download_whisper(model: str, download_root: Path) -> None:
    from faster_whisper import WhisperModel

    download_root.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Faster-Whisper model={model} root={download_root}")
    WhisperModel(
        model,
        device="cpu",
        compute_type="int8",
        download_root=str(download_root),
        local_files_only=False,
    )
    print("whisper_ok")


def download_silero(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Preparing Silero ONNX at {dest}")
    try:
        from silero_vad import load_silero_vad

        model = load_silero_vad(onnx=True)
        path = getattr(model, "model_path", None) or getattr(model, "path", None)
        if path and Path(path).is_file():
            shutil.copy2(path, dest)
            print("silero_copied")
            return
    except Exception as exc:
        print(f"silero_package_note: {exc}")

    # Prefer package data shipped with silero-vad.
    try:
        import silero_vad

        pkg = Path(silero_vad.__file__).resolve().parent
        for candidate in (
            pkg / "data" / "silero_vad.onnx",
            pkg / "data" / "silero_vad_half.onnx",
            pkg / "data" / "silero_vad_op18_ifless.onnx",
        ):
            if candidate.is_file():
                shutil.copy2(candidate, dest)
                print(f"silero_copied_from_package {candidate}")
                return
    except Exception as exc:
        print(f"silero_package_data_note: {exc}")

    # Fallback: onnx file may already be cached by the package.
    candidates = list(Path.home().glob("**/*silero*vad*.onnx"))
    for candidate in candidates[:5]:
        try:
            shutil.copy2(candidate, dest)
            print(f"silero_copied_from_cache {candidate}")
            return
        except Exception:
            continue

    # Last resort: fetch from the upstream GitHub package data path.
    url = (
        "https://github.com/snakers4/silero-vad/raw/master/"
        "src/silero_vad/data/silero_vad.onnx"
    )
    print(f"silero_download_fallback {url}")
    try:
        import urllib.request

        urllib.request.urlretrieve(url, dest)
        if dest.is_file() and dest.stat().st_size > 0:
            print("silero_downloaded")
            return
    except Exception as exc:
        print(f"silero_download_failed: {exc}")

    raise SystemExit(
        "silero_error: could not bake Silero ONNX into /models/silero_vad.onnx"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download STT model assets")
    parser.add_argument("--model", default="small")
    parser.add_argument("--download-root", default="/models")
    parser.add_argument("--silero-out", default="/models/silero_vad.onnx")
    parser.add_argument("--skip-whisper", action="store_true")
    parser.add_argument("--skip-silero", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.download_root)
    if not args.skip_whisper:
        download_whisper(args.model, root)
    if not args.skip_silero:
        download_silero(Path(args.silero_out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
