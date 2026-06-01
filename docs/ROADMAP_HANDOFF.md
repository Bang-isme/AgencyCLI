# AgencyCLI — Roadmap to a Real Harness (Plan Handoff)

> **Mục đích.** Tài liệu này vạch đường đi từ "không sập" (hardening hiện tại) đến
> một **harness thật sự**: chạy trơn tru, tự kiểm chứng, đo được độ tin cậy, và
> đáng tin để chạy không người trông. Đây là **kế hoạch**, chưa phải việc đã làm.
> Companion: [HARDENING_HANDOFF.md](HARDENING_HANDOFF.md) (việc P0/P1 đã xong),
> [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) (gap matrix), `agencycli-production-hardening` (memory).
> Tạo: 2026-05-30.

---

## 0. Khung tư duy — "không sập" ≠ "harness thật sự"

Thang trưởng thành 6 bậc. Toàn bộ hardening vừa rồi nằm ở **bậc 1**. Cái gọi là
"harness thật" là **bậc 3→4**: không chỉ *chạy* mà *hoàn thành đúng và tự sửa khi sai*.

| Bậc | Trạng thái | Hiện tại |
|---|---|---|
| 1 | **Không sập** — không crash, có giới hạn an toàn | ✅ gần xong (P0+P1) |
| 2 | **Phục hồi được** — crash thì tự khôi phục, không mất việc | ✅ xong (auto-resume + crash-loop guard, 2026-05-30) |
| 3 | **Hoàn thành việc đơn giản đúng** | 🟡 sắp đo được (chạy `agency eval --agent`) |
| 4 | **Tự kiểm chứng & tự sửa** — biết mình sai và sửa tới khi đạt | 🟡 verify loop (cả 2 nhánh edit) + acceptance build/lint/test (2026-05-30); còn: test-liên-quan |
| 5 | **Đo được độ tin cậy** — biết tỉ lệ thành công bao nhiêu % | 🟡 khung đo + regression gate đã có (2026-05-30); chưa đo corpus thật |
| 6 | **Đáng tin chạy không người trông** hàng giờ/ngày | ❌ mục tiêu cuối |

Nguyên tắc xuyên suốt (kế thừa từ hardening): **"wire before you build"** + mọi thay
đổi hành vi đều có cờ trong `packages/core/src/runtime/flags.ts` (off legacy / on hardened),
warn trước enforce, không bao giờ để infra làm sập host, mỗi hành vi mới có test riêng.

---

## 1. Hoàn tất hardening còn lại (bậc 1 → 2)

Các hạng mục audit còn dư. Đóng nốt để nền móng vững trước khi xây harness.

### (B) Gắn thông tin truy vết vào sự kiện  ← ✅ GẦN XONG (2026-05-30)
- **Vấn đề:** `EventBus.publish` hầu hết gọi 2 tham số; phần `meta`
  (`agentId/taskId/durationMs/costUsd`) đã có plumbing (slice 4) nhưng chưa ai truyền.
- **Đã làm:** `dispatchAgent` truyền `meta` cho lifecycle: `started`/`routed` → `agentId`;
  `finished`/`error` → `agentId` + `durationMs` + **`costUsd`** (ước lượng từ
  `completionMetadata.{promptTokens,completionTokens}` qua `CostGovernor.estimateCost()` — đã mở
  public, pure, không trừ budget). Các cột attribution trong `EventJournal` giờ được populate.
- **Còn lại (nhỏ):** `taskId` khi có id task ổn định luồn qua dispatch. Turn chính (không phải
  subagent) đã ghi cost qua `globalCostGovernor.recordTokens` + hiện ở `agency status`.
- **Lợi:** forensics — biết agent/chi phí/thời lượng khi đọc log. **Không cần cờ mới.**
- **Mở khóa:** đây là nền cho observability (Phần 4) và eval (Phần 3).

### (TUI) Sửa freeze loading/đếm giây khi subagent chạy  ← ✅ XONG (2026-05-30)
- **Triệu chứng:** subagent đang stream thì spinner + bộ đếm giây của loading **chính** (và cả
  loader subagent) đứng hình; chỉ nhảy số khi bấm phím (Ctrl+O) → event loop bị bỏ đói, không
  phải lỗi state.
