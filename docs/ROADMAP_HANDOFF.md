# AgencyCLI — Roadmap to a Real Harness (Plan Handoff)

> **Mục đích.** Tài liệu này vạch đường đi từ "không sập" (hardening hiện tại) đến
> một **harness thật sự**: chạy trơn tru, tự kiểm chứng, đo được độ tin cậy, và
> đáng tin để chạy không người trông. Đây là **kế hoạch**, chưa phải việc đã làm.
> Companion: [HARDENING_HANDOFF.md](HARDENING_HANDOFF.md) (việc P0/P1 đã xong),
> [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) (gap matrix), `agencycli-production-hardening` (memory).
> Tạo: 2026-05-30.
>
> **⚠ Log lịch sử (append-only).** Các mục theo ngày/slice (`cont'd N`, "Baseline giờ", §2.x)
> là ảnh chụp tại thời điểm đó — một số nhắc tới hệ thống **ĐÃ GỠ về sau** (vd pipeline
> cognition / `CognitionPanel` / `ExecutionPanel`, cờ `cognitionStream`). Xác nhận hiện trạng
> bằng `git log` + `pnpm verify` + `agency status`; **đừng coi mục cũ là sự thật hiện tại**.

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

### 2.2 — Phát hiện hoàn thành (completion detection)  ← 🟡 một phần (2026-05-30; +auto-continue 2026-06-02)
- Engine đã có: đạt tiêu chí → dừng (`passed`); **không tiến triển (lỗi lặp) sau N vòng → dừng**
  (`no-progress`); hết round (`max-rounds`); hết budget (`budget-exhausted`).
- **AUTO-CONTINUE turn chính ĐÃ XONG (2026-06-02):** vòng lặp turn (`stream.ts`+`orchestrator.ts`) trước
  đây coi "model phát turn KHÔNG có tool-call" = XONG → `break`. Nhưng model BYOK yếu hay **tự ý dừng giữa
  việc** — prose "I'll continue creating the rest…" / để placeholder `// ... rest of the code` rồi ngừng gọi
  tool → turn trả về như đã xong, user phải tự gõ "continue". **Sửa:** detector thuần bảo thủ
  `detectIncompleteCompletion(text)` (canonical home `turn-helpers.ts`) — chỉ fire trên lời-hứa-tiếp-tục
  ngôi-thứ-nhất NEO CUỐI message + marker "to be continued" + code-placeholder; LOẠI câu hỏi/lời-mời
  ("let me know", kết "?"). Khi fire (và `autoContinueCount < MAX_AUTO_CONTINUE`=3, vẫn trong `maxLoops`) →
  nối nudge `buildAutoContinueNudge` (đọc đĩa→append/edit, đừng-rewrite) vào `turnHistory` + `loopCount++`
  thay vì `break` (mirror đúng nhánh `finishReason==="length"`). Cờ MỚI `AGENCY_AUTO_CONTINUE`/`autoContinue`
  (off-legacy **byte-identical** = break như cũ / on-hardened). High-precision: false-negative an toàn,
  false-positive chỉ tốn 1 turn có chặn trần. Test `auto-continue.test.ts`.
  core 410→420, **33 cờ**, row `agency status` "Auto-continue".
- **ARTIFACT-BASED detection ĐÃ XONG (2026-06-02, cùng cờ `autoContinue`, KHÔNG cờ mới):** prose-heuristic không
  bắt được khi model ghi stub ở vòng TRƯỚC rồi vòng sau nói "Done." sạch. Thêm `detectTruncatedArtifact(filesWritten,
  projectRoot)` (`turn-helpers.ts`) — quét file turn VỪA GHI, fire nếu nội dung đĩa có placeholder/elision
  (`// ... rest of the code`, `# ... existing code ...`) qua CÙNG regex `CODE_PLACEHOLDER` (mở rộng thêm
  `existing|unchanged|snip`). Điều kiện else-if thành `detectIncompleteCompletion(currentText) || (filesWritten.size>0
  && detectTruncatedArtifact(...))` ở CẢ 2 path. Best-effort (skip missing/binary/>512KB, never throw), chỉ quét
  artifact của chính turn (không vớ file repo khác). Mạnh hơn prose vì stub đã LƯU ĐĨA. core 420→**424** (+4 test:
  detector đĩa ×3 + wiring stub-then-fix ×1). `pnpm verify` REAL_EXIT_CODE=0.
- **VERIFY-MAIN-TURN ĐÃ WIRE VÀO TUI (2026-06-02):** trước chỉ `agency chat` one-shot tự-sửa; giờ `App.tsx`
  gọi `runChatTurnWithVerify` (byte-identical với `runChatTurnWithStream` khi cờ off) → turn TUI có edit cũng
  chạy acceptance + tự-sửa. UX: mỗi round self-heal RESET buffer stream live (round N THAY N-1, không nối chồng)
  + in dòng "⚙ self-healing (round N)…" qua event `chat:self-healing` (đã có sẵn) để re-run THẤY ĐƯỢC, không
  im lặng. Gate `verifyMainTurn` (=`verifyLoop`: off-legacy/on-hardened). Glue TUI không unit-test được trong
  harness hiện tại (App monolith); an toàn cấu trúc: off→delegate thẳng hàm cũ. `pnpm verify` REAL_EXIT_CODE=0.
