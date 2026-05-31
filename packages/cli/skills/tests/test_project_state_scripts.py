from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


SKILLS_ROOT = Path(__file__).resolve().parents[1]


def run_script(script: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *args],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


class ProjectStateScriptsTest(unittest.TestCase):
    def test_decision_logger_writes_to_agency_when_present(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "decision_logger.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".agency").mkdir()
            result = run_script(
                script,
                "--project-root",
                str(root),
                "--title",
                "Portable Paths",
                "--decision",
                "Use shared path policy",
                "--alternatives",
                "Hardcode .codex",
                "--reasoning",
                "State must be portable",
                "--context",
                "Harness migration",
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/decisions/", payload["path"].replace("\\", "/"))
            self.assertTrue((root / ".agency" / "decisions").exists())

    def test_init_spec_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-spec-driven-development" / "scripts" / "init_spec.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(
                script,
                "--project-root",
                str(root),
                "--title",
                "Portable Spec",
                "--prompt",
                "Keep generated specs portable",
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/specs/", payload["spec_path"].replace("\\", "/"))
            self.assertTrue((root / ".agency" / "specs").exists())

    def test_runtime_hook_reads_agency_profile(self) -> None:
        script = SKILLS_ROOT / "codex-runtime-hook" / "scripts" / "runtime_hook.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            profile_dir = root / ".agency"
            profile_dir.mkdir()
            (profile_dir / "profile.json").write_text(
                json.dumps(
                    {
                        "schema_version": "1.0",
                        "primary_domain": "backend",
                        "stack": ["fastapi"],
                    }
                ),
                encoding="utf-8",
            )
            result = run_script(script, "--project-root", str(root), "--format", "json")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["profile_status"]["status"], "valid")
            self.assertIn("/.agency/profile.json", payload["profile_status"]["path"].replace("\\", "/"))

    def test_memory_status_reads_agency_knowledge_by_default(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "memory_status.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            knowledge_dir = root / ".agency" / "knowledge"
            knowledge_dir.mkdir(parents=True)
            generated_at = datetime.now(timezone.utc).isoformat()
            index = {
                "schema_version": "1.0",
                "artifact_type": "knowledge_index",
                "generated_at": generated_at,
                "project_root": str(root),
                "stats": {},
                "warnings": [],
                "redaction": {},
            }
            graph = {
                **index,
                "artifact_type": "knowledge_graph",
                "code_index": {"src/app.py": {"module": "root"}},
                "module_boundaries": {},
                "api_routes": {},
                "coherence": {},
            }
            (knowledge_dir / "index.json").write_text(json.dumps(index), encoding="utf-8")
            (knowledge_dir / "knowledge-graph.json").write_text(json.dumps(graph), encoding="utf-8")
            result = run_script(script, "--project-root", str(root), "--format", "json")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/knowledge", payload["knowledge_dir"].replace("\\", "/"))
            self.assertIn(payload["status"], {"pass", "warn"})

    def test_init_profile_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-runtime-hook" / "scripts" / "init_profile.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(script, "--project-root", str(root))
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/profile.json", payload["path"].replace("\\", "/"))
            self.assertTrue((root / ".agency" / "profile.json").exists())

    def test_install_and_validate_hooks_use_agency_state(self) -> None:
        install_script = SKILLS_ROOT / "codex-runtime-hook" / "scripts" / "install_codex_hooks.py"
        validate_script = SKILLS_ROOT / "codex-runtime-hook" / "scripts" / "validate_codex_hooks.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(install_script, "--project-root", str(root), "--apply")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/hooks.json", payload["hooks_path"].replace("\\", "/"))

            result = run_script(validate_script, "--project-root", str(root))
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "pass")
            self.assertIn("/.agency/hooks.json", payload["hooks_path"].replace("\\", "/"))

    def test_init_role_docs_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-role-docs" / "scripts" / "init_role_docs.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(script, "--project-root", str(root), "--roles", "qa")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["docs_root"], ".agency/project-docs")
            self.assertTrue((root / ".agency" / "project-docs" / "PROJECT-BRIEF.md").exists())

    def test_check_spec_reads_agency_specs(self) -> None:
        script = SKILLS_ROOT / "codex-spec-driven-development" / "scripts" / "check_spec.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec_dir = root / ".agency" / "specs" / "portable"
            spec_dir.mkdir(parents=True)
            (spec_dir / "SPEC.md").write_text(
                "\n".join(
                    [
                        "# Spec: Portable",
                        "Schema-Version: 1.0",
                        "Status: accepted",
                        "Domains: backend",
                        "- [ ] AC-001: Backend path works",
                        "- [ ] TICKET-001: Implement",
                    ]
                ),
                encoding="utf-8",
            )
            result = run_script(script, "--project-root", str(root), "--changed-files", "api/users.py")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["specs_found"], 1)
            self.assertEqual(payload["matched_specs"], ["portable"])

    def test_track_feedback_writes_and_aggregates_agency(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "track_feedback.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(
                script,
                "--project-root",
                str(root),
                "--file",
                "src/app.py",
                "--ai-version",
                "bad name",
                "--user-fix",
                "renamed to match project style",
                "--category",
                "naming",
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/feedback/", payload["path"].replace("\\", "/"))

            result = run_script(script, "--project-root", str(root), "--aggregate")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["total_feedback"], 1)
            self.assertEqual(payload["by_category"]["naming"], 1)

    def test_generate_growth_report_uses_agency_state(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "generate_growth_report.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            feedback_dir = root / ".agency" / "feedback"
            feedback_dir.mkdir(parents=True)
            (feedback_dir / "2026-05-25-naming.md").write_text(
                "\n".join(
                    [
                        "# Feedback: naming",
                        "Date: 2026-05-25",
                        "Category: naming",
                        "Severity: minor",
                        "",
                        "## File",
                        "src/app.py",
                    ]
                ),
                encoding="utf-8",
            )
            skills_root = root / "skills"
            skills_root.mkdir()
            result = run_script(script, "--project-root", str(root), "--skills-root", str(skills_root), "--since", "3650")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/growth-reports/", payload["path"].replace("\\", "/"))
            self.assertGreaterEqual(payload["feedback_items"], 1)

    def test_build_knowledge_index_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "build_knowledge_index.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text('{"name":"portable"}', encoding="utf-8")
            result = run_script(script, "--project-root", str(root), "--max-files", "5")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "built")
            self.assertIn("/.agency/knowledge/", payload["index_path"].replace("\\", "/"))

    def test_generate_genome_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "generate_genome.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app.py").write_text("print('ok')\n", encoding="utf-8")
            result = run_script(script, "--project-root", str(root), "--format", "json")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/context/genome.md", payload["genome_path"].replace("\\", "/"))

    def test_analyze_patterns_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "analyze_patterns.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app.py").write_text("def handler():\n    return True\n", encoding="utf-8")
            result = run_script(script, "--project-root", str(root))
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/project-profile.json", payload["path"].replace("\\", "/"))

    def test_generate_handoff_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "generate_handoff.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text('{"name":"portable"}', encoding="utf-8")
            result = run_script(script, "--project-root", str(root))
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/.agency/handoff.md", payload["path"].replace("\\", "/"))

    def test_track_skill_usage_defaults_to_agency_home(self) -> None:
        script = SKILLS_ROOT / "codex-project-memory" / "scripts" / "track_skill_usage.py"
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "agency-home"
            env = dict(os.environ)
            env["AGENCY_HOME"] = str(home)
            result = run_script(
                script,
                "--record",
                "--skill",
                "codex-project-memory",
                "--task",
                "portable analytics",
                "--outcome",
                "success",
                env=env,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("/agency-home/skills/.analytics/", payload["path"].replace("\\", "/"))

    def test_quality_trend_defaults_new_projects_to_agency(self) -> None:
        script = SKILLS_ROOT / "codex-execution-quality-gate" / "scripts" / "quality_trend.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app.py").write_text("print('ok')\n", encoding="utf-8")
            result = run_script(script, "--project-root", str(root), "--record")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            snapshot_path = payload["path"]
            self.assertIn("/.agency/quality/", snapshot_path.replace("\\", "/"))

    def test_run_gate_persists_state_under_agency(self) -> None:
        script = SKILLS_ROOT / "codex-execution-quality-gate" / "scripts" / "run_gate.py"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run_script(script, "--project-root", str(root), "--skip-lint", "--skip-test")
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertTrue((root / ".agency" / "state" / "gate_state.json").exists())
            self.assertTrue((root / ".agency" / "quality" / "gate-events.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