- **Nguyên nhân:** `dispatchAgent` publish `subagent:progress` **mỗi token** kèm **toàn bộ** text
  tích luỹ → `EventBus.publish` `JSON.stringify`+`sha256` toàn payload (O(n²)); khi payload vượt
  8KB còn `writeFileSync` **đồng bộ** mỗi token → block loop → mọi re-render theo timer (frame
  clock + `ToolActivity` `setInterval` 200ms) đứng tới khi có keypress.
- **Sửa:** (1) throttle progress ≥200ms + payload kích thước hằng (bỏ buffer vô hạn, bỏ
  `thought:journal` thừa); (2) `EventBus` spill large-payload sang **async** off hot path. Test:
  `event-bus.test.ts`, `agents-orchestrator.test.ts`. Đây là bài học "infra không bao giờ chặn host"
  áp cho cả tầng TUI.
- **Mượt hoá (follow-up):** hết freeze rồi nhưng đếm giây vẫn giật ~1–3s. Nguyên nhân: App re-flush
  cả mảng `subagents` mỗi giây (heartbeat) chỉ để nhích số → re-render toàn App + ghi frame ConPTY/giây.
  Sửa: thêm `spawnTs` vào `SubagentStatus`; các bộ đếm **tự tick trong leaf** (`LiveElapsed`/500ms ở
  `SubagentPanel`, bộ đếm worker ở `ToolActivity` cưỡi timer 200ms sẵn có); **bỏ heartbeat 1s** + sàn
  `setSubagents` lên 250ms (4Hz) vì elapsed đã tách. → ít re-render/ghi ConPTY hơn hẳn khi subagent chạy.
  **Lag còn lại là nội tại** (ConPTY Windows vẽ lại full-frame + vài op đồng bộ trong dispatch:
  `safeAddEpisode` SQLite, `buildIndex/writeIndex` re-index — ứng viên offload worker-thread sau).

### (TUI) Không bao giờ "văng ra shell"  ← ✅ XONG (2026-05-30)
- **Triệu chứng:** đang dùng TUI tự rơi về dòng lệnh shell thật dưới khung chat; gõ được nhưng chạy thì
  lỗi = process TUI **thoát đột ngột**, để lại frame cũ trên màn shell.
- **3 đường thoát đều bịt:** (1) `screen.ts` handler `uncaughtException`/`unhandledRejection` trước
  đây `process.exit(1)` mỗi khi có rejection lạc → giờ **non-fatal** (log `.agency/crash.log` + banner
  qua hook `onAgencyRuntimeError`, **không rời alt-screen, không exit**); (2) lỗi throw lúc render React
  unmount cả cây → Ink `waitUntilExit` resolve → launcher exit → thêm `AppErrorBoundary` (bọc ngoài
  cùng ở `index.ts`) giữ cây sống, fallback + auto-retry 3 lần; (3) `EventBus.publish` guard
  `JSON.stringify` (payload circular/BigInt) → **không bao giờ reject**. Test: `error-boundary.test.tsx`,
  `event-bus.test.ts`. Chỉ SIGINT/Ctrl+C + thoát chủ ý mới khôi phục terminal.

### (F) Auto-resume thật sự — hoàn tất bậc 2  ← ✅ XONG (2026-05-30)
- **Đã làm:** `autoResumeRecoverableTasks()` (`runtime/bootstrap.ts`, export từ core): flag-gated
  (`autoRecover`, off→no-op nên legacy nguyên trạng). Chỉ resume checkpoint `running` (run *chết*
  giữa chừng) qua `runPlan(projectRoot, planPath, {taskId})`; task `paused` là cố ý → để resume thủ công.
  **Bộ đếm crash-loop** ở `.agency/resume/<id>.json` (thư mục riêng để `listCheckpoints` không parse nhầm),
  tăng **trước** khi chạy → crash giữa lúc resume vẫn được đếm; quá `maxCrashLoops` (`AGENCY_MAX_CRASH_LOOPS`,
  mặc định 3) → bỏ (`task:resume-abandoned`, báo người) thay vì lặp vô hạn; `done` thì xoá counter.
  Emit `task:resume-start|finished|error|abandoned`. Wired vào `cli/commands/chat.ts` (autoRecover on →
  tự resume + báo kết quả). Test: `auto-resume.test.ts` (4). **Hoàn tất bậc 2 "phục hồi được".**
- **Cờ:** `AGENCY_AUTO_RECOVER` (off legacy / on hardened).