- **TUI surface `chat:verify-failed` XONG (2026-06-02):** khi self-heal hết round vẫn fail, TUI in 1 dòng cảnh
  báo (thay vì im lặng trả attempt hỏng) — subscribe ở block event cố định (terminal event, không reset buffer
  như `chat:self-healing`). Additive, no-op khi `verifyMainTurn` off.
- **Còn lại:** tín hiệu "đạt mục tiêu task" khách quan hơn build/stub (gắn với 2.1 còn lại). Robustness e2e
  không-cần-key giờ ĐÃ CẠN — bước tiếp là keystone đo eval + promote `hardened`→default (CẦN BYOK key + user OK).

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
- **Cắt ngắn thông minh — ĐÃ CÓ + ĐÃ SỬA cắt-đầu-nuốt-lỗi-cuối.** `truncateToolResult` đã scale theo context-window model (8K→16K aggressive, ≥200K rộng tay, medium ~20% window). **FIX `9a0a03f`:** trước CHỈ giữ head → output lệnh (`execute_command` format `Exit Code: …\nStdout:…\nStderr:…`) có lỗi compile/test ở CUỐI bị cắt → model biết "exit≠0" mà mù tại-sao → churn. Giờ giữ **head+tail (40/60)** cho output lệnh (detect tên `execute_command` HOẶC header `Exit Code: `), tool khác (read_file/grep) giữ head-only. Cờ `AGENCY_TOOLRESULT_TAIL`/`toolResultTailKept` off-legacy byte-identical/on-hardened. ⚠ hàm return sớm khi `≤maxChars` → line-path chỉ chạy khi cũng vượt char-cap. *Còn lại nếu muốn:* kết quả tool có cấu trúc (typed) thay vì string thuần — giá trị biên, để sau.

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
  tái diễn của repo. Baseline đã tự verify: build 16/16, exit 0 (số khi LẬP gate: ~2001 test / core 350 · cli 547 · tui 115 — đã cũ; số HIỆN TẠI ở §8 banner đầu mục).
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
> (providers 850 · core 351 · tui 116). **CẬP NHẬT 2026-06-01 (HEAD `aa14e48`): sau P0 đã xong tiếp §8.5 paste ✅ ·
> §8.11-A/B/C token-efficiency ✅ (prompt-cache reorder + Anthropic cache_control + soften 5-approaches) · 2 runtime fix
> từ ảnh user ✅ (tool `append_file` cho file lớn + egress `fonts.gstatic.com`) · **§8.10 loop/resume ✅ (2026-06-01: notice
> resume khi chạm maxLoops, cờ `AGENCY_RESUME_CONTINUATION`)** · **§8.10-A realtime tool narration ✅ (2026-06-02: emitThought
> tại main-turn tool loop → status line realtime, dùng cờ sẵn `cognitionStream`)** · **§8.10-B/D ✅ (2026-06-02: lái
> `activityPhase` từ thought qua `activityPhaseFromThought` → status hết kẹt "Writing" >10s; bỏ subtask GIẢ ExecutionPanel →
> activity thật)** · **§8.10-E ✅ (parser canonical) · §8.10-C ✅ (2026-06-02: diệt nhãn sai `getGroundedTargetName` + gỡ
> `lastToolTargets` vestigial vỡ parallel) → §8.10 ĐÓNG TRỌN** · **§8.11-D ✅ (compact tool-docs args, cờ
> `AGENCY_COMPACT_TOOL_DOCS`) · §8.11-E ✅ (clarify grep mô tả cross-ref) → §8.11 ĐÓNG TRỌN** · **§8.7 ✅ (2026-06-02: index
> freshness — xóa changedFiles fast-path dead+buggy)** · **§8.8 ✅ (2026-06-02: self-kill HARD-refuse — báo user `c03b9a2`;
> DockerSandbox timeout+output-cap parity native `71cbe78`; circuit-breaker fire-on-blocked-loop `ca2c954`; **§8.8-A turn-loop
> HARD-break trên circuit-breaker trip + §8.8-B tolerate malformed `</tool_call>` wrappers `64e945a`** → §8.8 ĐÓNG TRỌN)**.
> **§9 Curated cross-session MARKDOWN memory ✅ (user-requested): đem cơ chế memory kiểu Claude-Code (index + topic file frontmatter) vào AgencyCLI — `MarkdownMemoryStore` (@agency/memory) + tool `remember`/`forget` + recall vào prompt, cờ `AGENCY_FILE_MEMORY`; phân biệt rõ với SQLite episodic store tự động + `agency memory` bridge (knowledge/genome) sẵn có — KHÔNG gộp. Promoted default-on cả 2 profile (2026-06-04, user OK): default `hardened`→`true`, cờ giữ nguyên, opt-out `AGENCY_FILE_MEMORY=0`.**
> **§2.2 completion-detection — auto-continue turn chính ✅ (2026-06-02):** model tự-ý-dừng-giữa-việc (prose "I'll continue…"/code-placeholder, ngừng gọi tool) HOẶC để stub trên đĩa (`// ...rest of the code`) giờ được nudge tiếp tục có chặn trần thay vì trả turn dở; cờ `AGENCY_AUTO_CONTINUE`, canonical `turn-helpers.detectIncompleteCompletion`+`detectTruncatedArtifact`+`buildAutoContinueNudge`. Xem §2.2.
> Baseline (đo thật 2026-06-05, post docs-consistency + K1 RuntimeState + auto-expand-thinking, `pnpm verify` REAL_EXIT_CODE=0, build 16/16): core **504** · cli **588** · tui **214** · providers **855** · memory 48 · security 39 · tooling 14 · benchmark 18 · skills-bridge 18(+1 skip) · workspace 11 · telemetry 9 · context 6 · governance 7 · heuristics 6 · browser 5 = **~2342 test** · **43 cờ** · **21 tool** · 16 pkg · 8 agent · 28 skill · 8 workflow. ⚠ Các dòng "Baseline"/"core N"/"N cờ" CŨ hơn bên dưới là ảnh chụp point-in-time (đúng tại commit của chúng) — số test/cờ trôi mỗi slice, KHÔNG sửa lịch sử; chạy `pnpm verify` + `agency status` cho số sống. Cấu trúc (tool/agent/pkg/skill/workflow) được guard `cli/__tests__/docs-consistency.test.ts` khoá khớp `docs/PACKAGES.md`.
> **CẬP NHẬT 2026-06-02 (HEAD `6c0a9f6`, user OK): CHURN-CLUSTER PROMOTE → ON-BY-DEFAULT.** 4 cờ churn-correctness
> `toolCallReassembly`/`toolResultTailKept`/`resumeContinuation`/`autoContinue` lật default `hardened`→`true` (on cả 2
> profile; `AGENCY_*=0` vẫn opt-out về legacy) — vì user chạy legacy nên trước đó 4 fix churn (`cb932d8`/`9a0a03f`/
> `34a0f23`+`4d97563`/`1c6fc75`) vô dụng (bằng chứng ảnh anime-data.ts 14m56s churn). 3 cờ đầu correctness zero-cost;
> autoContinue thêm ≤MAX_AUTO_CONTINUE completion chỉ khi model báo unfinished. flags.ts JSDoc/comment cập nhật; 4 test
> OFF-case set `AGENCY_*=0` tường minh. `pnpm verify` REAL_EXIT_CODE=0 (core 474, cli 573). 36 cờ giữ 36 (chỉ default đổi).
> ⚠ User VẪN phải `pnpm -r build` + restart TUI (dist cũ vẫn churn). Live churn repro cần key (config placeholder).
> ▶ FRONTIER: §8.4 ảnh/multimodal (năng lực mới; type-widening lan tỏa + CẦN vision key verify e2e) · P2 §8.6 recall@k (cần provider-embedder/key). (Ngỏ: index re-index worker-offload + native-mode warning; promote hardened→default cho CÁC cờ CÒN LẠI [security enforce/prompt-cache/semantic-memory/context-compaction/path-confinement…] vẫn cần BYOK eval + user OK — churn-cluster ĐÃ tách ra promote riêng vì là correctness không cần key.)**

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

