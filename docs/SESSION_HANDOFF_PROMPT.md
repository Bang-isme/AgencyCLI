# AgencyCLI — Prompt tiếp nối phiên (nắm rõ source, chống trùng lặp)

> **Cách dùng:** dán nguyên khối dưới đây vào tin nhắn đầu của một phiên Claude Code mới
> trên repo này. Prompt **trỏ tới** `docs/` + `memory/` thật (không sao chép nội dung) nên
> không tự trở thành bản trùng lặp và luôn cập nhật theo docs. Số liệu trong mục 6 là ảnh
> chụp tại thời điểm soạn — prompt đã yêu cầu phiên mới xác nhận lại bằng docs/memory.

---

Bạn tiếp quản **AgencyCLI** (`D:\AgencyCLI`) — monorepo pnpm 16 package, runtime agent tự hành cục bộ (KHÔNG phải chatbot), đang trong chiến dịch **production-hardening**. Hai "bệnh" cốt lõi của repo: (1) **machinery xây xong nhưng không nối dây** (built-but-unwired) và (2) **trùng lặp logic/file/UI/kiến trúc**. Nhiệm vụ: tiếp tục từng slice nhỏ, chất lượng cao, **tuyệt đối không tạo trùng lặp** và **không xây thứ treo lơ lửng**.

## 0. ĐỌC TRƯỚC khi làm bất cứ gì (đúng thứ tự)
1. `memory/MEMORY.md` + `memory/agencycli-production-hardening.md` — nhật ký chạy + git chain + trạng thái mới nhất.
2. `docs/HARDENING_HANDOFF.md` — §3 (đã xong + số test/package), §5 (STATUS + các note "cont'd N" = nhật ký từng slice), §6 (git), §7 (resume).
3. `docs/ROADMAP_HANDOFF.md` — kế hoạch 6 bậc + các mục §2.x (đã đánh dấu ✅/🟡).
4. **`docs/PACKAGES.md` → mục "Canonical Homes & No-Duplication Map"** — BẮT BUỘC: "ai sở hữu cái gì" + bảng "trùng tên/khác ngữ nghĩa CỐ Ý — KHÔNG gộp" + lệnh quét trùng.

> Không suy diễn từ trí nhớ — số liệu/cấu trúc có thể đã đổi. Luôn `grep`/đọc file THẬT rồi mới kết luận. **Bài học nhãn cũ:** `OutputEngine` từng bị gán "dead" nhưng thực ra LIVE; `tui/state/semantic-orchestration.ts` từng bị grep `--include='*.ts'` báo "dead" nhưng WIRED qua `App.tsx` (đuôi `.tsx` bị bỏ qua). **Khi kiểm importer luôn quét CẢ `.ts` + `.tsx` + `.mts`** kẻo xóa nhầm code live.

## 1. CHỐNG TRÙNG LẶP (trọng tâm)
- Trước khi thêm BẤT KỲ helper/module/tool/command nào → tra "Canonical Homes". Concern đã có nhà → **tái dùng**, không viết lại.
- Chạy quét bằng chứng (bản đầy đủ trong PACKAGES.md):
  ```bash
  grep -rEn --include='*.ts' "^export (async )?(function|class) [A-Za-z0-9_]+" packages/*/src \
   | grep -v __tests__ \
   | sed -E 's#(.*):[0-9]+:export (async )?(function|class) ([A-Za-z0-9_]+).*#\4\t\1#' \
   | sort | awk -F'\t' '{n[$1]=n[$1]" "$2;c[$1]++} END{for(k in c) if(c[k]>1) print c[k]"  "k":"n[k]}'
  ```
- Phân loại MỖI lần:
  - **trùng THẬT** (logic y hệt) → gộp vào canonical home, **behavior-preserving** (giữ nguyên precedence/edge-case).
  - **trùng tên/khác ngữ nghĩa CỐ Ý** → GIỮ, không gộp: `ReplayEngine` (core journal ↔ telemetry trace), `truncateText` (TUI width-aware ↔ core char-count), token `~len/4` (mỗi package công thức khác), `handover.ts` (core logic ↔ cli command), per-package `index/types/config/runner`.