### (D) Phát hiện chu trình DAG tĩnh + version checkpoint  ← ✅ XONG (2026-05-30)
- **Cycle:** `detectDagCycle()` (`task/runner.ts`, export) — DFS lặp, trả về đường cycle hoặc `null`;
  `runPlan` chạy trên DAG đã nén **trước khi schedule**, throw `PlanCycleError` (+ emit `task:plan-cycle`)
  thay vì để scheduler deadlock im lặng. Luôn bật (cycle không bao giờ hợp lệ).
- **Checkpoint integrity:** thêm field `checksum` vào `TaskCheckpoint`; `saveCheckpoint` niêm SHA-256 (bỏ
  checksum cũ trước khi tính, compact stringify nên không phụ thuộc pretty-print); `loadCheckpoint` tính lại
  + so. Checkpoint cũ (không checksum) bỏ qua kiểm → vẫn load. Lệch → luôn `system:warning`; với cờ
  `checkpointStrict` (`AGENCY_CHECKPOINT_STRICT`, warn legacy / reject hardened) trả `null` thay vì đọc
  half-state hỏng. Test: `dag-checkpoint-integrity.test.ts` (7).

### (C) Rollback nhiều file nguyên tử (atomic)  ← ✅ XONG (2026-05-30)
- `mutation-journal.ts` (workspace): `commitMutationsAtomic()` ghi before/after mọi file ra
  **`.agency/mutations/<txId>.json`** (thư mục riêng, không phải `.agency/tasks` để khỏi bị
  `listCheckpoints` parse nhầm) status `committing` TRƯỚC khi ghi, áp dụng từng file, lỗi → rollback inline.
  `StagingEngine.commitTransactionAtomic()` lái nó; `recoverPendingMutations()` (gọi ở `bootstrapRuntime`,
  gated `atomicRollback`, emit `recovery:mutation-rolled-back`) undo commit dở khi crash. `dispatchAgent`
  dùng bản atomic khi cờ on. Cờ `AGENCY_ATOMIC_ROLLBACK`. Test: `mutation-journal.test.ts` (5).

### (E) Quét bí mật khi ghi nhớ (secret-on-persist)  ← ✅ XONG (2026-05-30)
- `addEpisode` **redact** secret trong content (`IngestionPipeline.redactSecrets`, dùng lại `SECRET_PATTERNS`);
  `insertVector` **cách ly** vector chứa secret vào `quarantined_vectors` thay vì store sống. Gated qua
  toggle `setSecretScanEnabled()` (`memory/secret-policy.ts`) do `bootstrapRuntime` set từ `flags.secretScan`
  (memory không import core flags được — vòng lặp). Cờ `AGENCY_SECRET_SCAN`. Test: `secret-on-persist.test.ts` (4).

### Extras (audit §2 còn nhắc)
- Phát hiện vòng lặp dispatch chéo ở tầm orchestrator (bổ sung cho depth/hop/cycle guard hiện có).
- Health monitor định kỳ cho tools/MCP/plugins.
- Hệ thống artifact đầy đủ (id/owner/version).

---

## 2. Biến nó thành harness thật (bậc 3 → 4) — **phần quan trọng nhất**

Phần 1 làm nó *bền*. Phần này làm nó *giỏi*. Hiện `dispatchAgent` chạy **1 lượt LLM**
(maxLoops 15) → parse sửa file → build thử → commit. Vấn đề cốt lõi:
**"build pass" ≠ "task làm đúng"**. Cần:

### 2.1 — Vòng lặp ngoài có kiểm chứng (verify loop)  ← 🟡 ĐÃ BẮT ĐẦU (2026-05-30)
- **Đã làm:** engine `runVerifyLoop(attempt, verify, opts)` (`core/src/task/verify-loop.ts`, export):
  *attempt → verify → (sai) feed lỗi vào vòng sau → tới khi đạt / hết round / hết budget / no-progress*.
  Wired vào nhánh suggestions của `dispatchAgent`: cờ off → `maxRounds=1` (1 lượt, y hệt legacy); on →
  re-run LLM với lỗi build feed lại (cờ `AGENCY_VERIFY_LOOP`/`AGENCY_VERIFY_MAX_ROUNDS=3`). Test:
  `verify-loop.test.ts` (6) + integration trong `agents-orchestrator.test.ts` (re-run & tự sửa).