### 8.7 — Codebase indexing: kiểm incremental + độ tươi  ← ✅ XONG phần freshness (2026-06-02, commit `09443d6`)
- **SỰ THẬT.** `index/workspace-indexer.ts` (`buildIndex`/`incrementalUpdateAsync`/`isIndexStale`/`writeIndex`/`loadIndex`);
  ĐÃ wired vào context pack: `context/pack.ts loadIndex` trong `buildContextPack` → index THỰC SỰ nuôi prompt (retrieval live).
- **✅ ĐÃ SỬA (1) freshness + dead-code:** audit `incrementalUpdateAsync` ra nhánh `changedFiles` fast-path **built-but-unwired**
  (0 caller live truyền `changedFiles` — `updateKnowledgeGraphForFiles`/setup/index-cmd/TUI×2 đều gọi KHÔNG có) **+ BUGGY** (vòng
  lặp chỉ duyệt `existing.files` → file MỚI TẠO không bao giờ được thêm = đúng file model vừa ghi) **+ lợi biên** (chỉ bỏ qua
  *walk* rẻ; hashing đắt ĐÃ incremental ở full-merge path). XÓA fast-path + import `loadSymbolGraph` thừa + field `changedFiles`.
  Full-merge path (re-walk bắt new/deleted/renamed + giữ hash cũ khi mtime+size không đổi) là path DUY NHẤT còn lại = mọi caller
  đã dùng → behaviour-preserving. `loadSymbolGraph` GIỮ (live ở graph/builder + context/pack). Thay test dead-path bằng test
  real-fs khóa 3 mutation (new thêm / deleted rớt / changed re-hash + unchanged giữ hash). core 388→390, −81 dòng ròng.
