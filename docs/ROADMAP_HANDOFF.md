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
- **ĐÃ CHỨNG MINH end-to-end trên model thật (2026-06-01):** thêm bài `hard-merge-intervals`
  (counter-conventional: interval chỉ CHẠM nhau KHÔNG merge → cần `<` strict, `<=` thường-dùng fail)
  → hardened ghi nhận **rounds=2** (attempt 1 fail acceptance → feed lỗi → attempt 2 pass) trên
  `minimaxai/minimax-m2.7`. Lần đầu verify-loop tự-sửa lỗi model THẬT ngoài integration test mock
  (trước đó luôn avg 1.0 = loop chưa từng kích hoạt). Chi tiết: [EVAL_RESULTS.md](EVAL_RESULTS.md).

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
- **Bound + chunk summarizer (2026-06-01, cont'd 19, commit `b42e82d`):** trước đây tóm tắt CẢ middle trong
  1 call cap 300 token → với task dài, **prompt tóm tắt có thể tự tràn** window (đúng lỗi compaction sinh ra để
  tránh) + 1 bản tóm tắt cho span vô hạn rất lossy. `summarizeMiddle` giờ bound mỗi call ≤ `maxInputChars`
  (default 8000): vừa → 1 call (như cũ); quá → chia chunk vừa budget, tóm từng chunk, rồi gộp phân tầng (cũng
  bound, fallback nối chuỗi). Prompt tóm tắt KHÔNG còn tràn được; case nhỏ thường gặp byte-identical; không
  bao giờ ném. Test `context-compaction.test.ts` (5→6).
- **Running-summary XUYÊN LƯỢT ĐÃ XONG (2026-06-01, cont'd 20, commit `19cf875`):** `compactTurnHistory` nhận
  `cacheKey` (session id); lượt sau mà middle chỉ MỞ RỘNG middle đã tóm trước → chỉ tóm phần MỚI gộp vào summary cũ
  → O(new) thay vì O(all). Prefix-validate theo scope (không phục vụ summary cũ/lệch); không cacheKey → không cache →
  byte-identical. Cả 2 turn path truyền `resolveSessionId`. Test `context-compaction.test.ts` (6→7).
- **IN-LOOP compaction ĐÃ XONG (2026-06-01, cont'd 21):** trước đây nén CHỈ 1 lần TRƯỚC outer tool-loop, nhưng
  `turnHistory` lớn dần BÊN TRONG loop (mỗi vòng nối assistant turn + tool results) còn reactive context-limit
  handler chỉ thu nhỏ *window* chứ không thu nhỏ *hội thoại* → loop dài vẫn có thể tràn giữa turn. Gom `if
  (contextCompaction){…}` inline thành 1 closure `compactIfEnabled()` (mỗi turn path) gọi **trước loop VÀ ở đầu mỗi
  vòng**; tái dùng `compactTurnHistory` canonical (không logic mới), `cacheKey` làm các lần nén in-loop incremental
  (O(new)), no-op dưới ngưỡng + byte-identical khi cờ off. **Không cờ mới.** Test mới `in-loop-compaction.test.ts`
  (+3: ON nén 1+2=3, OFF không nén). *Kèm:* gỡ một import cycle THẬT — `context/pack.ts` + `agents/orchestrator.ts`
  import `chat/orchestrator.ts` chỉ để lấy 2 helper thuần `formatRouteSummary`/`buildSuggestedCommands` (back-edge
  tầng-dưới→chat = vi phạm phân tầng + làm vỡ mock theo chu trình). Dời 2 helper sang leaf mới
  `chat/route-presentation.ts` (orchestrator re-export → consumer giữ nguyên path); behaviour-preserving. Cạnh còn
  lại `agents/orchestrator → stream → orchestrator` (dispatch chạy chat turn) là chu trình CHỨC NĂNG hợp lệ → giữ.
  **§2.3 giờ đóng trọn: bound+chunk + incremental running-summary + in-loop.**
- **Architecture cycle audit + guard (2026-06-01, cont'd 22):** Tarjan-SCC quét toàn `core/src` xác nhận chỉ còn 1
  cạnh vi phạm phân tầng sót (`chat/presentation.ts` → `chat/orchestrator.ts` lấy `buildSuggestedCommands` — consumer
  thứ 3 của helper đã dời, sót khỏi cont'd 21) → repoint sang leaf `route-presentation.ts`, SCC 8→7. Cụm 7-module còn
  lại là chu trình chức năng bất khả giản (turn↔tools↔dispatch↔turn + setup + gate) → giữ + khoá bằng guard mới
  `core/__tests__/architecture-cycles.test.ts` (fail nếu module ngoài set 7 lọt vào cycle). Guard thứ 4 (sau
  skills/agents/flags). core 347→348.

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
- **Lệnh replay-regression ĐÃ WIRE (2026-06-01).** Driver live cho regression engine: lệnh
  **`agency replay-regression [trace]`** (`cli/commands/replay-regression.ts`) lái
  `benchmark.runRegressionReplay` + `loadTraceFile` (TÁI DÙNG, không impl mới) trên trace đã ghi ở
  `.agency/traces/`. 2 chế độ: **validate** (1 trace → xác nhận well-formed + replay-ready, bắt
  corrupt/partial/non-trace) và **regression** (`--baseline <ref>` → replay tool-call của candidate trên
  recorded outputs của baseline; tool baseline chưa ghi `[Replay Deviation]` hoặc output baseline chưa
  tái hiện = drift → exit≠0). **KHÔNG cần LLM response** vì cả 2 run đã nằm trên đĩa. `--list` liệt kê
  trace. Thuần additive (lệnh mới → legacy≡hardened → KHÔNG cờ). Types lấy structural từ
  `runRegressionReplay` nhưng cli khai `@agency/telemetry` (leaf) để tsc resolve trace type — không cycle.
  Guard biên: pre-validate shape TRƯỚC khi vào `runRegressionReplay` (catch của nó gọi
  `getUnconsumedCount()`→`toolOutputs.length`, sẽ tự ném trên trace hỏng). Test: `replay-regression.test.ts`
  (+6: list / validate / non-trace-fail / match / drift / deviation). `pnpm verify` xanh (cli 550→556).
- **LLM-response recording ĐÃ WIRE (2026-06-01, cont'd 18).** Trace trước chỉ có tool I/O + timings → replay
  được *harness làm gì với lời model* nhưng KHÔNG có *chính lời đó*. Đã đóng bằng mở rộng machinery sẵn có
  (KHÔNG module/cờ mới): `DeterministicExecutionTrace.llmResponses?` **optional** (trace cũ vẫn load + replay,
  consumer cũ bỏ qua) + `recordLlmResponse` trên tracker/recorder, nối dây vào CẢ 2 turn path ngay sau
  `llmText += currentText` (off `AGENCY_TRACE_RECORD` → recorder null → byte-identical). `ReplayEngine`
  thêm `interceptLlmResponse(text)` (positional content-match — analogue của `interceptToolCall` arg-match;
  completion xếp theo turn) + `getUnconsumedLlmCount()`. `runRegressionReplay` + lệnh `agency replay-regression`
  giờ tái hiện + kiểm cả completion (drift nội dung/thiếu/thừa → `[Replay Deviation]`/unconsumed → exit≠0;
  `unconsumedLlmResponses` thêm vào result). `providerSeed` (đã có sẵn) chính là để re-run seeded ra completion
  y hệt. Test mở rộng tại chỗ: telemetry 4→9, benchmark 14→18, cli +3, core trace-recorder LLM round-trip.
  `pnpm verify` xanh (~2006→~2018). Dữ liệu LLM-response giờ ĐƯỢC DÙNG NGAY (driver tiêu thụ/kiểm — không treo).
- **Re-execution (nhân lõi AN TOÀN) ĐÃ WIRE (2026-06-01, cont'd 20, commit `20021fb`).** `agency replay-regression
  --reexecute`: re-derive chuỗi tool-call từ `llmResponses` đã ghi bằng `parseToolCalls` THẬT rồi đối chiếu
  `toolOutputs` (tool đã chạy) → regression ở parser/dispatch lộ ra (drift→exit 1). Deterministic + KHÔNG side-effect
  (không chạy tool/gate/episode). Tái dùng `parseToolCalls`, không nhân đôi. Test cli replay-regression (+3).
- **Còn lại (full live re-run, KHÔNG bắt buộc):** chạy lại `runChatTurn` THẬT qua `ReplayProvider` + seam intercept
  tool/gate/episode để re-run vòng turn thật với 0 LLM-call. Surface CAO (phải chặn cả tool-exec, gate, ghi episode)
  → giá trị biên so với re-execution lõi đã có; để ngỏ, KHÔNG xây vội.

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
- **Cognition stream (2026-06-01):** TUI CognitionPanel (`App.tsx` subscribe `thought:emitted`) trước đây
  **rỗng vĩnh viễn** — producer `emitThought` 0 caller (live-consumer/dead-producer). Đã wire `emitThought`
  tại 2 điểm quyết định: routing (`resolveRoute` dùng chung) + safety gating (approval hook). Cờ
  `AGENCY_COGNITION_STREAM` (off legacy/on hardened), gate tập trung trong `emitThought`.
  **Mở rộng emit (2026-06-01, cont'd 11) — ĐÃ WIRE 3 điểm còn lại** (đúng đề xuất NEXT, tái dùng
  `emitThought`, không nhân đôi): (1) **capability reroute** (`dispatchAgent`, cạnh `subagent:routed`) →
  `scheduler`/`planning`/`adaptation`; (2) **verify self-heal** — helper dùng chung mới
  `emitVerifyRoundThought` (`events/cognition.ts`) gắn vào `onRound` của `runVerifyLoop` ở CẢ 3 nơi
  (dispatchAgent SEARCH/REPLACE + XML tool-call + main-turn `verifyAndHeal`) → `validator`/`validation`/
  `adaptation`, chỉ narrate vòng FAIL (terminal pass/fail đã có lifecycle event); (3) **compaction**
  (`compactTurnHistory`, cạnh `system:warning`) → `retrieval`/`retrieval`/`adaptation`. Gate vẫn tập trung
  trong `emitThought` → off legacy = byte-identical. Test `cognition-stream.test.ts` (+3). `pnpm verify`
  xanh (core 329→332, ~1992).
- **Memory recall chuyên nghiệp hoá (2026-06-01, cont'd 19):** recall đa-session từng (a) CHẾT ở CLI —
  `resolveSessionId` rơi về hằng `"sess-cli"` nên mọi run đụng 1 id, lọc `session_id != current` loại sạch →
  agent CLI không bao giờ nhớ lại run trước (fix: id duy nhất per-process, `0fe6371`); (b) dùng raw SQL
  `(db as any).db` (fix: typed `recentEpisodesAcrossSessions`); (c) bỏ phí `HybridRetriever` (semantic vector +
  FTS RRF + boosting + packing) — 0 consumer live vì không ai sinh embedding. Đã wire `LocalDeterministicEmbedder`
  (feature-hashing, offline, deterministic → giữ tính reproducible cho eval/replay; sau interface `Embedder` để
  thay provider sau) vào write-path (embed episode → vector) + read-path (recall qua HybridRetriever), cờ
  `AGENCY_MEMORY_SEMANTIC` off legacy/on hardened (`ffd0ae8`). Giờ tier-3/4 recall thật sự là hybrid, không chỉ
  keyword.
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

---

## 8. HƯỚNG MỚI — chất lượng runtime + đa phương thức + bảo trì/mở rộng (2026-06-01)

> **Bối cảnh.** User gặp crash thật khi chạy BYOK (NVIDIA NIM `minimaxai/minimax-m2.7`):
> `nvidia API error: This model's maximum context length is 196608 tokens. However, your messages
> resulted in 197270 tokens` — DÙ harness đã in `Auto-reducing context window from 197270 to 128515`.
> Tức là phần "auto-reduce" **chạy nhưng KHÔNG hiệu lực**. User yêu cầu tập trung: memory, sandbox,
> built-in tools, đọc ĐÚNG thông số từ `models.json`, thêm **gửi ảnh** + **paste input dài không gãy UI**,
> rà soát chỗ chưa đúng + cải thiện THẬT, và đảm bảo **tính bảo trì + mở rộng** để sau tích hợp thêm.
> Mục này là **chẩn đoán từ source thật** + hướng sửa; **chưa code** (session sau làm). Mỗi item ghi
> rõ SỰ THẬT → LỖI/THIẾU → SỬA (+ file) → chống trùng lặp.

> **✅ P0 ĐÃ XONG (2026-06-01, commits `b83b55a` TUI crash + `106ee22` overflow).** 8.1+8.2+8.3
> làm cùng đợt. Kèm: (a) sửa **crash TUI render-loop** trong ảnh user — `stripToolCalls(m.content)`
> gọi không-guard ở `calculateFormattedLines` lúc render, `m.content` có thể `undefined` (App vá
> `content: turn.body || undefined`, `Partial<SessionMessage>` nới content thành `string|undefined`)
> → "Cannot read properties of undefined (reading 'indexOf')" → ErrorBoundary recovery loop; sửa tại
> canonical home (coerce non-string→"" như `parseAssistantContent`); (b) chặn **ratchet phá hoại**:
> reactive trước đây khi `parsedLimit >= oldLimit` áp `oldLimit*0.8` MỖI vòng + `updateModelOverride`
> ghi đè ĐĨA → minimax tụt 196608→…→**16887** kẹt trong `~/.agency/config.json` (đã dọn override hỏng
> của user; KHÔNG đụng API key). Giờ honor limit thật từ provider + cắt thân. `pnpm verify` xanh 16/16
> (providers 850 · core 351 · tui 116). **P1 kế: §8.5 paste dài → §8.4 ảnh.**

### 8.1 — Context overflow: reactive handler KHÔNG cắt hội thoại  ← ✅ XONG (2026-06-01)
> **Đã làm:** helper dùng chung `reduceHistoryToFit(turnHistory, newLimit, ctx)` (`chat/turn-helpers.ts`,
> gọi từ CẢ `stream.ts` + `orchestrator.ts`, không copy-paste): (1) repack system prompt (try/caught);
> (2) tóm middle qua `compactTurnHistory` canonical (thresholdRatio:0 vì đã quá ngưỡng); (3) cắt đôi
> body lớn nhất / bỏ lượt cũ tới khi `estimateMessagesTokens ≤ newLimit*safety` (0.8), GIỮ system[0] +
> message cuối. Trả `{messages, estimatedTokens, fits}` để assert trước retry. Never throws. Test
> `reduce-history.test.ts` (3). Chẩn đoán gốc dưới đây vẫn đúng nguyên văn.
- **SỰ THẬT.** `chat/stream.ts:288-328` + `chat/orchestrator.ts:~296-330` bắt `isContextLimitError`, giảm
  `contextWindow` override (`newLimit`), rồi **chỉ** `turnHistory[0].content = repackContextAndSystemPrompt(...)`
  (chỉ pack lại SYSTEM prompt) → `continue` retry.
- **LỖI.** Phần token lớn nằm ở `turnHistory[1..n]` (lượt hội thoại + tool results + paste dài + file đọc vào),
  KHÔNG phải system prompt. Pack lại system prompt giảm vài k token; phần thân vẫn 197k → API vẫn từ chối →
  retry vô ích tới khi hết `maxAttempts` rồi `throw`. (cont'd-21 đã ghi nhận "reactive handler chỉ thu *window*,
  không thu *conversation*" — đây chính là chỗ chưa đóng.)
- **SỬA.** Helper DÙNG CHUNG mới trong `chat/turn-helpers.ts` (ví dụ `reduceHistoryToFit(turnHistory, newLimit, ctx)`)
  gọi bởi CẢ stream.ts + orchestrator.ts (KHÔNG copy-paste): (1) pack lại system prompt như cũ; (2) **nén/cắt thân**
  — tái dùng `compactTurnHistory` (canonical, §2.3) để tóm phần giữa, NẾU còn quá → cắt tool-result lớn nhất /
  bỏ lượt cũ nhất, **lặp tới khi `estimateMessagesTokens(turnHistory) <= newLimit*safety`**; (3) chỉ retry khi đã
  THẬT SỰ vừa (assert estimate ≤ limit TRƯỚC khi gửi). Reactive này là lưới cuối; proactive là 8.3.

### 8.2 — Đọc SAI thông số model từ `models.json` (catalog không biết provider)  ← ✅ XONG (2026-06-01)
> **Đã làm + ĐÍNH CHÍNH dữ liệu:** models.json GIỜ CÓ `nvidia/minimaxai/minimax-m2.7`=**204800** (SAI —
> API thật 196608) + outlier `routing-run/route/minimax-m2.7`=100000. Nên "exact provider match"→204800
> (vẫn tràn), "min tuyệt đối"→100000 (quá tay). Giải: `getCatalogSpec(model, providerId?)` clamp context
> xuống **conservative robust-min** (nhỏ nhất trong nhóm cùng bare-id, BỎ outlier <50% max) → minimax ra
> **196608** (ollama-cloud/openrouter, = limit NVIDIA thật). Thread `providerId` qua `getModelSpec` →
> `enrichWithCatalog` (giờ còn **siết** confident registry-window xuống catalog conservative khi nhỏ hơn,
> KHÔNG nới) + `getTokenBudgetPlan`. Gate bằng cờ sẵn `AGENCY_MODEL_CATALOG`; không providerId =
> byte-identical. Test `model-catalog.test.ts` (+5 → assert 196608). `matchModelKey` giữ cho fallback bare.
- **SỰ THẬT.** `models.json` ở `packages/providers/models.json` (KHÔNG ở gốc repo — sửa mọi tham chiếu cũ).
  `model-catalog.ts` `matchModelKey(model, keys)` (dòng 58) lấy `base = id.split("/").pop()` rồi match trên
  **bare model id** vào index gộp PHẲNG mọi provider. `minimax-m2.7` tồn tại dưới NHIỀU provider với context KHÁC
  nhau: `ollama-cloud/minimax-m2.7`=**196608** (đúng như lỗi NVIDIA), `302ai/MiniMax-M2.7`=**204800**,
  `fireworks/minimax-m2p7`=196608. Không có `nvidia/...` trong file.
- **LỖI.** Lookup **không biết provider của user** → `minimaxai/minimax-m2.7` (NVIDIA) khớp nhầm entry provider khác
  (vd 204800) → budget cho phép tới ~204800 → gửi 197270 → NVIDIA (giới hạn THẬT 196608) từ chối. Đây đúng "thông
  tin model có vẻ sai" user nói. (Tương tự rủi ro cho cost/capabilities khi gộp phẳng.)
- **SỬA.** Catalog **provider-aware**: thread `providerId` vào `getModelSpec`→`getCatalogSpec(model, providerId?)`;
  index thêm key `"<provider>/<model>"` (không chỉ bare); lookup theo thứ tự: (a) entry đúng provider của user, (b)
  nếu provider user không có trong file → trong các entry cùng bare-id **chọn CONSERVATIVE = context NHỎ NHẤT** (an
  toàn budget, không bao giờ over-allow), (c) cuối mới tới CANONICAL_PROVIDERS. Giữ `matchModelKey` cho fallback bare.
  Test: thêm case minimax đa-provider → assert NVIDIA ra 196608, không phải 204800.

### 8.3 — Token estimator ƯỚC THIẾU (gây overflow + nén trễ)  ← ✅ XONG (2026-06-01)
> **Đã làm:** `estimateMessagesTokens` (`error-parser.ts`) giờ ước-DƯ: `len/3.5` (thay `len/4`) +
> overhead 8/msg (thay 5) + xử lý `content` non-string (đếm text-part của multimodal, hằng/ảnh = 1200 —
> forward-compat §8.4). 1 hàm canonical (không tạo cái thứ 2). Compaction proactive + reduceHistoryToFit
> nhờ đó kích SỚM. Test `error-parser.test.ts` (mới, 6: over-estimate + non-string + parseContextLimit).
- **SỰ THẬT.** `providers/error-parser.ts:71` `estimateMessagesTokens` = `Σ content.length / 4 + msgs*5`. Lỗi NVIDIA:
  ước 192627 nhưng THẬT 197270 (thiếu ~2.4%). Dùng ở `turn-helpers.ts:328` (ngưỡng compaction) + 2 reactive handler.
- **LỖI.** (a) `len/4` lạc quan cho code/JSON/tool-result nhiều ký tự đặc biệt/non-ASCII → ước THẤP hơn thật →
  budget tưởng vừa khi KHÔNG vừa, và compaction proactive kích **trễ**. (b) Giả định `content` luôn là string → vỡ khi
  thêm multimodal (8.4). (c) Bỏ qua overhead role/tool-call structure.
- **SỬA.** Estimator phải ** err HIGH** (ước dư, an toàn): tỉ lệ bảo thủ hơn (vd `len/3.5` cho phần code, hoặc nhân
  margin ~1.1) + cộng overhead role/structural + xử lý `content` non-string (đếm phần text của multimodal). Nguyên tắc:
  thà nén sớm còn hơn tràn. Giữ 1 hàm canonical (đừng tạo estimator thứ 2). Có thể để 1 cờ tinh chỉnh ratio.

### 8.4 — Gửi ảnh / đa phương thức (multimodal)  ← 🟡 P1 (tính năng mới user yêu cầu)
- **SỰ THẬT.** `providers/types.ts:29` `ChatMessage.content: string` (THUẦN text). Adapter (`adapters/openai-compatible.ts`)
  **không** xử lý `image_url`/base64/vision (grep rỗng). NHƯNG catalog ĐÃ phát hiện năng lực: `entryToCatalogSpec` set
  `capabilities.vision = attachment || input.includes("image"|"pdf")` — tức "biết model nào nhận ảnh" nhưng KHÔNG có
  đường ống gửi ảnh (detection có, plumbing chưa → built-but-unwired một nửa).
- **SỬA (đa tầng, làm sau khi P0 xong).** (1) Mở rộng `ChatMessage.content: string | ContentPart[]` (`ContentPart =
  {type:"text",text} | {type:"image",url|base64,mimeType}`) — additive, default string giữ byte-identical; (2) adapter
  openai-compatible map ContentPart→`content:[{type:"text"...},{type:"image_url",image_url:{url}}]` CHỈ khi
  `getModelSpec(model).capabilities.vision` (gate bằng năng lực catalog — tái dùng, không đoán); model không vision →
  fallback (mô tả text / từ chối rõ ràng); (3) estimator (8.3) đếm token ảnh thô (vd hằng/ảnh); (4) TUI: affordance đính
  ảnh (path / paste ảnh từ clipboard → đọc file → base64). Giữ provider-agnostic qua interface adapter (mở rộng dễ).

### 8.5 — Paste input DÀI làm gãy UI (TUI composer)  ← ✅ XONG (2026-06-01, commit `2172832`)
> **Kết quả sau khi VERIFY source (đừng-assert + chống trùng):**
> - **(perf — gốc thật, ĐÃ SỬA)** `applyTextInput` (`tui/hooks/useTextInput.ts`) append paste **mỗi ký tự**
>   qua `setter(b => b + c)` → O(n²) rebuild buffer → freeze khi paste 12k. Ink GIAO CẢ paste trong **1
>   sự kiện** `input` (theo docs Ink), nên gom thành **1 setBuffer (O(n))**, giữ nguyên ngữ nghĩa trái→phải
>   (backspace nhúng pop accumulator trước, tràn sang buffer cũ khi rỗng). +8 test `text-input.test.ts`.
> - **(2) cap chiều cao ĐÃ CÓ SẴN** — `PromptComposer` `MAX_LINES=6` + `visibleLines.slice(-6)` + indicator
>   "▲ +N lines scrollable above" + `estimateComposerHeight`. Display paste dài đã bị bound → KHÔNG làm lại.
> - **(1) bracketed-paste KHÔNG cần + có HẠI** — Ink đã coalesce paste; `applyTextInput` reject input chứa
>   `\x1b`, nên bật `?2004h` sẽ khiến Ink giao marker `\x1b[200~` rồi bị vứt → vỡ paste. KHÔNG bật.
> - **(3) paste cực dài→attachment** — giá trị BIÊN vì (2) đã bound hiển thị; để ngỏ (polish), gắn cùng §8.4
>   nếu cần một khái niệm "composer attachment" chung. Chẩn đoán gốc dưới đây giữ làm tham chiếu.
- **SỰ THẬT.** Input ở `tui/components/PromptComposer.tsx` + `ComposerBlock.tsx` (Ink). Paste 1 khối lớn → Ink/Yoga
  re-layout toàn khung theo từng ký tự + 1 dòng dài cực kỳ → giật/gãy frame (cùng họ lag ConPTY đã ghi ở Phần 1 (TUI)).
- **SỬA.** (1) Bật **bracketed-paste** (gom cả khối thành 1 sự kiện thay vì N keypress); (2) **cap chiều cao composer**
  + cuộn nội bộ (không để input cao vô hạn đẩy vỡ layout); (3) với paste CỰC dài → đề nghị biến thành **attachment**
  (lưu nội dung, hiện placeholder `[pasted 12.4k chars]`, nội dung thật vào turn — không render hết ra khung). Đo lại
  bằng `verify`/chạy TUI thật. Tái dùng tiện ích width/truncate sẵn có (`tui/utils`), đừng tự viết lại.

### 8.6 — Memory recall: kiểm CHẤT LƯỢNG thật (không chỉ "chạy")  ← 🟢 P2
- **SỰ THẬT.** Đã hardened nhiều (cont'd 19): fix recall đa-session, GC/quota/decay, secret-redact, wire `HybridRetriever`
  + `LocalDeterministicEmbedder` (feature-hashing, offline/deterministic, sau interface `Embedder`), cờ `AGENCY_MEMORY_SEMANTIC`.
- **THIẾU.** `LocalDeterministicEmbedder` là **placeholder** (feature-hashing → recall ngữ nghĩa YẾU, chỉ giữ tính
  reproducible cho eval/replay). Chưa đo recall có thật sự surface đúng ký ức hữu ích trong phiên thật. Đường nâng cấp ĐÃ
  có sẵn: cắm **provider-embedder thật** sau interface `Embedder` (vd embeddings API), gate riêng để KHÔNG phá determinism
  của eval (eval/replay dùng local). **SỬA:** thêm bài đo recall (precision@k trên corpus episode), rồi cân nhắc provider-embedder
  optional. Interface `Embedder` chính là điểm mở rộng — giữ nguyên, chỉ thêm impl.

### 8.7 — Codebase indexing: kiểm incremental + độ tươi  ← 🟢 P2
- **SỰ THẬT.** `index/workspace-indexer.ts` (`buildIndex`/`incrementalUpdateAsync`/`isIndexStale`/`writeIndex`/`loadIndex`);
  ĐÃ wired vào context pack: `context/pack.ts:63 loadIndex` trong `buildContextPack` → index THỰC SỰ nuôi prompt (retrieval live).
- **KIỂM.** (1) `incrementalUpdateAsync` có bỏ sót file đổi/đổi tên/xoá không (đối chiếu mtime/hash)? (2) `isIndexStale` ngưỡng
  hợp lý? (3) index có chọn ĐÚNG file liên quan vào pack không (chất lượng retrieval, không chỉ có-mặt)? (4) re-index đồng bộ
  trong dispatch là ứng viên offload worker-thread (đã ghi Phần 1). Đây là kiểm-chứng + cải thiện, không phải wiring.

### 8.8 — Sandbox + built-in tools: rà path + edge-case  ← 🟢 P2
- **SỰ THẬT.** `security/sandbox.ts`: ưu tiên **docker** (`isDockerAvailable`, `host.docker.internal`, proxy) + fallback
  **native** (`--sandbox-mode native`), cleanup Windows `taskkill /F /T`. Built-in tools: 17 tool trong 1 `ToolRegistry`
  (đã audit cont'd 12), auto-advertise, approval-gated.
- **KIỂM.** (1) docker-unreachable → thông báo rõ + không treo (đã có message); (2) native mode cảnh báo bảo mật đủ mạnh?
  (3) tool handler edge: truncate (đã scale theo window), lỗi surface (invokeSafe không throw), file-write atomic (đã verify).
  Đa số đã chắc — đây là rà soát hồi quy, ưu tiên thấp.

### 8.9 — Bảo trì & MỞ RỘNG (mục tiêu xuyên suốt của user)  ← 🟢 nền
- **Điểm mở rộng đã có (giữ + tài liệu hoá, đừng phá):** provider mới → thêm adapter sau interface `LlmProvider` +
  entry `models.json`; tool mới → `registry.register` (tự advertise qua `formatToolDocs`); skill/agent mới → cập nhật
  manifest/seed (guard skills↔manifest + agents↔prompt/seed bắt drift); behavior mới → cờ trong `flags.ts` (surface ở
  `agency status`, guard flags↔status); embedder mới → impl interface `Embedder`; dep mới → guard deps↔imports + package↔cycles.
- **6 GUARD hiện có** (chạy trong `pnpm verify`) là xương sống bảo trì: skills↔manifest, agents↔prompt/seed, flags↔status,
  architecture↔cycles (module), package↔cycles, deps↔imports hygiene. **Mỗi tính năng mới ở §8 phải đi kèm: tái dùng
  canonical home, cờ nếu đổi hành vi, test, cập nhật docs + memory** — đúng nhịp slice của chiến dịch.

### 8.10 — TUI realtime activity & telemetry CHƯA chuyên nghiệp  ← 🟠 P1 (user báo 2026-06-01, CHẨN ĐOÁN, chưa code)
> **Bối cảnh user.** Ảnh chụp: panel "▼ Cognition & execution traces" hiện `▶ exec · list_dir · short video` /
> `√ exec · list_dir · completed` / `▶ exec · read · SPEC.md (lines 1–300)` / `√ … completed`, status `‖ Writing·· ·
> 8m39s · 10.3k tokens`. User: "model **nghĩ gì** thì thấy rồi, nhưng **đang làm gì** chưa realtime tốt; TUI/UX còn
> yếu, chưa chuyên nghiệp". Dưới đây chẩn đoán từ SOURCE THẬT (đừng điều tra lại), mỗi lỗi SỰ THẬT→LỖI→SỬA(+file).

**(A) Main turn KHÔNG có event tool có cấu trúc — UI phải regex-parse text English (gốc lớn nhất).**
- **SỰ THẬT.** Main turn báo hiệu tool bằng cách **nhồi text người-đọc** vào stream LLM:
  `formatToolCallNotice` (`chat/stream.ts:70`) → `handlers.onDelta("⚡ [SYSTEM: Executing tool \"X\" on Y...]")`, và
  notice hoàn tất `onDelta("⚡ [SYSTEM: Tool \"X\" completed with result length: N…]")` (`stream.ts:~428`). TUI **regex
  parse lại** chuỗi đó: `conversation/TraceTelemetry.tsx` (`toConciseTelemetry`/`SystemActivityLine`/
  `formatSystemActivityLine`) + `partitionStreamContent` lọc `traceLines` từ `cleanedContent`, rồi
  `utils/conversation/tool-labels.ts` (`getToolAlias`/`getGroundedTargetName`/`getSemanticToolOperation`) dựng nhãn.
  Event **CÓ CẤU TRÚC** (`subagent:progress`) CHỈ phát khi `agentId` set (`stream.ts:416/436`, `orchestrator.ts:391/411`)
  → tức **chỉ subagent**; main turn (không agentId) KHÔNG phát gì. (`tool:executed` có khai nhưng chỉ dùng trong 1 test,
  KHÔNG publish live.)
- **LỖI.** Vòng lặp **lossy** structured (`tc.name`,`tc.arguments`,status) → English → regex → structured. Hậu quả thấy
  trong ảnh: (1) **nhãn sai** `list_dir · short video` — `list_dir` không có path nên `formatToolCallNotice` rơi nhánh
  "with arguments {JSON}", `getGroundedTargetName` lấy **first string value** của JSON args (dòng 76-78) = "short video"
  (text task, KHÔNG phải path); (2) **2 dòng mỗi tool** (`▶ … exec` rồi `√ … completed`) thay vì 1 dòng chuyển
  running→done; (3) tương quan started↔completed qua **global `lastToolTargets` Map keyed theo toolName** (`TraceTelemetry.tsx:15`)
  → vỡ khi parallel tool / cùng tên.
- **SỬA.** Phát **event tool-lifecycle có cấu trúc cho MAIN turn** (tái dùng EventBus, KHÔNG kênh thứ 5): hoặc mở rộng
  `subagent:progress` để main turn fire với agentId tổng hợp ("main"/sessionId), hoặc publish `tool:started`/`tool:completed`
  mang `{callId, toolName, args/target, status, durationMs, resultLength}`. TUI tiêu thụ structured → nhãn lấy thẳng từ
  `tc.arguments` (không regex), **1 dòng/tool** transition theo `callId`, bỏ `lastToolTargets`. Giữ text `[SYSTEM:…]` CHỈ cho
  context của LLM, UI KHÔNG phụ thuộc parse nó. Cân nhắc dùng `events/cognition.ts emitThought` (producer narration canonical
  đã có) cho điểm emit tool — hiện THIẾU đúng điểm này.

**(B) Status line "Writing·· 8m39s" KHÔNG phản ánh tool đang chạy (đúng "đang làm gì chưa realtime").**
- **SỰ THẬT.** `ToolActivity.tsx` hiện `getPhaseLabel(activityPhase)`, override bằng `heartbeat.message` nếu < 10s. Nhưng
  `activityPhase` (`App.tsx`) chỉ set "routing"(1483)→"writing"(1568/1584)→"idle" — **KHÔNG có** set theo tool
  (grep `setActivityPhase`: 0 chỗ "reading"/"editing"/"validating" do tool). Heartbeat chỉ cập nhật khi `thought:emitted`
  (App.tsx:547), mà main-turn tool **không emit thought** → trong 8 phút đọc file, status kẹt "Writing".
- **SỬA.** Lái `activityPhase`/label từ event (A): read/view→"Reading", grep/find→"Searching", write/edit→"Editing",
  exec→"Running", subagent→worker label → status phản ánh thực tại realtime. Nguồn duy nhất, không đoán.

**(C) Tool chỉ hiện SAU khi model sinh xong XML; không có progress trong-tool.**
- **SỰ THẬT.** Notice inject SAU `parseToolCalls(currentText)` (sau khi nhận đủ lời model), rồi tool chạy. Trong lúc model
  sinh dài (phần lớn 8m39s) KHÔNG có feedback per-tool; tool chậm (grep/đọc file lớn) không có progress nội bộ → cảm giác treo.
- **SỬA (sau A/B).** Với event cấu trúc + label realtime, hiển thị "running" có spinner + elapsed per-tool; cân nhắc heartbeat
  định kỳ trong tool dài. (Liên quan lag ConPTY đã ghi Phần 1 — KHÔNG block host.)

**(D) 4 bề mặt "đang xảy ra gì" chồng chéo (mùi trùng lặp kiến trúc).**
- **SỰ THẬT.** (1) inline trace per-message qua text-parse (`Conversation.tsx`+`TraceTelemetry`); (2) subagent structured →
  `globalWorkerTracker` → `SubagentPanel`/`ToolActivity`; (3) **`ExecutionPanel.tsx` cây phase HARDCODE** (PLAN/EXECUTE/VERIFY +
  subtask GIẢ "inspect routing"/"apply patches"/"compile application" — KHÔNG phải hoạt động thật, chỉ suy từ `activityPhase`);
  (4) `CognitionPanel` (thoughts). 4 cơ chế, không cái nào authoritative; (3) là telemetry GIẢ.
- **SỬA.** Chốt 1 nguồn sự thật (event A) cho "đang làm gì"; `CognitionPanel` giữ cho "đang nghĩ gì". Bỏ/thay subtask giả của
  `ExecutionPanel` bằng event thật hoặc gỡ panel. Tra "Canonical Homes" trước khi thêm.

**(E) Logic render trùng 3 bản.** `SystemActivityLine` (component) ≈ `formatSystemActivityLine` (function) trong
  `TraceTelemetry.tsx` gần **byte-identical** (pattern 1-7 lặp) + `toConciseTelemetry` là biến thể thứ 3 cùng map
  SYSTEM-line→UI. **SỬA:** gộp về 1 mapping canonical (nếu giữ nhánh text-parse làm fallback). Behavior-preserving.

> **Thứ tự đề xuất §8.10:** A (event cấu trúc main turn — gốc) → B (lái phase/status từ event) → D/E (gộp bề mặt + dedup render)
> → C (progress per-tool). Cờ nếu đổi hành vi (`flags.ts`); tái dùng EventBus + `emitThought` + canonical homes; test +
> `pnpm verify` xanh. **ĐÂY LÀ VIỆC P1 KẾ (cùng/đan với §8.4 ảnh tuỳ ưu tiên user).**

### 8.11 — Harness & built-in tools: ĐÚNG + ĐỦ + ÍT TOKEN (audit 2026-06-01)
> **Bối cảnh user.** "Đảm bảo harness đúng + đầy đủ built-in tools, tools hoạt động xịn, **ít token cho mọi model**
> mà vẫn nhanh + chất lượng cao." Audit từ source thật (17 tool trong 1 `ToolRegistry`, auto-advertise qua
> `registry.listTools()`→`buildSystemPrompt`). Mỗi mục đo được, SỰ THẬT→LỖI→SỬA(+file).

**(A) `truncateToolResult` model-aware scaling CHẾT (built-but-unwired) — ✅ ĐÃ SỬA (commit `a550bd2`).**
- SỰ THẬT/LỖI: `skill/tool-harness.ts` gọi `require("@agency/providers")` trong **module ESM** → throw, bị
  try/catch nuốt → MỌI model rơi default ~30K chars (đo: 200k/16k/no-model đều 30040). Model nhỏ (≤16K) nhận
  full result → nguy cơ tràn (họ §8); "scale theo window" trong docs là SAI.
- SỬA: import static `getModelSpec` (providers leaf, no cycle) + re-tune token-conscious: nhỏ (<32K, bắt cả model
  báo 16385) → 8K; lớn (≥200K) → **48K (KHÔNG còn 400K-char/~100K-token dump** — truncation note đã bảo model lấy
  thêm qua `read_file` ranges); medium → 32K. +4 test regression. ÍT token + an toàn tràn.

**(B) KHÔNG có prompt caching — ĐÒN BẨY TOKEN LỚN NHẤT bị bỏ lỡ.  ← 🔴 ưu tiên token**
- SỰ THẬT. grep `cache_control|prompt_cache|ephemeral` trong `packages/providers` = **RỖNG**. System prompt cố định đo
  được **~2069 token/turn** (tool-docs 1109 + prose ~960), GỬI MỖI TURN + contextPack + history. `buildSystemPrompt`
  (`chat/prompt.ts`) xếp **VARIABLE lên ĐẦU**: `anchorBlock` (goal pillars từ user msg) + `intent/workflow` (dòng 66-70)
  trước protocol+tool-docs (STATIC).
- LỖI. (a) Anthropic không gắn `cache_control:{type:"ephemeral"}` → mỗi turn trả FULL giá input cho phần static
  (đáng ra cache ~10% giá). (b) OpenAI-compatible (NVIDIA/openrouter/deepseek) có **automatic prefix caching** nhưng
  CẦN prefix ổn định — đặt VARIABLE lên đầu **phá** prefix cache → 0% hit. Đây là token phí lớn nhất cho hội thoại dài.
- SỬA. (1) Reorder `buildSystemPrompt`: **STATIC prefix trước** (protocol + tool-docs) → rồi anchorBlock (ổn định/phiên)
  → contextPack/memories/user-question (variable) cuối. Bật automatic prefix-cache cho mọi openai-compatible, 0 thêm code.
  (2) Adapter Anthropic gắn `cache_control` block cuối system (verify cần BYOK key — đo cache-hit). **Cờ nếu đổi prompt
  order** (legacy giữ nguyên). Đây là cách "ít token cho TẤT CẢ model" trực tiếp nhất.

**(C) "5-APPROACHES RULE" ép 5 hướng mỗi turn planning — phí OUTPUT token + formulaic.  ← 🟡**
- SỰ THẬT. `chat/prompt.ts:77-78` ép "MUST outline exactly 5 distinct approaches ... sort by recommendation ... pros/cons,
  success criteria, next command" cho MỌI đề xuất planning/architecture.
- LỖI. Task đơn giản cũng phải đẻ 5 hướng = tốn output token (đắt hơn input) + cứng nhắc, có khi giảm chất lượng (lan man).
- SỬA. Mềm hoá ("vài hướng riêng biệt sắp theo khuyến nghị khi đề xuất chiến lược") hoặc gate theo độ phức tạp/disclosure.
  Cờ vì đổi hành vi output. Giữ chất lượng cho task khó, bớt token cho task dễ.

**(D) Tool-docs re-list args 17 tool mỗi turn (~1109 token).  ← 🟢 biên (sau B).**
- SỰ THẬT. `formatToolDocs` (`prompt.ts:6`) liệt mọi tool + mọi arg mỗi turn. SỬA (sau khi B cache xong, lợi biên):
  rút gọn arg cho tool hiển nhiên, hoặc chỉ liệt arg cho tool ít rõ. Behavior-cẩn-thận (model cần biết schema).

**(E) Hoàn chỉnh/độ rõ (minor, KHÔNG bug).** `grep_file` (1 file) vs `grep_search` (workspace recursive + gitignore +
  case/regex/limit) **distinct thật** (đã verify) nhưng tên dễ nhầm → cân nhắc đổi tên rõ (`search_in_file`/`search_workspace`).
  Ứng viên hoàn chỉnh (tuỳ chọn): tool **unified-diff/patch** (sửa nhiều hunk ÍT token hơn rewrite cả file — bổ sung
  `batch_edit`/`ast_edit`); **search dựa index** (`grep_search` đang walk lại cây mỗi lần — `loadIndex` đã có, dùng để
  nhanh + ít token + kết quả tốt hơn). Tra "Canonical Homes" trước khi thêm tool.

> **Thứ tự §8.11:** B (caching — token win lớn nhất) → C (5-approaches) → D → E. Cờ cho thay đổi prompt; tái dùng catalog
> `capabilities`/adapter interface; test + `pnpm verify` xanh. A đã xong.

### Thứ tự đề xuất cho session sau
**~~P0: 8.2 + 8.3 + 8.1~~ ✅** + **~~§8.5 paste dài~~ ✅** (2026-06-01) — xem các mục trên + banner đầu §8.
**▶ NEXT P1 — 2 nhánh (user ưu tiên):**
- **§8.10 TUI realtime activity** (user báo trực tiếp 2026-06-01, "đang làm gì chưa realtime + UX chưa chuyên nghiệp"):
  event tool-lifecycle cấu trúc cho main turn (gốc A) → lái status/phase realtime (B) → gộp 4 bề mặt + dedup 3 bản render
  (D/E) → progress per-tool (C). Xem §8.10 ở trên (đã chẩn đoán từ source).
- **§8.4 ảnh đa tầng:** `ChatMessage.content: string|ContentPart[]` additive (default string = byte-identical); adapter
  openai-compatible map `image_url` CHỈ khi `getModelSpec(model).capabilities.vision`; estimator §8.3 ĐÃ đếm token ảnh sẵn
  (`IMAGE_PART_TOKENS`); TUI đính ảnh (path qua `@` đã có resolve IMG badge — tận dụng). **P2:** 8.6/8.7/8.8. Mỗi bước: `pnpm verify` xanh → commit `master` →
sync docs/memory.

> **Lưu ý cho session sau (di chứng + theo dõi):** (1) `updateModelOverride` trong reactive vẫn GHI ĐĨA
> override context (giờ = limit thật, không ratchet) — cân nhắc đổi sang override SESSION-LOCAL để 1
> overflow nhất thời không sửa vĩnh viễn spec model (lợi biên, để ngỏ). (2) `conservativeContextForBareId`
> dùng ngưỡng outlier 0.5×max — nếu sau này thấy model bị siết quá tay, chỉnh `CONSERVATIVE_OUTLIER_RATIO`.
> (3) user config `~/.agency` có `nvidia.thinking: 196608` (= cả context window — đáng ngờ, có thể
> misconfig nhưng KHÔNG phải gốc crash; không đụng).