- **Acceptance đã mở rộng (2026-05-30):** `buildAcceptanceCommands()` (`utils/package-manager.ts`) ráp
  **build (luôn) + lint + test** — chỉ thêm khi script tồn tại trong package.json (bỏ qua test placeholder
  của npm), gated `AGENCY_VERIFY_LINT` (off legacy / on hardened) + `AGENCY_VERIFY_TESTS` (opt-in, off cả
  hai vì chạy full suite tốn). Lint/test fail → verify fail → vòng tự sửa. Test: `acceptance-commands.test.ts` (6).
- **Nhánh XML tool-call cũng đã wire (2026-05-30):** file ghi thẳng đĩa (không staging) → `validateWithHeal`
  chạy acceptance trong workspace, fail thì re-run LLM (agent sửa qua tool) feed lỗi, tới khi đạt/hết round.
  Legacy = build-only 1 lượt → throw. Test integration trong `agents-orchestrator.test.ts`.
- **Còn lại:** "test liên quan" (scoped theo file đổi, không phải full suite) + tín hiệu "đạt mục tiêu task"
  khách quan hơn build/lint/test.

### 2.2 — Phát hiện hoàn thành (completion detection)  ← 🟡 một phần (2026-05-30)
- Engine đã có: đạt tiêu chí → dừng (`passed`); **không tiến triển (lỗi lặp) sau N vòng → dừng**
  (`no-progress`); hết round (`max-rounds`); hết budget (`budget-exhausted`).
- **Còn lại:** tín hiệu "đạt mục tiêu task" khách quan hơn build (gắn với 2.1 còn lại).

### 2.3 — Quản lý context window (compaction)  ← ✅ XONG (2026-05-31)
- Hội thoại/task dài sẽ tràn context window. Cần nén lịch sử (tóm tắt lượt cũ, giữ phần
  quan trọng + tiêu chí task) khi gần đầy. Không có → task dài vỡ giữa chừng.
- **Đã wire.** `SessionConversationManager.summarizeHistory` từng **xây-mà-chưa-nối-dây** (0 call site) *và*
  viết cho **API provider MA** (`complete({messages})→{text}`, khác `LlmProvider.complete(messages,opts)→string`
  thật → luôn rơi fallback). Sửa: helper thuần `compactTurnHistory()` (`chat/turn-helpers.ts`, API thật, giữ
  system + 4 lượt cuối nguyên văn, tóm tắt phần giữa, fallback khi provider lỗi/null, KHÔNG ném) chạy trong CẢ
  `runChatTurn` + `runChatTurnWithStream` ngay trước khi gửi model, gate cờ `AGENCY_CONTEXT_COMPACTION`
  (off legacy/on hardened). Test
  `context-compaction.test.ts` (5). Commit `b9f33e9`. *Follow-up:* nén 1 lần trước outer tool-loop —
  in-loop compaction là bước sau; reactive context-limit handler vẫn là lưới an toàn.
- **Dọn dẹp sau đó (2026-05-31, cont'd 2):** vỏ `SessionConversationManager` (đã ủy quyền compaction cho
  `compactTurnHistory`, phần JSONL persistence trùng với TUI `sessions/store.ts` live) là dead-duplicate
  0 call-site → **đã xóa** cùng `DomainSpecialistRegistry`. Compaction live giờ CHỈ nằm ở
  `compactTurnHistory` (không còn lớp delegate trung gian).

### 2.4 — Tầng tool chắc hơn  ← 🟡 PHẦN LỚN ĐÃ CÓ (2026-05-31)
- **Sửa file diff/patch chính xác — ĐÃ WIRE.** `ast-compiler` (`utils/`, AST TypeScript THẬT — `ts.createSourceFile`, không regex) trước chỉ dùng nhẹ ở `approval-policy-engine` (risk-sim), CHƯA là tool model gọi được. Giờ phơi thành tool **`ast_edit`** (`skill/tool-harness.ts`): `rename_symbol` / `replace_function_body` / `replace_method_body` / `modify_import` / `delete_node` / `insert_function` — tái dùng nguyên các hàm ast-compiler (không nhân đôi logic edit), bổ sung cho `edit_file` (text replace) chứ không thay. Auto-quảng bá cho model qua `registry.listTools()` → `buildSystemPrompt` (không cần sửa prompt cứng). Approval-gated (category write). Test: `tool-harness.test.ts` (+5).
- **Gọi nhiều tool song song — ĐÃ CÓ + AN TOÀN.** Cả `runChatTurn` lẫn `runChatTurnWithStream` đã `Promise.all(toolCalls.map(...))`. Đã kiểm: handler ghi file (`write_file`/`edit_file`/`ast_edit`) là read-modify-write **đồng bộ KHÔNG `await` xen giữa** → Node đơn luồng = critical section atomic, KHÔNG race. Không cần "serialize dependent" (sẽ là sửa bug-không-tồn-tại).
- **Cắt ngắn thông minh — ĐÃ CÓ.** `truncateToolResult` đã scale theo context-window model (8K→16K aggressive, ≥200K rộng tay, medium ~20% window). *Còn lại nếu muốn:* kết quả tool có cấu trúc (typed) thay vì string thuần — giá trị biên, để sau.