- **CÒN NGỎ (P2, không bug):** (2) `isIndexStale` 5min — hợp lý, chưa đụng; (3) retrieval QUALITY (chọn đúng file vào pack, họ §8.6);
  (4) re-index đồng bộ trong dispatch = ứng viên offload worker-thread (surface cao).

### 8.8 — Sandbox + built-in tools: rà path + edge-case  ← ✅ 2 lỗi THẬT đã sửa (2026-06-02)
- **SỰ THẬT.** `security/sandbox.ts`: ưu tiên **docker** + fallback **native** (`--sandbox-mode native`). Self-kill guard ở
  `core/terminal/sandbox.ts` + `approval/policy.ts isSelfKillingCommand`.
- **✅ LỖI 1 — SELF-KILL "Blocked" mà KHÔNG chặn (báo user, commit `c03b9a2`):** model chạy `taskkill /F /IM node.exe … && npm
  run dev` để restart dev server. `isSelfKillingCommand` bắt đúng (giết MỌI node.exe gồm chính TUI) nhưng `runShellCommand` chỉ
  in `Security Warning … Blocked command` rồi **chạy tiếp**. Tệ hơn: `execute_command` gọi `runShellCommand(..., {yes:true})`
  hardcode → bypass approval gate → lệnh self-kill **THỰC SỰ CHẠY → tự sát TUI giữa turn**. SỬA: self-kill **HARD-refuse** ở đầu
  `runShellCommand` (throw TRƯỚC mọi exec, `yes` KHÔNG bypass — đây là phòng tuyến DUY NHẤT vì execute_command yes:true);
  message chỉ lối an toàn (chỉ chạy `npm run dev` — đã auto-detach; free port thì kill theo PID `netstat…findstr` + `taskkill
  /F /PID`, ĐỪNG `/IM node.exe`); audit denied. Detection giữ nguyên (kill PID CỤ THỂ khác vẫn cho — đúng lối an toàn). Viết lại
  2 test placeholder (`echo self-killing-test` vô hại) thành lệnh self-kill THẬT + assert refuse-cả-khi-yes + 1 test no-false-positive. core 390→391.
- **✅ LỖI 2 — DockerSandbox thiếu timeout + output-cap (commit `71cbe78`):** NativeSandbox có timeout (kill sau `options.timeout`,
  default 5min) + cap stdout/stderr (50MB/10MB) chống OOM; **DockerSandbox KHÔNG có cả hai** (`options.timeout` bị bỏ qua →
  container treo chạy vô hạn; output không giới hạn → OOM); `terminal/sandbox.ts` chỉ forward limit cho native. SỬA: DockerSandbox
  thêm timeout (timer → `docker rm -f` + kill child + resolve exit 124/timedOut; clear khi close/abort/dev-server-detach) +
  output-cap (`[TRUNCATED]` + event), giống native; forward `timeout`/`maxStdoutBytes`/`maxStderrBytes`/`onEvent` xuống docker.
  Test `sandbox.test.ts` +2 (hung→124+timeout event; stdout vượt cap→truncated). security 36→38.
- **✅ LỖI 3 — model CHURN trên lệnh bị chặn (ảnh 2 user, commit `ca2c954`):** sau khi self-kill bị refuse, model emit nhiều
  `taskkill /IM node.exe` VARIANT (470 tok, vẫn "Writing"). Gốc: `executeTool` gọi `recordToolSuccess` cho MỌI kết quả không-throw —
  kể cả chuỗi `Error…` (tool handler + refusal trả error dạng string) → nhánh `consecutiveFailures` của circuit-breaker CHẾT (lệnh
  refuse lặp tính "success" mãi); breaker lại là singleton module không reset giữa turn + `toolCallHistory` phình + identical-check
  KHÔNG bắt variant (command string khác nhau). SỬA: `executeTool` đếm kết quả `^Error[:\s]` là FAILURE → breaker `consecutiveFailures≥3`
  trip cả trên variant + trả "circuit breaker triggered"; reset breaker đầu MỖI turn (`resetToolCircuitBreaker` wired CẢ 2 path) chống
  leak xuyên turn; bound `toolCallHistory` 50. Test `circuit-breaker.test.ts` (5). core 391→396.
- **✅ §8.8-A — turn loop HARD-break trên circuit-breaker trip (commit `64e945a`):** trước đây breaker trip chỉ trả message string (soft)
  → model phớt lờ, churn variant tới maxLoops. SỬA: `executeTool` latch lý do vào module var `lastCircuitBreakerTripReason`; export
  `consumeCircuitBreakerTrip()` (read-and-clear; `resetToolCircuitBreaker` cũng clear). CẢ 2 turn loop gọi nó SAU khi append tool batch
  vào `turnHistory` → non-null thì fold `buildCircuitBreakerNotice(reason)` (nhà chung `turn-helpers.ts`, mirror `buildIncompleteTurnNotice`
  shape `⚠ [SYSTEM:]`) vào `llmText` (+`onDelta` ở stream) rồi **break**. KHÔNG cờ (đúng precedent §8.8 safety — breaker chỉ trip khi loop
  kẹt rõ ràng, soft-signal là bug). Path riêng với resume-notice `loopCount>=maxLoops`.
