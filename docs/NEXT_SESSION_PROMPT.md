# AgencyCLI — Prompt cho session sau (vận hành đúng · skills-pipeline tight-coupling · triệt để amateur-tell/de-fake · BYOK CUỐI)

> **Cách dùng:** dán nguyên khối từ dòng `---` dưới đây vào tin nhắn đầu của một phiên Claude Code mới trên repo này.
> Prompt **trỏ tới** docs/memory thật (không sao chép chi tiết) nên không tự trùng lặp và luôn đồng bộ với docs.
> Số liệu là ảnh chụp lúc soạn (2026-06-02, HEAD `dc3d176` trên `master`, cây sạch) — phiên mới **xác nhận lại bằng docs + `git log` + `pnpm verify`**.

---

Bạn tiếp quản **AgencyCLI** (`D:\AgencyCLI`) — monorepo **pnpm, 16 package**, runtime agent **tự hành cục bộ** (KHÔNG phải chatbot). Hai "bệnh" cốt lõi phải luôn cảnh giác: (1) **machinery xây xong nhưng không nối dây (built-but-unwired)** và (2) **trùng lặp logic/file/UI/kiến trúc**. Ba nguyên tắc bất di bất dịch: **không tạo trùng lặp · không xây thứ treo lơ lửng · VERIFY chứ đừng assert**.

## 0. ĐỌC TRƯỚC khi làm bất cứ gì (đúng thứ tự)
1. `memory/MEMORY.md` (index 1 dòng) → `memory/agencycli-section8-overflow.md` (chi tiết §8/§9 + UX/amateur-tell/de-fake + facts "đừng-điều-tra-lại": churn family, $-corruption, reassembly, truncate-tail, edit-diagnostic, read_file-NaN, find_files-bể-mặc-định, auto-mkdir, ast_edit-arrow, path-confinement, Splash de-fake, prompt "powerful") → `memory/agencycli-production-hardening.md` (nhật ký + git chain).
2. `docs/ROADMAP_HANDOFF.md` → **§2.2** (completion-detection) + **§2.4** (tool layer) + **§8**. Mỗi item ghi SỰ THẬT → LỖI → SỬA (+file). Đừng điều tra lại root-cause đã ghi.
3. `docs/SESSION_HANDOFF_PROMPT.md` — luật chống-trùng (1), wired-or-dead + **6 guard** (2), verify-đừng-assert (3), quy ước cờ/kiến trúc (4), nhịp slice (5), **BYOK key AN TOÀN (6.1 — key chỉ ở env, KHÔNG lên đĩa)**.
4. `docs/PACKAGES.md` → **"Canonical Homes & No-Duplication Map"** + "Built-in tools" (20 tool, MỘT `ToolRegistry`) — tra TRƯỚC khi thêm helper/module/tool/command.

> **Bài học:** grep dead-code CẢ `.ts/.tsx/.mts`. Verify-đừng-assert áp cả script audit tự viết. Soi `git status`/`git show` trước+sau commit. **Verify coupling THẬT trước khi hoãn "vì behavior-sensitive"** (phiên này gỡ được prompt "powerful" sau khi phát hiện lo "length-invariant test" là SAI — test chỉ assert relative cache===legacy).