### 2.5 — Dùng Replay để tự kiểm  ← 🟡 NỀN MÓNG ĐÃ WIRE (2026-05-31)
- Đã có `ReplayEngine` + `DeterministicClock/Entropy`. Tận dụng để **chạy lại phiên cũ và xác
  nhận ra kết quả y hệt** → nền cho test hồi quy ở **cấp hành vi**, không chỉ cấp unit.
- **ĐÃ WIRE (nền móng):** primitive thuần `verifyJournalReplay(events)` (TÁI DÙNG `ReplayEngine`,
  không impl hash thứ 2) + `replaySessionJournal(projectRoot)` (load journal bền qua
  `EventJournal.readEvents()`) + lệnh **`agency replay [--json]`**. Chạy lại `.agency/events/journal.db`
  và phát hiện event có payload không còn khớp `payloadHash` đã lưu (corrupt/tamper on-disk — cùng họ
  "làm hỏng-hóc quan sát được" với fix checkpoint-integrity). *Chi tiết đúng:* EventBus hash payload lớn
  trên bản GỐC nhưng lưu spill-ref nhỏ inline → replay ngây thơ sẽ false-positive; `verifyJournalReplay`
  nhận diện spill-ref và đếm `skipped` (trung thực về độ phủ), KHÔNG coi là fail. Thuần additive (lệnh
  mới, không đổi path cũ → legacy ≡ hardened, không cờ). Test: `replay-journal.test.ts` (+6) +
  `cli/replay.test.ts` (+3). `pnpm verify` xanh (core 342, cli 550, ~1996).
- **RECORD producer ĐÃ WIRE (2026-05-31).** Machinery record/replay cấp-hành-vi ĐÃ CÓ ở `telemetry`
  (`ActiveTelemetryTracker` ghi turn-timings + tool I/O → `DeterministicExecutionTrace`; `ReplayEngine`
  `interceptToolCall` fuzzy-match recorded outputs, throw "[Replay Deviation]" khi lệch) + consumer
  `benchmark.runRegressionReplay` — NHƯNG **0 producer live** (chỉ test sinh trace). Đã wire: `SessionTraceRecorder`
  + `createTraceRecorder` (`chat/trace-recorder.ts`, TÁI DÙNG `ActiveTelemetryTracker` — không impl mới) cắm
  vào CẢ `runChatTurn` + `runChatTurnWithStream` (hook null-safe: recordTool sau mỗi `executeTool`,
  recordTurn + save cuối lượt) → ghi `.agency/traces/<sessionId>.json`. Cờ `AGENCY_TRACE_RECORD` opt-in
  (off cả 2 profile — có overhead per-tool; off = recorder null = byte-identical). core thêm dep
  `@agency/telemetry` (leaf, 0 dep → không cycle). Test: `trace-recorder.test.ts` (+3).
- **Còn lại (full §2.5):** lệnh replay-regression (`agency` chạy `runRegressionReplay` trên trace đã ghi) +
  re-execute agent thật (cần ghi thêm LLM response — trace hiện chỉ có tool I/O + timings). Xây TRÊN
  producer + consumer sẵn có — không nhân đôi.

---

## 3. Đo lường & chứng minh độ tin cậy (bậc 5)  ← 🟡 ĐÃ BẮT ĐẦU (2026-05-30)

**Trả lời trực tiếp "làm sao biết đã đáng tin".** Không đo thì "ổn định" chỉ là cảm tính.

