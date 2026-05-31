export const BUILTIN_SCRIPTS: Record<string, string> = {
  prompt_route: ".system/scripts/prompt_router.py",
  plugin_validate: ".system/scripts/validate_codex_plugin.py",
  runtime_hook: "codex-runtime-hook/scripts/runtime_hook.py",
  auto_gate: "codex-execution-quality-gate/scripts/auto_gate.py",
};
