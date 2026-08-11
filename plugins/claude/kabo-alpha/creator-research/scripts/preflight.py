#!/usr/bin/env python3
"""Report V1-alpha integration readiness without exposing credential values."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = PLUGIN_ROOT / "config" / "capabilities.v1.json"
DEPENDENCY_REGISTRY_PATH = PLUGIN_ROOT / "config" / "connectors.v1.json"
BINARY_OVERRIDES = {
    "youtube-pp-cli": "CREATOR_YOUTUBE_PP_BIN",
    "scrapecreators": "CREATOR_SCRAPECREATORS_BIN",
    "yt-dlp": "CREATOR_YTDLP_BIN",
}
AUTH_READINESS = {
    "OpenSEO OAuth managed by the MCP host": "CREATOR_OPENSEO_OAUTH_READY",
}


def inspect_auth(required_auth: list[str]) -> dict[str, str]:
    return {
        name: "present" if os.environ.get(AUTH_READINESS.get(name, "")) == "1" else "missing"
        for name in required_auth
    }


def load_env_names(path: Path | None) -> set[str]:
    names: set[str] = set()
    if path is None:
        return names
    if not path.is_file():
        raise FileNotFoundError(f"env file not found: {path}")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() and value.strip():
            names.add(name.strip())
    return names


def configured_env_names(explicit_path: Path | None) -> set[str]:
    names = load_env_names(explicit_path)
    for raw_path in os.environ.get("CREATOR_CONNECTOR_ENV_FILES", "").split(os.pathsep):
        if raw_path:
            names.update(load_env_names(Path(raw_path).expanduser().resolve()))
    return names


def inspect_runtime_dependency(dependency_id: str, dependency: dict, env_names: set[str]) -> dict:
    secrets = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing"
        for name in dependency.get("required_secrets", [])
    }
    optional_secrets = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing_optional"
        for name in dependency.get("optional_secrets", [])
    }
    config = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing"
        for name in dependency.get("required_config", [])
    }
    binaries = {}
    for name in dependency.get("required_system_binaries", []):
        override = os.environ.get(BINARY_OVERRIDES.get(name, ""), "")
        override_present = bool(override and Path(override).expanduser().is_file())
        binaries[name] = "present" if (override_present or shutil.which(name)) else "missing"
    auth = inspect_auth(dependency.get("required_auth", []))
    configured = all(
        value == "present"
        for value in [*secrets.values(), *config.values(), *binaries.values(), *auth.values()]
    )
    return {
        "id": dependency_id,
        "kind": dependency.get("kind"),
        "provider": dependency.get("provider"),
        "callable": dependency.get("callable", False),
        "configured_prerequisites": configured,
        "secrets": secrets,
        "optional_secrets": optional_secrets,
        "config": config,
        "auth": auth,
        "system_binaries": binaries,
        "block_reason": dependency.get("block_reason"),
    }


def inspect(
    skill_id: str,
    capability: dict,
    env_names: set[str],
    dependency_registry: dict,
) -> dict:
    secrets = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing"
        for name in capability.get("required_secrets", [])
    }
    optional_secrets = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing_optional"
        for name in capability.get("optional_secrets", [])
    }
    binaries = {}
    for name in capability.get("required_system_binaries", []):
        override = os.environ.get(BINARY_OVERRIDES.get(name, ""), "")
        override_present = bool(override and Path(override).expanduser().is_file())
        binaries[name] = "present" if (override_present or shutil.which(name)) else "missing"
    config = {
        name: "present" if (os.environ.get(name) or name in env_names) else "missing"
        for name in capability.get("required_config", [])
    }
    auth = inspect_auth(capability.get("required_auth", []))
    connectors = [
        inspect_runtime_dependency(connector_id, dependency_registry["connectors"][connector_id], env_names)
        for connector_id in capability.get("connector_ids", [])
    ]
    internal_skills = [
        inspect_runtime_dependency(internal_id, dependency_registry["internal_skills"][internal_id], env_names)
        for internal_id in capability.get("internal_skill_dependencies", [])
    ]
    runtime_services = [
        inspect_runtime_dependency(service_id, dependency_registry["runtime_services"][service_id], env_names)
        for service_id in capability.get("runtime_service_ids", [])
    ]
    configured = (
        all(value == "present" for value in [*secrets.values(), *binaries.values(), *config.values()])
        and all(value == "present" for value in auth.values())
        and all(item["configured_prerequisites"] for item in [*connectors, *internal_skills, *runtime_services])
    )
    return {
        "skill_id": skill_id,
        "selected": capability["selected"],
        "role": capability["role"],
        "integration_state": capability["integration_state"],
        "callable": capability["callable"],
        "configured_prerequisites": configured,
        "secrets": secrets,
        "optional_secrets": optional_secrets,
        "config": config,
        "auth": auth,
        "system_binaries": binaries,
        "connectors": connectors,
        "internal_skill_dependencies": internal_skills,
        "runtime_services": runtime_services,
        "required_data": capability.get("required_data", []),
        "block_reason": capability.get("block_reason"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--skill")
    target.add_argument("--all", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--strict", action="store_true", help="Exit 3 if any selected target is not callable.")
    args = parser.parse_args()

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    dependency_registry = json.loads(DEPENDENCY_REGISTRY_PATH.read_text(encoding="utf-8"))
    skills = registry["skills"]
    if args.skill and args.skill not in skills:
        parser.error(f"unknown skill: {args.skill}")

    try:
        env_names = configured_env_names(args.env_file)
    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2

    ids = list(skills) if args.all else [args.skill]
    reports = [inspect(skill_id, skills[skill_id], env_names, dependency_registry) for skill_id in ids]
    payload = {
        "plugin_stage": registry["plugin_stage"],
        "connector_registry": str(DEPENDENCY_REGISTRY_PATH.relative_to(PLUGIN_ROOT)),
        "warning": "Credential presence does not make a pending wrapper callable.",
        "skills": reports,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if args.strict and any(not item["callable"] or not item["configured_prerequisites"] for item in reports):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