**Đã làm — khung đo + regression gate (`packages/benchmark`):**
- `BenchmarkTask` thêm bước **`execute`** (agent attempt, injectable) → `runBenchmarkTask` giờ chạy
  setup→**execute**→validate, kết quả phản ánh việc *agent* làm (rounds/cost/intervened), không chỉ
  validate state có sẵn.
- `metrics.ts` `aggregateResults()` → `EvalReport`: **task success rate**, avg time/cost/rounds,
  **intervention rate**, theo category. `formatEvalReport()`, `estimateTokenCost()`.
- `eval-gate.ts` `gateAgainstBaseline()` + `loadBaseline`/`saveBaseline`: fail nếu success rate tụt quá
  tolerance HOẶC task từng pass nay fail. Đây là "biến 'tôi nghĩ tốt hơn' thành 'không tệ hơn'".
- Corpus agent-backed: `addBugfixTask` (state hỏng `add` trừ thay vì cộng, acceptance chạy test thật).
- Lệnh **`agency eval`** (`cli/commands/eval.ts`): suite→aggregate→report→gate vs baseline,
  `--update-baseline`, `--agent` gắn runtime thật, exit code theo gate. Mặc định chạy smoke deterministic.
- Test: `benchmark/__tests__/eval-harness.test.ts` (7). Đã chạy `agency eval --json` e2e OK.

**Corpus agent-backed (2026-05-30):** `agentEvalTasks` = 3 bài qua helper chung `makeNodeTask` (không
trùng boilerplate): `fix-add-bug` (bugfix), `impl-multiply` (feature), `fix-clamp-bug` (bugfix) — state
khởi đầu hỏng/thiếu, acceptance chạy `node test.cjs` thật. Đã verify cả 3 **giải được khi code đúng**
(test chuẩn, đo đúng năng lực agent).

**Workflow đo baseline (BYOK — cần key của bạn):**
```bash
# Tạo baseline (legacy = hành vi hiện tại):
agency eval --agent --provider <prov> --update-baseline
# Tạo baseline hardened để so sánh:
AGENCY_PROFILE=hardened agency eval --agent --provider <prov> --update-baseline --baseline .agency/eval-hardened.json
# Sau đó mỗi thay đổi: agency eval --agent --provider <prov>  (exit≠0 nếu success rate tụt)
```
Baseline lưu `.agency/eval-baseline.json` → commit vào repo → bật gate CI. *(Sandbox này: openrouter key
hết hạn, google rate-limit; nvidia chạy được — nên đo thật tốt nhất chạy trên máy bạn.)*

- **Còn lại:** chạy đo thật trên nhiều bài hơn → commit baseline → gate CI. (Cũ) `regression.ts`
  (replay-regression) vẫn là lớp khác, giữ nguyên.

---

## 4. Vận hành & quan sát (bậc 6)

- **Observability:** `agency status` đã tốt; thêm trace theo task xuyên suốt (nhờ B), và
  `agency handover` đã có để bàn giao trạng thái.
- **Bảng sức khỏe:** agent nào hay lỗi (registry health từ slice 5 đã làm), MCP nào hay timeout,
  memory phình tới đâu (telemetry đã có).
- **Cảnh báo:** vượt budget, crash-loop, tỉ lệ lỗi tăng đột biến.
- **Chế độ "chạy dài":** kiểm thử thực tế chạy nhiều giờ unattended mà vẫn bám checkpoint,
  không rò bộ nhớ, không phình DB (memory GC slice 1 lo phần này).

---

## 5. "Ổn định rồi thì chuyện gì xảy ra tiếp?"

**Ổn định là điều kiện cần, không phải đích đến.** Trình tự tự nhiên khi đã ổn định (bậc 1–2):

1. **Lộ ra câu hỏi "nó có làm ĐÚNG không?"** — Hết bận chữa crash, bạn nhận ra mình *không
   biết* tỉ lệ thành công thật. → Bắt buộc xây eval (Phần 3). Gần như chắc chắn là việc kế tiếp.
2. **Áp lực dồn sang chất lượng vòng lặp** — "Chạy đến cùng một kết quả SAI" còn tệ hơn crash
   (vì tưởng nó xong). → Cần verify loop + self-correction (Phần 2).
3. **Tham vọng tăng dần** — task dài hơn, repo lớn hơn, nhiều agent song song hơn. Mỗi nấc lộ
   giới hạn mới: context tràn, chi phí tăng, phối hợp đa-agent rối. → compaction, governance, loop detection.