## 1. ƯU TIÊN CỦA USER (đọc kỹ — đã mở rộng)
Thứ tự ưu tiên user chốt nhiều lần: **(1) MỌI THỨ vận hành ĐÚNG hướng/đúng logic + tools hiệu quả → (2) TUI/UX rõ ràng như opencode NHƯNG tinh chỉnh XỊN HƠN + chuyên nghiệp hơn → (3) BYOK = bước KIỂM TRA CUỐI CÙNG.**
- **RULE TỐI THƯỢNG xuyên suốt:** KHÔNG được có **amateur tell**; triệt để **amateur tell + de-fake** ở MỌI NGÓC NGÁCH source (UI copy, fake/fabricated data, puffery, log bịa).
- **MANDATE MỚI (user nhấn mạnh — coi là luồng kiểm thử lớn):** đảm bảo TOÀN BỘ pipeline trong CLI **tight-coupling chặt chẽ, ổn định, đáng tin cậy**: **harness + built-in tools + skills + prompt + markdown + references + scripts + starter + template + domain-specialist + spawn parallel subagents + persistent memory (xuyên long-session VÀ multi-session)**. Và: **pipeline/workflow từ skills CHÍNH phải phát huy HẾT công năng đúng ý nghĩa skills-plugin** của user. → Đây là luồng **(e)** bên dưới, ưu tiên cao sau P0.
- **ĐỪNG nhảy vào BYOK/eval/promote-default sớm.**

## ✅ P0 — CHURN-CLUSTER PROMOTE TO ON-BY-DEFAULT DONE (2026-06-02, commit `6c0a9f6`, user OK)
**Bằng chứng gốc (ảnh):** project `D:\AnimeSoul\aniverse`, file `src/data/anime-data.ts`. Trace thật: `npm run build` exit 1 → read anime-data.ts (33 lines) → read types.ts (441) → `append_file` 6.6KB → build exit 1 → `Remove-Item anime-data.ts -Force` → `append_file` 4.6KB → build exit 1 → `Remove-Item` → … **14m56s, 23.8k tokens, status kẹt "Writing".** Triệu chứng "bắt đầu từ giữa / mất phần đầu" = bug reassembly `cb932d8`.
**GỐC RỄ HỆ THỐNG (đã sửa):** 4 fix churn (`cb932d8` reassembly · `9a0a03f` truncate-tail · `34a0f23`/`4d97563` auto-continue · `1c6fc75` resume-continuation) ĐỀU flag-gated OFF ở legacy → user chạy legacy nên KHÔNG hưởng → vẫn churn. **`6c0a9f6` lật default 4 cờ `toolCallReassembly`/`toolResultTailKept`/`resumeContinuation`/`autoContinue` từ `hardened`→`true`** (on cả 2 profile; `AGENCY_*=0` vẫn opt-out về legacy). 3 cờ đầu = correctness zero-cost; autoContinue thêm ≤MAX_AUTO_CONTINUE completion CHỈ khi model báo unfinished rõ. flags.ts JSDoc/comment cập nhật (hết "off in legacy/byte-identical"); 4 test OFF-case chuyển sang set `AGENCY_*=0` tường minh (test cả 2 path). `pnpm verify` REAL_EXIT_CODE=0 (core 474, cli 573). **36 cờ vẫn 36** (chỉ default đổi).
**CÒN LẠI / LƯU Ý:**
1. ⚠️ **User VẪN phải `pnpm -r build` + restart TUI** để dist mới có hiệu lực — fix nằm trong src/dist mới build, TUI đang chạy dist cũ chưa thấy. (Env-var workaround GIỜ THỪA vì đã là default, nhưng rebuild thì BẮT BUỘC.)
2. **Live churn repro vẫn cần key** (config user toàn placeholder `${}` chưa set — xem §4). Test suite đã khoá cả 2 path (OFF/ON) deterministic = "eval" cho churn-cluster (correctness, không provider-dependent). Nếu sau `/connect` user vẫn thấy churn → có bug DƯ reassembly chưa phủ → điều tra `chat/stream.ts`+`orchestrator.ts` turn-loop.
3. Các cờ hardened-only KHÁC (security enforce, prompt-cache, semantic memory, context-compaction, path-confinement…) VẪN opt-in — promote này CHỈ đụng 4 cờ churn-correctness.

