from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path


SKILLS_ROOT = Path(__file__).resolve().parents[1]
HELPER_DIR = SKILLS_ROOT / ".system" / "lib"
sys.path.insert(0, str(HELPER_DIR))

from project_paths import (  # noqa: E402
    first_existing_project_state_path,
    project_state_candidates,
    project_state_dir,
    project_state_path,
    user_skills_root,
)


class ProjectPathsTest(unittest.TestCase):
    def test_new_projects_default_to_agency_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(project_state_dir(root), root / ".agency")
            self.assertFalse((root / ".agency").exists())

    def test_existing_codex_only_projects_stay_backward_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".codex").mkdir()
            self.assertEqual(project_state_dir(root), root / ".codex")

    def test_existing_agency_wins_over_codex(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".codex").mkdir()
            (root / ".agency").mkdir()
            self.assertEqual(project_state_dir(root), root / ".agency")

    def test_explicit_relative_state_dir_wins_and_resolves_under_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(project_state_dir(root, explicit_state_dir=".custom"), root / ".custom")

    def test_env_state_dir_wins_when_no_explicit_state_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            previous = os.environ.get("AGENCY_STATE_DIR")
            os.environ["AGENCY_STATE_DIR"] = ".env-agency"
            try:
                self.assertEqual(project_state_dir(root), root / ".env-agency")
            finally:
                if previous is None:
                    os.environ.pop("AGENCY_STATE_DIR", None)
                else:
                    os.environ["AGENCY_STATE_DIR"] = previous

    def test_project_state_path_can_create_parent_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = project_state_path(root, "knowledge", "index.json", create_parent=True)
            self.assertEqual(path, root / ".agency" / "knowledge" / "index.json")
            self.assertTrue(path.parent.exists())
            self.assertFalse(path.exists())

    def test_project_state_candidates_are_dual_read_ordered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(
                project_state_candidates(root, "knowledge", "index.json"),
                [
                    root / ".agency" / "knowledge" / "index.json",
                    root / ".codex" / "knowledge" / "index.json",
                ],
            )

    def test_first_existing_project_state_path_checks_agency_then_codex(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_path = root / ".codex" / "knowledge" / "index.json"
            codex_path.parent.mkdir(parents=True)
            codex_path.write_text("{}", encoding="utf-8")
            self.assertEqual(first_existing_project_state_path(root, "knowledge", "index.json"), codex_path)

            agency_path = root / ".agency" / "knowledge" / "index.json"
            agency_path.parent.mkdir(parents=True)
            agency_path.write_text("{}", encoding="utf-8")
            self.assertEqual(first_existing_project_state_path(root, "knowledge", "index.json"), agency_path)

    def test_user_skills_root_prefers_agency_home(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            previous_home = os.environ.get("AGENCY_HOME")
            os.environ["AGENCY_HOME"] = str(home / ".agency-home")
            try:
                self.assertEqual(user_skills_root(), home / ".agency-home" / "skills")
            finally:
                if previous_home is None:
                    os.environ.pop("AGENCY_HOME", None)
                else:
                    os.environ["AGENCY_HOME"] = previous_home


if __name__ == "__main__":
    unittest.main()