4. **Niềm tin được trao dần** — đích cuối: dám *rời tay* để nó chạy hàng giờ/ngày. Niềm tin đó
   đến từ **số liệu** (success rate cao + ổn định qua nhiều lần đo), không từ "lần này thấy chạy ổn".

> **Tóm:** ổn định → đo lường → nâng chất lượng làm việc → mở rộng quy mô → được tin tưởng tự chủ.
> Hiện đang ở **cuối "ổn định"** (bậc 1+2 xong: không sập + phục hồi được). Bước kế tiếp tự nhiên là
> **đo lường** — vá nốt vài rủi ro audit ((D)/(C)/(E)) rồi xây **eval harness** (Phần 3, bước ngoặt).

---

## 6. Thứ tự khuyến nghị  (cập nhật 2026-05-30)

1. ~~**B (event attribution)**~~ ✅ · ~~**D (DAG cycle + checkpoint integrity)**~~ ✅ · ~~**F (auto-resume)**~~ ✅
   · ~~**C (atomic rollback)**~~ ✅ · ~~**E (secret-on-persist)**~~ ✅ — **TẤT CẢ gap audit hardening đã đóng.**
2. ~~**Phần 3 (eval harness)**~~ 🟡 ĐÃ BẮT ĐẦU — khung đo (execute step + `aggregateResults` + regression
   gate `gateAgainstBaseline` + lệnh `agency eval`) đã có & test. **▶ NEXT trong Phần 3:** mở rộng corpus
   agent-backed đa dạng + chạy `agency eval --agent` đo thật + commit baseline + bật gate CI.
3. ~~**Phần 2.1 verify loop**~~ 🟡 ĐÃ BẮT ĐẦU — engine `runVerifyLoop` + `dispatchAgent` self-correct cho **cả 2
   nhánh edit** (SEARCH/REPLACE + XML tool-call), acceptance = **build + lint + (opt-in) test**. **▶ NEXT
   trong Phần 2:** "test liên quan" (scoped theo file đổi); (c) **2.3 compaction** (nén context task dài).
   Mỗi cải tiến giờ đo được qua `agency eval --agent`.

> **Đã xong ngoài kế hoạch (session 2026-05-30):** (1) 3 fix độ tin cậy TUI — freeze khi subagent stream,
> đếm giây giật, và "văng ra shell" (xem mục (TUI) ở Phần 1 + HARDENING_HANDOFF §7). (2) **Model catalog
> (BYOK):** cắm `models.json` (~5k model) vào `getModelSpec` + cost governor → giới hạn/chi phí/khả năng
> chính xác cho *bất kỳ* model người dùng mang; cờ `AGENCY_MODEL_CATALOG`. Việc này làm **đúng metric chi
> phí của eval (Phần 3) + costUsd attribution (B)** vốn đang dùng bảng giá hardcode sai. Bộ khớp model dùng
> chung (`matchModelKey`) — không nhân đôi logic.

Mục 4 và 5 đi đôi: làm eval trước, rồi mỗi cải tiến vòng lặp đều được số liệu kiểm chứng.

---

## 7. Trạng thái git / commit ✅ (2026-05-31)
- Nhánh: **`master`** (nhánh PR chính là `main`). Repo trước đây **0 commit**; giờ có lịch sử thật,
  **tree sạch**: `0d216b9`(init/recovery, 981 file) → `656498d`(fix memory observability) →
  `1cb58c1`(verify gate + CI) → `b9f33e9`(§2.3 compaction). Chi tiết: HARDENING_HANDOFF.md §6.
- **Quy tắc: chạy `pnpm verify` (build+test cả 16 package) TRƯỚC khi claim green** — trị bệnh "xanh ảo"
  tái diễn của repo. Baseline đã tự verify: build 16/16, ~2001 test, exit 0 (core 350 · cli 547 · tui 115 …).
  Commit kết thúc message bằng trailer `Co-Authored-By`. CI kích hoạt khi có remote GitHub (hiện local-only).
- **Bắt đầu session sau:** đọc HARDENING_HANDOFF.md §5 (banner **LATEST** → git history + verify gate +
  §2.3 compaction + audit wired-or-dead; top pick = wire-or-delete 1 module dead, hoặc đo eval corpus khó hơn).