## 2. ĐÃ XONG phiên 2026-06-02 (HEAD `dc3d176`, cây sạch) — ĐỪNG làm lại
> ⚠️ **NHẮC USER `pnpm -r build` + restart TUI**: mọi fix ở `src`, TUI chạy `dist` cũ chưa thấy hiệu lực. Nhiều fix flag-gated → xem P0.
**9 fix phiên này (core 443→474, +31 test; chi tiết + GOTCHA trong `memory/agencycli-section8-overflow.md`):**
- `9a0a03f` **truncateToolResult head+tail** cho output lệnh (lỗi build/test ở CUỐI bị head-only cắt → model mù → churn). Cờ `AGENCY_TOOLRESULT_TAIL` off-legacy.
- `1b2fdff` **edit_file/batch_edit diagnostic match-fail** (`diagnoseEditMismatch`: CRLF/indent-echo-text-thật/định-vị-dòng-đầu/absent) thay lỗi generic. KHÔNG cờ.
- `85c1dc8` **read_file range NaN-bounds** (`String(undefined)` defeat `|| default` → chỉ-start→rỗng / chỉ-end→"NaN"). KHÔNG cờ.
- `c844eaa` **find_files BỂ MẶC ĐỊNH** (strip chỉ `*` giữ `/` → default `**/*`→"/"→`includes("/")`=false→trả 0 file cả repo đầy) + **grep/find silent-cap honesty**. KHÔNG cờ. ⚠ bug nghiêm trọng — agent trước "mù" khi tìm file.
- `4073535` **write/append/move tự tạo thư mục cha** (hết ENOENT churn khi ghi path lồng mới). KHÔNG cờ.
- `8cfa174` **ast_edit replace_function_body hỗ trợ arrow/function-expression const** (trước chỉ FunctionDeclaration). KHÔNG cờ.
- `007f8b1` **path confinement** chặn write/delete/move thoát projectRoot (read không confine). Cờ `AGENCY_PATH_CONFINEMENT` off-legacy.
- `9a297d7` **de-fake Splash "Diagnostics"** (% progress + ✓ "providers ready" là GIẢ tính từ tick timer, không check thật). → header "Startup", checklist glyph honest. De-fake sweep KẾT LUẬN: fabrication duy nhất, phần còn lại (IndexProgress/GoalRunner/StatusBar/scroll/elapsed) dùng giá trị THẬT.
- `19afb92` **gỡ "powerful"** khỏi system prompt (puffery; lo "length-invariant" của phiên trước verify ra SAI). KHÔNG cờ (§8.11-E precedent).
- + verify `executeWithRetry` AN TOÀN (tool ghi tự catch lỗi→trả string không-"Error:" → không retry → KHÔNG double-append).
- **Baseline:** build 16/16, **REAL_EXIT_CODE=0**, core **474** · cli 573 · tui **154** · providers **855**. **36 cờ** · **20 tool**.

**Các phiên TRƯỚC (đừng làm lại — đã trong memory):** churn family `cb932d8`/`25bd0d4`+`6e7d43b`/`3a22f11`; auto-continue `34a0f23`+`4d97563`; verify-main-turn TUI `548169a`+`cd0fb53`; amateur-tell 2 đợt (11 commit) + de-fake Splash log boot `920c167` + ExecutionPanel `47c2667`; §8.10 TUI-realtime (6 slice); §8.11 token audit; §9 markdown memory (`MarkdownMemoryStore`+`remember`/`forget`).