- Nhà chung đã thiết lập: logic dùng chung 2 turn path → `chat/turn-helpers.ts`; output headless → `OutputEngine` (qua `cli/src/utils.ts` `out`/`handleError`); tool-loop breaker → `chat/circuit-breaker.ts`; DAG/plan → `task/runner.ts` `runPlan`; routing → `agents/agent-registry.ts`; journal+replay → `events/`; precise AST edit → `utils/ast-compiler.ts` (qua tool `ast_edit`); "tool nào ghi file" → `isFileWritingTool`; trace record/replay → telemetry tracker + benchmark `runRegressionReplay` (driver = lệnh `agency replay-regression`); **cognition narration (`thought:emitted` cho CognitionPanel) → `events/cognition.ts` `emitThought`** (producer DUY NHẤT, gate `cognitionStream`; ĐỪNG publish `thought:emitted` thủ công; điểm emit: routing, safety gating, capability reroute, verify self-heal qua `emitVerifyRoundThought`, compaction); **hiển thị flag ở `agency status` (human) → `cli/commands/status.ts` `buildFlagRows`** (1 list khai báo, ĐỪNG `console.log` flag lẻ); `ChatMessage` (`{role,content}`) **đã về `@agency/providers`** (core re-export, đừng khai lại).
- **Cặp trùng-tên CỐ Ý ở tầng type/interface (KHÔNG gộp):** `ToolCall` (core parsed-XML `{name,arguments:string}` ↔ tooling `{id,…,any}`), `GraphEdge` (code graph ↔ memory knowledge graph), `VerificationResult` (harness command ↔ checkpoint task), `AuditEntry` (approval gate ↔ memory mutation). Quét type: đổi `(function|class)` thành `(interface|type)` trong lệnh trên.

## 2. WIRED-OR-DEAD — đừng tái tạo nợ
Mọi machinery export từ `core/index.ts` đều WIRED hoặc DELETED (đóng 100%). Audit ĐÃ MỞ RỘNG ra cả file `core/src` KHÔNG nằm trong index (quét full + kiểm importer `.ts`/`.tsx`/`.mts`): đã xóa 2 module speculative (`skill/context-delivery.ts`, `validation/correctness-science.ts`) và wire 1 producer chết (`events/cognition.ts`). Code mới phải **được nối dây + dùng ngay**, không "xây rồi treo". Tool mới auto-quảng bá cho model qua `registry.listTools()`→`buildSystemPrompt` (đăng ký = model thấy). Nếu thấy gì giống dead-code → grep 0 live importer (CẢ `.tsx`) rồi mới xử lý; phân biệt **dead thật** (xóa) vs **live-consumer/dead-producer** (wire, như cognition + §2.5); ghi vào docs.
- **3 tầng wiring đã có REGRESSION GUARD (chạy trong `pnpm verify`) — đừng để drift:** skills↔manifest (`cli/__tests__/skills-manifest-integrity.test.ts`: mọi skill khai có SKILL.md + ngược lại + `manifest.agents`==`MANIFEST_AGENTS` + load_order); agents↔prompt/seed (`core/__tests__/agent-dispatch-integrity.test.ts`: `AGENT_SUBAGENT_PROMPT`/seed/`MANIFEST_AGENTS` đồng bộ + prompt file resolve + disciplines là skill thật); flags↔status (`cli/__tests__/status-flags.test.ts`: mọi flag `getRuntimeFlags()` đều xuất hiện ở `agency status`). **Thêm skill/agent/flag mới → cập nhật manifest/seed/buildFlagRows trong CÙNG slice** kẻo guard fail. Runtime: `agency doctor` cũng validate pack ĐÃ CÀI (mọi skill khai resolve SKILL.md).
- **Harness/tools/skills/agents inventory** đã ghi sẵn ở `PACKAGES.md` mục "Harness, built-in tools & skills" (17 built-in tool trong MỘT `ToolRegistry`, vòng lặp turn, 28 skill + 8 agent + 8 workflow) — ĐỌC thay vì tự suy ra lại.

## 3. VERIFY = sự thật, đừng assert
- Gate DUY NHẤT: `pnpm verify` (= `pnpm -r build && pnpm -r test`). Baseline: build 16/16 sạch, **~2030 test, exit 0** (core 344 / cli 571 / tui 115 / providers 840 / memory 36 / benchmark 18 / workspace 11 / security 35 / tooling 14 / governance 7 / skills-bridge 13 / context 6 / heuristics 6 / browser 5 / telemetry 9).
- **Chạy `pnpm verify` TRƯỚC khi nói "green" hay commit.** Repo có lịch sử "xanh ảo" — KHÔNG được assert. (Kiểm `EXIT_CODE=0`; bỏ qua warning cố ý: failover/rate-limit/Playwright-missing/docker-unreachable.)
- Test fail nghi flaky/timeout dưới tải đồng thời → **xác minh** bằng chạy riêng package đó; nếu flaky thật → **sửa gốc** (nới timeout), KHÔNG retry-cho-tới-khi-xanh.
- Thêm dep workspace mới → `pnpm install` trước khi build.