- **✅ §8.8-B — tolerate malformed `</tool_call>` wrappers (minimax, commit `64e945a`):** `parseToolCalls` regex nhận name attr nháy-đơn/có-space
  (`name='x' `) + whitespace trong close tag (`</tool_call >`, `</ tool_call>`). SUPERSET nghiêm của canonical → output đúng parse byte-identical;
  call recoverable hết bị nuốt im (nuốt → model tưởng đã chạy tool mà chưa → restart-from-scratch). No-close-tag (truncated) CỐ Ý KHÔNG recover
  (không có ranh giới body an toàn). Test `circuit-breaker-hardbreak.test.ts` (+3) + `tool-harness.test.ts` (+4). core 396→403. **→ §8.8 ĐÓNG TRỌN.**
- **✅ Egress allowlist — reputable read-only CDNs (commit `010880a`):** tiếp `aa14e48` (fonts.gstatic), default whitelist (`security/egress-proxy.ts`)
  thêm `cdn.jsdelivr.net`/`unpkg.com`/`cdnjs.cloudflare.com`/`esm.sh` (host cụ thể, KHÔNG wildcard) — agent scaffold web hay tham chiếu, GET-only static
  asset (exfil risk tối thiểu). Per-project vẫn thêm ở `.agency/security/egress-whitelist.json`. Test `egress-proxy.test.ts` +1 (CDN allowed; lookalike
  vẫn block — matchGlob exact cho non-wildcard). security 38→39.
- **CÒN NGỎ (ưu tiên thấp):** native-mode security-warning mạnh hơn; tool-handler edge khác (đa số đã chắc: truncate scale window,
  invokeSafe không throw, file-write atomic — đã verify).

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

> **✅ §8.10-A SLICE 1 ĐÃ XONG (2026-06-02, commit `710abb0`) — realtime status qua narration:** wire `emitThought`
> (producer narration canonical) tại main-turn tool loop CẢ 2 path (`stream.ts`+`orchestrator.ts`): khi KHÔNG agentId
> (main turn) → emit thought dựng từ tool name + `stepLabel` cấu trúc (KHÔNG regex) qua helper MỚI `describeToolActivity`
> (`turn-helpers.ts`, category-level 5 bucket: read→Reading / search→Searching / edit→Editing / exec→Running /
> dispatch→Spawning subagent; phân biệt CỐ Ý với `SemanticTranslator` richer của TUI — core không import được TUI).
> `App.tsx` ĐÃ subscribe `thought:emitted`→`emitHeartbeat`→status line + CognitionPanel → status giờ phản ánh REALTIME
> "đang làm gì" thay vì kẹt "Writing". KHÔNG event mới / cờ mới / dead-producer: gate bằng cờ SẴN CÓ `cognitionStream`
> (off-legacy no-op byte-identical / on-hardened). Test `tool-activity-narration.test.ts` (8). core 373→381.
>
> **✅ §8.10-B/D ĐÃ XONG (2026-06-02, commit `47c2667`):** (B) `App.tsx handleThought` giờ map mỗi thought (structured
> `source`/`phase`) → `activityPhase` qua hàm pure MỚI `activityPhaseFromThought` (`state/context-tracker.ts`:
> retrieval→reading / worker+editing→editing / sandbox→running / worker+planning→thinking / planner→routing /
> validator→analyzing; null = giữ nguyên) → status line hết rơi về "Writing" cũ khi `heartbeat.message` quá 10s; thêm phase
> "running" + label. Ride cờ `cognitionStream` (legacy 0 thought → 0 setActivityPhase → byte-identical; reset idle qua
> `processNextInQueue` khi queue cạn). (D) `ExecutionPanel` bỏ subtask HARDCODE GIẢ ("inspect routing"/"apply patches"/
> "compile application") → sub-line node ACTIVE = thought THẬT mới nhất (rỗng khi không có narration, KHÔNG fake); mapping
> phase→node-status trích sang hàm pure `computeExecutionPhaseStatuses` + mở rộng (editing/running→EXECUTE, analyzing→VERIFY).
> Test `execution-activity.test.ts` (10). tui 124→134.
>
> **✅ §8.10-E ĐÃ XONG (2026-06-02, commit `0849922`):** classification 7-pattern `[SYSTEM:]` từng copy-paste qua BA renderer
> (`SystemActivityLine` verbose LIVE · `formatSystemActivityLine` byte-identical **0 caller = DEAD** · `toConciseTelemetry`
> concise LIVE) — 2 bản đã drift (dead bản bold worker theo expandedTui, live luôn bold). Trích 1 hàm pure
> `parseSystemActivityLine(line)→{kind,cleanLine,worker?,toolName?,target?,args?,len?,gate?}`; 2 renderer live switch theo
> `kind`, JSX mỗi kind GIỮ NGUYÊN VĂN (output verbose/concise bất biến); XÓA `formatSystemActivityLine` (~135 dòng). Pure
> refactor, KHÔNG cờ. Test `trace-telemetry-parse.test.ts` (9). tui 134→143, −44 dòng ròng.
>
> **✅ §8.10-C ĐÃ XONG (2026-06-02, commit `fba316c`) → §8.10 ĐÓNG TRỌN:** 2 bug inline-trace, TUI-only. (1) **Nhãn sai**
> (`list_dir · short video`): `getGroundedTargetName` (`tool-labels.ts`) khi args JSON KHÔNG có path/command field thì fallback
> "first string value" → vớ nhầm free-text (task description). Giờ nhận thêm `TargetFile`/`AbsolutePath`/`SearchPath`/
> `DirectoryPath`, hết thì trả "" (không đoán).
>
> **▶ §8.11-D ✅ ĐÃ XONG (2026-06-02, commit `b40b1a6`):** rút gọn tool-docs args (cờ `AGENCY_COMPACT_TOOL_DOCS`) — xem §8.11(D)
> bên dưới. **CÒN LẠI §8.11:** (E) đổi tên `grep_file`/`grep_search` cho rõ + ứng viên patch tool / index-backed search.
>
> (2) **Correlation vỡ parallel**: started→completed nối qua module-global Map
> `lastToolTargets` keyed theo toolName → 2 tool song song/cùng tên ghi đè. Map THỰC RA vestigial — reader DUY NHẤT là nhánh
> completed non-expanded của `SystemActivityLine`, mà caller DUY NHẤT (Conversation.tsx:1359) luôn `expandedTui={true}`
> (dùng alias+char-count, KHÔNG target). Gỡ Map + set(exec) + get(completed) → hết state chia sẻ → hết collision.
> Behaviour-preserving thực tế (nhánh live không đổi). Test `tool-labels.test.ts` (5). tui 143→148.
> **§8.10 (TUI realtime) ĐÓNG: loop/resume + A narration + B/D phase&panel + E dedup + C label/correlation + F in-tool progress.**
> **✅ §8.10-F in-tool progress (commit này):** narration §8.10-A fire 1 LẦN trước tool → 1 tool chậm (grep lớn / đọc file to /
> lệnh dài) im suốt thời gian chạy → status kẹt. SỬA: helper `startToolProgressHeartbeat(toolName, stepLabel, enabled, intervalMs=4000)`
> (nhà chung `turn-helpers.ts`) — `setInterval` re-narrate qua `describeToolActivity`→`emitThought` kèm suffix elapsed ("Searching src/** (8s)");
> gọi ngay trước `await executeTool`, `stop()` trong `finally`; CẢ 2 turn path. `enabled` = `getRuntimeFlags().cognitionStream` truyền từ call-site
> (turn-helpers KHÔNG import flags) → off thì KHÔNG tạo timer = legacy byte-identical; timer `unref` không giữ process; tick đầu ở `intervalMs`
> nên tool nhanh không đổi. KHÔNG cờ mới (ride `cognitionStream`). Test `tool-progress-heartbeat.test.ts` (+2, fake timers) + stub trong
> `in-loop-compaction.test.ts` (mock turn-helpers DUY NHẤT). core 403→405. **§8.10 ĐÓNG TRỌN (6 slice).**

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
> mà vẫn nhanh + chất lượng cao." Audit từ source thật (lúc audit 17, nay **18** tool trong 1 `ToolRegistry`, auto-advertise qua
> `registry.listTools()`→`buildSystemPrompt`). Mỗi mục đo được, SỰ THẬT→LỖI→SỬA(+file).