## 3. VIỆC KẾ TIẾP — luồng ưu tiên (sau P0)
- **(e) 🔥 SKILLS/PLUGIN PIPELINE END-TO-END AUDIT (mandate mới của user — ưu tiên cao sau P0):** verify TIGHT-COUPLING + wired-or-dead + chống-trùng cho TOÀN pipeline skills-plugin. **MAP THẬT (neo file — đừng map lại từ đầu):**
  - **Skill pack** ở `resolveSkillsRoot()` (`core/skills-root.ts`, cascade env+hardcoded): layout `skillsRoot/.system/references/plugin-tools.json` (plugin tools) + `.system/scripts/*.py` (prompt_router, validate_codex_plugin, …) + `manifest.json` (skill list) + skill `<name>/SKILL.md` (frontmatter+TL;DR) + skill dir `references/`/`scripts/`/`assets/` + builtins `codex-runtime-hook`, `codex-execution-quality-gate`.
  - **Bridge** `@agency/skills-bridge`: `loader.ts loadManifestSkills` · `skill-md.ts parseSkillMd` · `registry.ts loadPluginTools` · `runner.ts runTool/runBuiltinScript/resolvePythonBin` · `builtins.ts BUILTIN_SCRIPTS` · `aliases.ts SKILL_ALIASES` (~70 `$`-shortcut: `$plan/$tdd/$gate/$verify/$debug/$finish`…).
  - **Harness/exec** `core/skill/`: `harness.ts runWithVerificationHarness` (max-3-retry + auto_gate) · `tool-harness.ts` (20 tool, 1 registry) · `invoke-actions.ts getInvokeActions`. **Router** `core/router/` (`routeUserPrompt`→`prompt-bridge`→Python, fallback `heuristicRoute`). **Prompt** `core/chat/prompt.ts buildSystemPrompt` (skill/tool docs vào prompt). **Workflow/pipeline** `core/workflow/compose.ts runWorkflow` (8 chain dựng sẵn) + cmd `agency workflow list/run` — verify chain skill chính chạy đúng thứ tự + wired.
  - **Domain specialists** `core/agents/`: `types.ts MANIFEST_AGENTS` (8: frontend/backend/security-auditor/debugger/test-engineer/devops/planner/scrum-master) · `profiles.ts AGENT_SUBAGENT_PROMPT/subagentPromptPath/loadCustomAgents` · `orchestrator.ts dispatchAgent/dispatchAgentsParallel` (cờ `maxParallelAgents`, `capabilityRouting`) · tool `dispatch_subagent`.
  - **Persistent memory** `@agency/memory`: `markdown-memory.ts MarkdownMemoryStore` (curated, `remember`/`forget`, cờ `fileMemory`) + `episodic-store.ts` (`getRecentAcrossSessions` cross-session) → recall qua `core/chat/memory-integration.ts loadHistoricalMemories`.
  - **Mục tiêu mỗi mắt xích:** (a) NỐI DÂY thật (không built-but-unwired — vd: references/scripts/starter/template trong pack có được runtime DÙNG hay nằm chết?), (b) KHÔNG trùng (2 SEARCH/REPLACE parser core↔tui; 2 translator), (c) workflow skill CHÍNH chạy HẾT công năng. **Công cụ audit sẵn có:** `agency doctor --deep` (pack health) · `agency plugin validate/tools/schema` · `agency skill list/show/invoke` · `agency route "<prompt>"` (xem routing) · `agency agents` (dispatch). **6 guard liên quan** (skills↔manifest, agents↔prompt/seed) — chạy + mở rộng. **Cách làm:** chia slice mỗi mắt xích; viết test e2e cho 1-2 skill chính chạy full pipeline (route→harness→tool/subagent→memory); báo cáo mắt xích chết/lỏng/trùng TRƯỚC khi sửa. **Verify-đừng-assert: chạy `agency doctor --deep` + `agency skill invoke` thật, đừng đoán "đã wire".**
