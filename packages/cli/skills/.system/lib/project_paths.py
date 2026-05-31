"""Shared path policy for portable project and user state.

Project state policy:
- explicit script argument wins;
- AGENCY_STATE_DIR wins when no explicit argument is supplied;
- existing .agency wins over existing .codex;
- existing .codex remains backward-compatible;
- new projects write to .agency by default.

Read paths should use project_state_candidates() or
first_existing_project_state_path() to support dual-read migration.
Write paths should use project_state_path() to keep writes single-rooted.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable


PROJECT_STATE_ENV = "AGENCY_STATE_DIR"
USER_HOME_ENV = "AGENCY_HOME"
SKILLS_ROOT_ENV = "AGENCY_SKILLS_ROOT"

PREFERRED_PROJECT_STATE_DIR = ".agency"
LEGACY_PROJECT_STATE_DIR = ".codex"
PROJECT_STATE_DIR_NAMES = (PREFERRED_PROJECT_STATE_DIR, LEGACY_PROJECT_STATE_DIR)


def _as_project_root(project_root: str | Path) -> Path:
    return Path(project_root).expanduser().resolve()


def _resolve_from_base(base: Path, value: str | Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path.resolve()
    return (base / path).resolve()


def _relative_parts(parts: Iterable[str | Path]) -> tuple[str, ...]:
    normalized: list[str] = []
    for part in parts:
        candidate = Path(part)
        if candidate.is_absolute() or candidate.drive:
            raise ValueError(f"state path part must be relative: {part}")
        for item in candidate.parts:
            if item in {"", "."}:
                continue
            if item == "..":
                raise ValueError(f"state path part cannot contain '..': {part}")
            normalized.append(item)
    return tuple(normalized)


def project_state_dir(
    project_root: str | Path,
    explicit_state_dir: str | Path | None = None,
    *,
    create: bool = False,
) -> Path:
    """Return the project state directory according to the shared policy."""

    root = _as_project_root(project_root)
    if explicit_state_dir:
        resolved = _resolve_from_base(root, explicit_state_dir)
    else:
        env_value = os.environ.get(PROJECT_STATE_ENV, "").strip()
        if env_value:
            resolved = _resolve_from_base(root, env_value)
        elif (root / PREFERRED_PROJECT_STATE_DIR).exists():
            resolved = root / PREFERRED_PROJECT_STATE_DIR
        elif (root / LEGACY_PROJECT_STATE_DIR).exists():
            resolved = root / LEGACY_PROJECT_STATE_DIR
        else:
            resolved = root / PREFERRED_PROJECT_STATE_DIR

    if create:
        resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def project_state_path(
    project_root: str | Path,
    *parts: str | Path,
    explicit_state_dir: str | Path | None = None,
    create_parent: bool = False,
) -> Path:
    """Return a single write path under the selected project state directory."""

    path = project_state_dir(project_root, explicit_state_dir=explicit_state_dir) / Path(*_relative_parts(parts))
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True)
    return path


def project_state_candidates(
    project_root: str | Path,
    *parts: str | Path,
    explicit_state_dir: str | Path | None = None,
) -> list[Path]:
    """Return read candidates in migration order."""

    root = _as_project_root(project_root)
    relative = Path(*_relative_parts(parts))
    if explicit_state_dir:
        return [_resolve_from_base(root, explicit_state_dir) / relative]

    env_value = os.environ.get(PROJECT_STATE_ENV, "").strip()
    if env_value:
        return [_resolve_from_base(root, env_value) / relative]

    return [(root / name / relative) for name in PROJECT_STATE_DIR_NAMES]


def first_existing_project_state_path(
    project_root: str | Path,
    *parts: str | Path,
    explicit_state_dir: str | Path | None = None,
) -> Path | None:
    """Return the first existing dual-read candidate, or None."""

    for candidate in project_state_candidates(project_root, *parts, explicit_state_dir=explicit_state_dir):
        if candidate.exists():
            return candidate
    return None


def user_state_dir(explicit_state_dir: str | Path | None = None, *, create: bool = False) -> Path:
    if explicit_state_dir:
        resolved = Path(explicit_state_dir).expanduser().resolve()
    else:
        env_home = os.environ.get(USER_HOME_ENV, "").strip()
        if env_home:
            resolved = Path(env_home).expanduser().resolve()
        elif (Path.home() / PREFERRED_PROJECT_STATE_DIR).exists():
            resolved = (Path.home() / PREFERRED_PROJECT_STATE_DIR).resolve()
        elif (Path.home() / LEGACY_PROJECT_STATE_DIR).exists():
            resolved = (Path.home() / LEGACY_PROJECT_STATE_DIR).resolve()
        else:
            resolved = (Path.home() / PREFERRED_PROJECT_STATE_DIR).resolve()

    if create:
        resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def user_state_path(
    *parts: str | Path,
    explicit_state_dir: str | Path | None = None,
    create_parent: bool = False,
) -> Path:
    path = user_state_dir(explicit_state_dir=explicit_state_dir) / Path(*_relative_parts(parts))
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True)
    return path


def user_skills_root(explicit_skills_root: str | Path | None = None) -> Path:
    if explicit_skills_root:
        return Path(explicit_skills_root).expanduser().resolve()

    env_skills = os.environ.get(SKILLS_ROOT_ENV, "").strip()
    if env_skills:
        return Path(env_skills).expanduser().resolve()

    return user_state_path("skills")


def display_path(project_root: str | Path, path: str | Path) -> str:
    root = _as_project_root(project_root)
    resolved = Path(path).expanduser().resolve()
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError:
        return resolved.as_posix()