**(A) `truncateToolResult` model-aware scaling CHẾT (built-but-unwired) — ✅ ĐÃ SỬA (commit `a550bd2`).**
- SỰ THẬT/LỖI: `skill/tool-harness.ts` gọi `require("@agency/providers")` trong **module ESM** → throw, bị
  try/catch nuốt → MỌI model rơi default ~30K chars (đo: 200k/16k/no-model đều 30040). Model nhỏ (≤16K) nhận
  full result → nguy cơ tràn (họ §8); "scale theo window" trong docs là SAI.
- SỬA: import static `getModelSpec` (providers leaf, no cycle) + re-tune token-conscious: nhỏ (<32K, bắt cả model
  báo 16385) → 8K; lớn (≥200K) → **48K (KHÔNG còn 400K-char/~100K-token dump** — truncation note đã bảo model lấy
  thêm qua `read_file` ranges); medium → 32K. +4 test regression. ÍT token + an toàn tràn.

**(B) prompt caching — ĐÒN BẨY TOKEN LỚN NHẤT.  ← phần (1) reorder ✅ ĐÃ XONG; phần (2) Anthropic cache_control CÒN MỞ**
- SỰ THẬT. grep `cache_control|prompt_cache|ephemeral` trong `packages/providers` = **RỖNG**. System prompt cố định đo
  được **~2069 token/turn** (tool-docs 1109 + prose ~960), GỬI MỖI TURN + contextPack + history. `buildSystemPrompt`
  (`chat/prompt.ts`) xếp **VARIABLE lên ĐẦU**: `anchorBlock` (goal pillars từ user msg) + `intent/workflow` (dòng 66-70)
  trước protocol+tool-docs (STATIC).
