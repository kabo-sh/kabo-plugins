#!/usr/bin/env python3
"""Build a patched Head video analyzer copy without mutating locked source."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parents[3]
REGISTRY_PATH = PLUGIN_ROOT / "config" / "connectors.v1.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_repo_path(value: str) -> Path:
    return (REPO_ROOT / value).resolve()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    component = registry["internal_skills"]["head-video-analyzer"]
    source = resolve_repo_path(component["source"])
    patch = resolve_repo_path(component["build_patch"])
    source_script = source / "scripts" / "analyze_videos.py"
    output = args.output.resolve()

    if output.exists():
        print(f"refusing to overwrite existing output: {output}", file=sys.stderr)
        return 2
    for path, expected in (
        (source_script, component["source_script_sha256"]),
        (patch, component["build_patch_sha256"]),
    ):
        actual = sha256(path)
        if actual != expected:
            print(f"sha256 mismatch for {path}: expected {expected}, got {actual}", file=sys.stderr)
            return 3

    shutil.copytree(source, output)
    try:
        subprocess.run(
            ["patch", "-p1", "--batch", "--forward", "-i", str(patch)],
            cwd=output / "scripts",
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        shutil.rmtree(output)
        print(f"failed to apply verified patch: {exc}", file=sys.stderr)
        return 4

    built_script = output / "scripts" / "analyze_videos.py"
    text = built_script.read_text(encoding="utf-8")
    required_markers = ["gemini-flash-latest", "types.FileData(file_uri=video_url)", "Expected video content"]
    missing = [marker for marker in required_markers if marker not in text]
    if missing:
        shutil.rmtree(output)
        print(f"patched output missing markers: {missing}", file=sys.stderr)
        return 5
    built_sha256 = sha256(built_script)
    if built_sha256 != component["built_script_sha256"]:
        shutil.rmtree(output)
        print(
            f"built script sha256 mismatch: expected {component['built_script_sha256']}, got {built_sha256}",
            file=sys.stderr,
        )
        return 6

    print(json.dumps({
        "component": "head-video-analyzer",
        "output": str(output),
        "source_script_sha256": component["source_script_sha256"],
        "patch_sha256": component["build_patch_sha256"],
        "built_script_sha256": built_sha256,
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