## 4. Quy ước flag & kiến trúc
- Thay đổi hành vi → giấu sau flag trong `runtime/flags.ts` (`AGENCY_PROFILE=legacy|hardened`; **legacy giữ hành vi cũ byte-identical**; risky = off-legacy/on-hardened; tốn-kém = opt-in off cả hai như `verifyTests`/`traceRecord`). Hiện **27 flag**.
- Tính năng thuần additive (command/tool mới, không đổi path cũ) → KHÔNG cần flag.
- Tránh import cycle: package phụ thuộc KHÔNG import flags từ core (dùng tham số/setter). Thêm cross-package dep → verify package đích là leaf/không tạo vòng. (Vd: cli đã khai `@agency/telemetry` leaf cho `replay-regression`.)
- Docs lịch sử `PRODUCTION_AUDIT*` = point-in-time → KHÔNG sửa. Chỉ cập nhật living docs (HARDENING_HANDOFF / ROADMAP / PACKAGES / CORE_ENGINE / CLI_REFERENCE / TESTING / **SESSION_HANDOFF_PROMPT**).

## 5. Nhịp mỗi slice (lặp lại)
investigate (đọc + grep) → phân loại (trùng thật vs distinct; wire vs delete) → thay đổi **tối thiểu, behavior-preserving, tái dùng canonical home** → thêm/cập nhật test → `pnpm verify` XANH → sync living docs (+ thêm row vào "Canonical Homes" nếu có nhà mới) → commit trên `master` (cây phải sạch) → cập nhật `memory/` + git chain trong MEMORY.md.