- LỖI. (a) Anthropic không gắn `cache_control:{type:"ephemeral"}` → mỗi turn trả FULL giá input cho phần static
  (đáng ra cache ~10% giá). (b) OpenAI-compatible (NVIDIA/openrouter/deepseek) có **automatic prefix caching** nhưng
  CẦN prefix ổn định — đặt VARIABLE lên đầu **phá** prefix cache → 0% hit. Đây là token phí lớn nhất cho hội thoại dài.
- **✅ SỬA (1) reorder ĐÃ XONG (2026-06-01).** `buildSystemPrompt` (`chat/prompt.ts`) tách prompt thành segment theo độ
  ổn-định-trong-phiên: **static** (identity+protocol+tool-docs) → **sessionAnchor** (anchorBlock goal-pillars, ổn định/phiên)
  → **variableTail** (route intent + contextPack + memories + user-question, đổi mỗi turn). Cùng bộ string, 2 thứ tự ráp
  (KHÔNG nhân đôi prose): cờ MỚI `AGENCY_PROMPT_CACHE`/`promptCachePrefix` **ON** → static-prefix-first (bật automatic
  prefix-cache cho MỌI openai-compatible, 0 đụng adapter); **OFF (legacy)** → thứ tự cũ **byte-identical**. Pure reorder
  (cùng element-count + join "\n" → length bất biến giữa 2 mode = bằng chứng không thêm/bớt nội dung). off-legacy/on-hardened,
  surface ở `agency status` (`buildFlagRows`). Test `prompt-cache-order.test.ts` (5: legacy intent-before-tools / cache
  tools-before-intent + start "You are Agency CLI" / length-bất-biến / hardened default on / override giữ đầu). core 355→360,
  **28 flag**.
- **✅ SỬA (2) Anthropic cache_control ĐÃ XONG (2026-06-01).** Adapter Anthropic (`providers/anthropic.ts`) gắn
  `cache_control:{type:"ephemeral"}` vào block `body.system` khi bật (Anthropic KHÔNG có automatic prefix-cache — phải khai
  tường minh, KHÁC openai-compatible). Helper `buildSystemField(system, cache)` dùng chung cho CẢ `complete` + `streamComplete`
  (off → string thuần như cũ; on → `[{type:"text",text,cache_control:{type:"ephemeral"}}]`). Providers là leaf → KHÔNG đọc core
  flags → thêm `cacheSystemPrompt?: boolean` vào `CompleteOptions`, core set từ `getRuntimeFlags().promptCachePrefix` tại CẢ 2
  call-site mang system prompt (`stream.ts` llmOpts + `orchestrator.ts` complete-opts); summarizer (`turn-helpers.ts`) KHÔNG set
  (không có system prompt). Caching GA trên Claude 3+ → KHÔNG cần beta header; model không hỗ trợ thì bỏ qua directive (request
  vẫn thành công, nội dung y hệt) → an toàn không-key. Reuse cờ `promptCachePrefix` (KHÔNG cờ mới). Body-shape verify không cần
  key (test `anthropic.test.ts` +2: default string / on → cache_control block); đo cache-hit thật cần BYOK key. providers 850→852.

**(C) "5-APPROACHES RULE" ép 5 hướng mỗi turn planning — phí OUTPUT token + formulaic.  ← ✅ XONG (2026-06-01)**
- SỰ THẬT. `chat/prompt.ts` (rule "2." trong protocol segment) ép "MUST outline exactly 5 distinct approaches ... sort by
  recommendation ... pros/cons, success criteria, next command" cho MỌI đề xuất planning/architecture.
- LỖI. Task đơn giản cũng phải đẻ 5 hướng = tốn output token (đắt hơn input) + cứng nhắc, có khi giảm chất lượng (lan man).
- **✅ SỬA ĐÃ XONG.** `buildSystemPrompt` chọn `approachesRule` theo cờ MỚI `AGENCY_SOFT_APPROACHES`/`softApproaches`
  (off-legacy/on-hardened): **off** giữ NGUYÊN VĂN "THE 5-APPROACHES RULE … exactly 5 distinct" (byte-identical); **on** →
  "SOLUTION OPTIONS: outline a few (typically 2–3) … scaled to the task's complexity — a simple task may warrant a single
  clear recommendation rather than padded alternatives" + PRIORITIZATION GRADIENT gọn lại. Độc lập với cờ reorder (đều đọc
  từ 1 `const flags`). Test `prompt-cache-order.test.ts` +4 (legacy verbatim / on dropped exactly-5 / hardened default on /
  independent of cache flag). core 360→364, **29 flag**, surface `agency status` (`buildFlagRows` "Soft approaches").

**(D) Tool-docs re-list args 18 tool mỗi turn (~1109 token).  ← ✅ XONG (2026-06-02, commit `b40b1a6`)**
- SỰ THẬT. `formatToolDocs` (`prompt.ts`) liệt mọi tool + mọi arg mỗi turn, mỗi arg 1 dòng `- \`<x>\`: Parameter of
  type string.` → boilerplate "Parameter of type string." lặp = phí thuần (model chỉ cần TÊN arg + optional + type khác-string).