- **(c) structured tool-card thay text-in-stream** (đòn bẩy "xịn hơn opencode" lớn nhất; rework NHIỀU SLICE — LẬP PLAN + user duyệt TRƯỚC khi code): tool activity hiện là TEXT `⚡ [SYSTEM: Tool "X"...]` nhồi vào message rồi regex-parse lại (`TraceTelemetry.parseSystemActivityLine`) = round-trip lossy. §8.10 cố ý KHÔNG làm (sợ "surface thứ 5"). Hướng: event tool-lifecycle cấu trúc (tái dùng EventBus như `subagent:progress`, ĐỪNG thêm surface lạc) → render card riêng (tool·target·status·summary). **Vào plan mode, điều tra pipeline trước.**
- **(a) amateur-tell còn sót (marginal, an toàn):** user-facing đã near-complete. Còn: comment "Premium" nội bộ (GlowingLogo/ModelsOverlay/SkillsPicker/WorkerProgress); `.toUpperCase()` data-value /model diag; Splash exit-log "✓ X ready" trên timer (borderline fake, transient <1s — cân nhắc honest-hóa cho nhất quán de-fake). Grep: `Premium|SUCCESSFULLY|KERNEL|\[[A-Z]{3,}\]`.
- **(b) badge "needs key" provider picker** (follow-up `eb19ba5`).
- **(dedup)** 2 TUI translator (`tool-labels.getSemanticToolOperation` ↔ `SemanticTranslator`) — concept trùng, chưa merge (string-only, tránh re-litigate "intentionally distinct").
- **CỐ Ý KHÔNG đụng (đừng làm lại):** ALL-CAPS Unix headers (NAVIGATION/COMMANDS); ExecutionPanel PLAN/EXECUTE (tested); TrustCard PASSED/FAILED (severity badge); identity "CodexAI skills harness" (đổi identity = behavior). `renameSymbol` naive-rename = limitation có-doc (cần type-checker). Path-traversal: read tools cố ý KHÔNG confine.
- **BYOK (CUỐI, cần key):** eval legacy↔hardened + promote hardened→default. CHỈ sau khi P0+(e) ổn + user OK. Config user đang placeholder (xem §4).

## 4. ⚠ CONFIG-STATE CỦA USER (không phải bug code — ĐỪNG tự sửa key)
`~/.agency/config.json` chỉ có `openrouter`/`anthropic`/`local`; **nvidia KHÔNG còn**; key là placeholder `${...}` env CHƯA set → `resolveApiKey`→`""` → **không provider nào dùng được** tới khi user đặt key thật. **TUYỆT ĐỐI không tự ghi key** (§6.1). User thêm qua `/connect` (liệt kê cả 6 provider) → mở `/models` fetch live. **Lưu ý:** churn P0 KHÔNG cần key để reproduce/fix (là correctness tool-loop, không phải provider).

## 5. NHỊP MỖI SLICE + CẤM KỴ (xem SESSION_HANDOFF §3–§4)
investigate (đọc + grep CẢ `.ts/.tsx/.mts`, tra Canonical Homes) → phân loại (trùng-thật vs distinct-cố-ý; wire vs delete) → đổi **tối thiểu, behavior-preserving, tái dùng canonical home** → **cờ trong `runtime/flags.ts` nếu đổi hành vi runtime** (legacy byte-identical; tool/command/UI-copy/bugfix-corruption thuần = KHÔNG cờ) → thêm/cập nhật test → **`pnpm verify` XANH (REAL_EXIT_CODE=0, 16 pkg)** → commit nhỏ trên `master` (soi `git status` trước `add`, KHÔNG amend/`--no-verify`, trailer `Co-Authored-By: Claude Opus 4.8`) → sync living docs + `memory/`. **Giữ 6 guard xanh.**
- Không assert "green". Không xóa/sửa khi chưa grep 0 live importer (CẢ `.tsx`). Không gộp cặp "trùng tên cố ý". Không tạo helper/tool/command trùng. **Không tự promote hardened→default. Không tự ghi BYOK key.**

**Bắt đầu:** đọc §0 → **NHẮC user `pnpm -r build` + restart TUI** (P0 promote `6c0a9f6` đã on-by-default, nhưng dist cũ vẫn churn tới khi rebuild) → **P0 ĐÃ XONG** (churn-cluster on-by-default, user OK) → vào **(e) skills-pipeline audit** (mandate mới — luồng chính kế tiếp). Làm theo nhịp §5. **BYOK CUỐI.**