- Commit nhỏ từng slice; KHÔNG amend; KHÔNG `--no-verify`. Message kết bằng:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## 6. Trạng thái hiện tại & việc tiếp theo (xác nhận lại bằng docs/memory)
- Đã xong: P0+P1, audit gaps (B–F), §2.3 compaction, §2.4 tool layer (`ast_edit` + parallel an toàn), §2.5 **record producer** (`AGENCY_TRACE_RECORD` → `.agency/traces/`) **+ driver `agency replay-regression`**. Wired-or-dead đóng 100% (gồm mở rộng ngoài index). Các slice gần nhất: **emit cognition đủ 5 điểm** (routing/safety/reroute/verify-self-heal/compaction, cờ `AGENCY_COGNITION_STREAM`); **3 guard wiring** (skills/agents/flags, xem §2); **dedup**: gộp `ChatMessage` về providers, quét sạch const/type; **`agency doctor`** validate pack đã cài; **eval THẬT (BYOK)**: thêm bài counter-conventional `hard-merge-intervals` → **chứng minh verify-loop tự-sửa lỗi model end-to-end lần đầu** (hardened `rounds=2`, xem `EVAL_RESULTS.md` mục 2026-06-01). Git HEAD ≈ `fa41c3e` trên `master`, cây sạch. **26 flag.**
- **§2.5 LLM-response recording ĐÃ WIRE (2026-06-01, cont'd 18):** trace giờ ghi cả **LLM completion mỗi vòng** (`llmResponses` optional trên `DeterministicExecutionTrace`, tái dùng `ActiveTelemetryTracker`/`ReplayEngine`/`runRegressionReplay`/`SessionTraceRecorder` — KHÔNG machinery mới). `ReplayEngine.interceptLlmResponse(text)` (positional, mirror `interceptToolCall`) + `getUnconsumedLlmCount()`; `runRegressionReplay` + lệnh `agency replay-regression` giờ kiểm cả completion (drift nội dung/thiếu/thừa = exit≠0). Gate bằng cờ sẵn có `AGENCY_TRACE_RECORD` (off = recorder null = byte-identical; trace cũ không có field vẫn load). telemetry 4→9 / benchmark 14→18 / cli 565→568, ~2018.
- **Memory professionalism pass (2026-06-01, cont'd 19):** 3 slice (đều verify-green + commit) — (1) `0fe6371` **fix recall đa-session CLI CHẾT** (`resolveSessionId` rơi về hằng `"sess-cli"` → mọi run đụng 1 id → lọc `session_id != current` loại sạch episode CLI cũ) bằng id duy nhất per-process + thay raw `(db as any).db` bằng typed `recentEpisodesAcrossSessions` + char-budget; (2) `ffd0ae8` **wire `HybridRetriever` đang ngủ** (0 consumer live vì thiếu embedder) + `LocalDeterministicEmbedder` (feature-hashing offline/deterministic, sau interface `Embedder`), write-path embed episode→vector + read-path recall qua HybridRetriever, cờ MỚI `AGENCY_MEMORY_SEMANTIC` (off legacy/on hardened), `HybridRetriever` expose `source` (generic, giữ format episode); (3) `b42e82d` **compaction bound + chunk** (`summarizeMiddle` ≤ `maxInputChars`, chia chunk + gộp phân tầng → prompt tóm tắt không tự tràn). Git HEAD ≈ `b42e82d`, cây sạch. **27 flag.** ~2018→~2026.
- **§2.5 re-execution + running-summary ĐÃ XONG (2026-06-01, cont'd 20):** `20021fb` (re-execution lõi an toàn: `agency replay-regression --reexecute` re-derive tool-call từ `llmResponses` qua `parseToolCalls` THẬT, đối chiếu `toolOutputs`, drift→exit 1; KHÔNG side-effect; cli 568→571) + `19cf875` (running-summary xuyên lượt: `compactTurnHistory` nhận `cacheKey`=sessionId, lượt sau chỉ tóm turn MỚI gộp summary cũ, O(new); no cacheKey→byte-identical; core 343→344). **§2.5 đóng end-to-end; compaction = bound+chunk+incremental.** Git HEAD ≈ `19cf875`, ~2030, **27 flag**.
- **NEXT (backlog không-cần-key đã RỖNG):** (a) **promote `hardened`→default** — đích cuối, nhưng flip nhiều default hành vi cho MỌI user → cần (i) eval delta sạch (BYOK key, corpus model không one-shot) + (ii) user đồng ý rõ ràng; **KHÔNG tự flip default**; (b) §2.4 typed tool-result — **cố ý hoãn** (tool result đã truncate thông minh + LLM đọc text → typed là surface cao, lợi biên); (c) full live `ReplayProvider` re-run (surface cao: chặn tool-exec+gate+episode — để ngỏ).
- **Cần BYOK key (user cấp):** đo lại legacy↔hardened `agency eval --agent --suite hard --provider nvidia` để có rate-delta sạch (cần bài model fail attempt-1 ỔN ĐỊNH hoặc model yếu hơn) → rồi **promote `hardened`→default**.

### 6.1. Xử lý BYOK key AN TOÀN (nếu user cấp key để đo eval)
- **TUYỆT ĐỐI không ghi key thật xuống đĩa** (config/log/git/memory/docs). Cách đã dùng & verify sạch:
  1. backup `~/.agency/config.json` ra file tạm; đổi CHỈ `providers.nvidia.apiKey` thành placeholder `"${NVIDIA_API_KEY}"` (loader `resolveApiKey` nội suy `${VAR}` từ env).
  2. Đặt `trap 'cp "$BAK" "$CFG"; rm -f "$BAK"' EXIT` trong **cùng một** lệnh bash → config LUÔN khôi phục dù eval lỗi (env không persist giữa các lệnh bash → restore phải nằm trong cùng call).
  3. Truyền key qua env per-command: `NVIDIA_API_KEY=<key> AGENCY_PROFILE=… node packages/cli/dist/index.js eval --agent --suite hard --provider nvidia --baseline .agency/eval-baseline-hard.json [--update-baseline]`.
  4. Sau khi xong: xác nhận config khôi phục literal gốc (KHÔNG còn placeholder) + `grep -rn "nvapi-" packages docs` = RỖNG + xóa temp. Baseline `.agency/*` gitignored → không commit.
- Chạy legacy (`--update-baseline`) rồi hardened (gate vs baseline). Đọc `report.results[]` (`--json`) để xem **per-task `rounds`** — `rounds>1` ở hardened = verify-loop đã kích hoạt + tự sửa (đó là tín hiệu giá trị, không chỉ success rate).

## 7. Cấm kỵ
- Không xóa/sửa khi chưa grep xác nhận 0 live importer — **quét CẢ `.ts` + `.tsx`** (đừng để false-dead như `semantic-orchestration.ts`).
- Không gộp các cặp "trùng tên cố ý" (mục 1).
- Không assert "green"; không commit khi `pnpm verify` chưa xanh.
- Không tạo file/tool/command trùng chức năng đã có — luôn tra "Canonical Homes" trước.

**Bắt đầu:** đọc mục 0 → chạy quét trùng (mục 1) → nêu rõ slice bạn chọn + lý do "không trùng + nối dây thật" → thực thi theo nhịp mục 5.