- **✅ SỬA.** Cờ MỚI `AGENCY_COMPACT_TOOL_DOCS`/`compactToolDocs` (off-legacy verbose byte-identical / on-hardened): gộp args
  built-in mỗi tool thành 1 dòng `Args: \`a\`, \`b?\`: boolean` (tên + `?` optional + type-suffix CHỈ khi khác string). MCP tool
  (có per-arg description đáng giữ) GIỮ verbose cả 2 mode. Trích `describeZodArg` (optional/type) dùng chung verbose+compact (không
  parse trùng). Surface `agency status`. Test `tool-docs-compact.test.ts` (5: verbose-off byte / compact Args + hết boilerplate /
  ngắn hơn hẳn / hardened default on / optional `?`+type). core 381→386, **31 cờ**.

**(E) Hoàn chỉnh/độ rõ (minor, KHÔNG bug). ← ✅ XONG (2026-06-02, commit `00f5312`) → §8.11 ĐÓNG TRỌN**
- **✅ ĐÃ LÀM (an toàn):** `grep_file` (1 file) vs `grep_search` (workspace recursive) distinct thật nhưng tên dễ nhầm → **clarify
  mô tả cross-reference** (mỗi tool nêu scope + trỏ tool kia) để model tự chọn đúng. Behaviour-preserving (chỉ wording mô tả,
  auto-advertise; KHÔNG cờ — cùng class với steering write_file ở append_file). Test `tool-harness.test.ts` +2. core 386→388.
- **❌ CỐ Ý KHÔNG LÀM (assessed, ghi lý do):** (a) **đổi tên** `search_in_file`/`search_workspace` — ripple TOOL_ALIASES +
  narration set + semantic-orchestration + security-escalation + vỡ recorded-trace/model emit tên cũ = chi-phí > lợi clarity biên,
  KHÔNG behavior-preserving; clarify mô tả đạt mục tiêu an toàn hơn. (b) **patch/unified-diff tool** — TRÙNG `batch_edit` (đã
  atomic multi-hunk search/replace 1 file) → vi phạm chống-trùng-lặp. (c) **index-backed search** — rủi ro correctness (index
  stale bỏ sót file mới ghi); grep_search đọc tươi + honor gitignore là đúng.

> **Thứ tự §8.11:** B (caching — token win lớn nhất) → C (5-approaches) → D → E. Cờ cho thay đổi prompt; tái dùng catalog
> `capabilities`/adapter interface; test + `pnpm verify` xanh. **A + B (reorder + Anthropic cache_control, cờ
> `AGENCY_PROMPT_CACHE`) + C (5-approaches soften, cờ `AGENCY_SOFT_APPROACHES`) đều XONG. ▶ NEXT: D (tool-docs rút gọn arg) →
> E (grep naming/patch/index-search).**

### Thứ tự đề xuất cho session sau
**~~P0: 8.2 + 8.3 + 8.1~~ ✅** + **~~§8.5 paste dài~~ ✅** + **~~§8.11-A/B/C token-efficiency~~ ✅** + **~~2 runtime fix ảnh user
(append_file + egress fonts.gstatic.com)~~ ✅** (2026-06-01) — xem các mục trên + banner đầu §8.
**▶ NEXT P1 — 2 nhánh (user ưu tiên):**
- **§8.10 TUI realtime activity** (user báo trực tiếp 2026-06-01, "đang làm gì chưa realtime + UX chưa chuyên nghiệp"):
  event tool-lifecycle cấu trúc cho main turn (gốc A) → lái status/phase realtime (B) → gộp 4 bề mặt + dedup 3 bản render
  (D/E) → progress per-tool (C). Xem §8.10 ở trên (đã chẩn đoán từ source). **+ SUB-ITEM loop/resume ✅ ĐÃ XONG (2026-06-01):**
  ~~max-loop-limit + "tiếp tục" ghi LẠI từ đầu~~ → khi chạm `maxLoops`, helper dùng chung `buildIncompleteTurnNotice`
  (`chat/turn-helpers.ts`) dựng notice 1 dòng `[SYSTEM:]` (model + TUI activity-parser thấy gist) + phụ lục liệt mọi file đã
  sửa kèm size đĩa THẬT (lines + bytes), **nối vào `llmText`** (CẢ 2 turn path stream + non-stream) → persist vào history
  → turn "tiếp tục" thấy chỉ dẫn "read_file rồi append_file/edit_file, ĐỪNG rewrite từ đầu" + trạng thái file thật. Cờ MỚI
  `AGENCY_RESUME_CONTINUATION`/`resumeContinuation` (off-legacy giữ notice "Response truncated" cũ byte-identical + KHÔNG
  persist / on-hardened). Test `resume-continuation.test.ts` (6: pure helper ×3 + wiring stream ON/OFF + non-stream ON).
  core 367→373, **30 cờ**, row `agency status` "Resume continuation". KHÔNG đụng `maxLoops` value (giữ 15/8/3 — chỉ trị
  resume, không nới cap = tránh runaway). **CÒN LẠI §8.10:** realtime event A/B/D/E/C (chưa code).
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
