# AgencyCLI — Prompt cho session sau (UX chuyên nghiệp · triệt để amateur-tell · BYOK để CUỐI)

> **Cách dùng:** dán nguyên khối từ dòng `---` dưới đây vào tin nhắn đầu của một phiên Claude Code mới trên repo này.
> Prompt **trỏ tới** docs/memory thật (không sao chép nội dung) nên không tự trùng lặp và luôn đồng bộ với docs.
> Số liệu là ảnh chụp lúc soạn (2026-06-02, HEAD `65c84a0` trên `master`, cây sạch) — phiên mới **xác nhận lại bằng docs + `git log` + `pnpm verify`**.

---

Bạn tiếp quản **AgencyCLI** (`D:\AgencyCLI`) — monorepo **pnpm, 16 package**, runtime agent **tự hành cục bộ** (KHÔNG phải chatbot). Hai "bệnh" cốt lõi phải luôn cảnh giác: (1) **machinery xây xong nhưng không nối dây** và (2) **trùng lặp logic/file/UI/kiến trúc**. Ba nguyên tắc bất di bất dịch: **không tạo trùng lặp · không xây thứ treo lơ lửng · VERIFY chứ đừng assert**.

## 0. ĐỌC TRƯỚC khi làm bất cứ gì (đúng thứ tự)
1. `memory/MEMORY.md` (index 1 dòng) → `memory/agencycli-section8-overflow.md` (chi tiết §8 + UX/amateur-tell + facts "đừng-điều-tra-lại") → `memory/agencycli-production-hardening.md` (nhật ký + git chain).
2. `docs/ROADMAP_HANDOFF.md` → **§2.2** (completion-detection — auto-continue đã xong) + **§8** (banner + các item). Mỗi item ghi SỰ THẬT → LỖI → SỬA (+file). Đừng điều tra lại root-cause đã ghi.
3. `docs/SESSION_HANDOFF_PROMPT.md` — luật chống-trùng (mục 1), wired-or-dead + **6 guard** (mục 2), verify-đừng-assert (mục 3), quy ước cờ/kiến trúc (mục 4), nhịp slice (mục 5), **xử lý BYOK key AN TOÀN (mục 6.1 — key chỉ ở env, KHÔNG lên đĩa)**.
4. `docs/PACKAGES.md` → **"Canonical Homes & No-Duplication Map"** + "Built-in tools" (20 tool, MỘT `ToolRegistry`) — tra TRƯỚC khi thêm helper/module/tool/command.

> **Bài học nhãn cũ:** kiểm dead-code phải grep CẢ `.ts`+`.tsx`+`.mts`. Verify-đừng-assert áp cả script audit tự viết (background output có thể bị cắt). Soi `git status`/`git show` trước+sau commit để khỏi gom file lạ.

## 1. ƯU TIÊN HIỆN TẠI CỦA USER (quan trọng nhất — đọc kỹ)
User chốt rõ: **trước tiên đảm bảo MỌI THỨ trong AgencyCLI vận hành ĐÚNG hướng, đúng logic, tools hiệu quả, và TUI/UX rõ ràng như opencode NHƯNG tinh chỉnh để XỊN HƠN + chuyên nghiệp hơn.** **QUY TẮC TỐI THƯỢNG: KHÔNG được có amateur tell — triệt để amateur tell ở MỌI NGÓC NGÁCH source.** **BYOK (eval legacy↔hardened + promote `hardened`→default) là bước KIỂM TRA CUỐI CÙNG**, chỉ làm SAU khi mọi thứ vận hành đúng + UX chuyên nghiệp. **ĐỪNG nhảy vào BYOK/eval sớm.**

## 2. ĐÃ XONG phiên 2026-06-02 (HEAD `65c84a0`, cây sạch) — ĐỪNG làm lại
> ⚠️ **NHẮC USER REBUILD/RESTART TUI** (`pnpm -r build`): fix ở `src`, TUI đang chạy `dist` cũ chưa thấy hiệu lực.
- **Robustness e2e bậc 3-4 (completion-detection + self-heal) ĐÓNG đáng kể:**
  - **Auto-continue khi model dừng giữa việc** — prose `34a0f23` (`detectIncompleteCompletion`: lời-hứa-tiếp-tục/"to be continued"/placeholder, neo cuối message, loại câu hỏi/lời-mời) + artifact `4d97563` (`detectTruncatedArtifact`: quét file vừa ghi tìm `// ...rest of the code`/`// ...existing code...` trên đĩa). Cờ MỚI `AGENCY_AUTO_CONTINUE`, chặn trần `MAX_AUTO_CONTINUE`=3, canonical `turn-helpers.ts`. Off-legacy byte-identical=break.
  - **verify-main-turn WIRE VÀO TUI** `548169a` (App.tsx gọi `runChatTurnWithVerify`; reset buffer + báo qua `chat:self-healing`) + **`chat:verify-failed` surface** `cd0fb53` (hết round vẫn fail → 1 dòng cảnh báo). Gỡ stale comment "TUI cố ý chưa wire".
- **Chiến dịch amateur-tell (6 commit, UX chuyên nghiệp hơn opencode):**
  - `eb19ba5` provider remote (openai/openrouter/nvidia) **luôn hiện trong picker** dù thiếu key (trả fallback catalog thay vì `[]` — trước nvidia "tự biến mất"); `models.ts`.
  - `8f01437` tool-result summary có nghĩa: `completed with result length: N characters` → **"42 lines"/"7 matches"/"exit 0"/"1.2 KB"** (`summarizeToolResult` export từ stream.ts + `parseSystemActivityLine` đọc summary, giữ back-compat).
  - `5213685` tool labels plain: bỏ **hardcode tên-file-CỦA-REPO** ("App.tsx"→"main application runtime container") + verbiage hoa mỹ ("Synthesizing X components"/"validation suite via npm") → **Read/Write/Edit/Run/Search…** như opencode (`tool-labels.ts`).
  - `762f49d` auto-refresh model list ngay sau `/connect` lưu key.
  - `538810c` ConnectOverlay copy terse (bỏ "CONNECTION MANAGER"/"DANGER ZONE"/"CONFIRM DELETION"/"ACTIVE CREDENTIAL FOUND"/"Credentials Integration Setup"/"[CONNECTED]").
  - `65c84a0` de-shout headers: "✦ CODEBASE INDEXED SUCCESSFULLY"/"◈ SUBAGENT KERNEL"/"◈ AGENT THINKING" → sentence case.
- **Baseline verify:** build 16/16, **REAL_EXIT_CODE=0**, **~2190 test** (core **431** · cli 573 · tui **154** · providers **855** · memory 48 · benchmark 18 · workspace 11 · security 39 · tooling 14 · governance 7 · skills-bridge 14 · context 6 · heuristics 6 · browser 5 · telemetry 9). **33 cờ** · **20 tool**.

## 3. VIỆC KẾ TIẾP — chiến dịch amateur-tell + đúng-logic (iterative, không cần key)
- **(a) Quét wording amateur còn lại** (no-rework, an toàn): các overlay CHƯA rà (Help/Status/Models/Skills/Plugins/Review/Mcp/Sessions/Splash/WelcomeMenu) — tìm SHOUTING/bracketed-CAPS/dramatic copy như đã làm ConnectOverlay; `PatchCard` `[MODIFY]/[REMOVE]/[RENAME]`; error message thô; viết hoa/chấm câu không nhất quán. Grep gợi ý: `\[[A-Z][A-Z _]{3,}\]`, `DANGER|WARNING:|SUCCESSFULLY|KERNEL|◈ [A-Z]{3,}`. Display-only, cập nhật test nếu assert chuỗi.
- **(b) Badge "needs key" trong provider picker** (follow-up `eb19ba5`): provider hiện qua fallback nhưng CHƯA đánh dấu "chưa cấu hình" → user tưởng đã sẵn. Thêm dấu/hint + (lý tưởng) chọn keyless → mở `/connect`.
- **(c) LỚN NHẤT — structured tool-card thay text-in-stream** (đòn bẩy "xịn hơn opencode" rõ nhất; rework NHIỀU SLICE, thiết kế cẩn thận): tool activity hiện là TEXT `⚡ [SYSTEM: Executing tool "X"...]` nhồi vào assistant message rồi **regex-parse lại** (`TraceTelemetry.parseSystemActivityLine`) = round-trip lossy. §8.10 cố ý KHÔNG làm vì là "surface thứ 5". Hướng: event tool-lifecycle cấu trúc (tái dùng EventBus, ĐỪNG thêm surface thứ 5 lạc) → render thành card riêng (tool · target · status · summary) tách khỏi prose. Lên kế hoạch trước khi code.
- **(d) Rà ĐÚNG-LOGIC vận hành + tools hiệu quả:** chạy agent trên task thật (cần key — xem caveat), quan sát hành vi sai/tool kém hiệu quả; sửa gốc. Phần verify-without-key: đọc code path, tìm built-but-unwired/logic sai.

## 4. ⚠ CONFIG-STATE CỦA USER (không phải bug code — ĐỪNG tự sửa key)
`~/.agency/config.json` hiện chỉ có `openrouter`/`anthropic`/`local`; **nvidia KHÔNG còn**; tất cả key là placeholder `${...}` với env **CHƯA set** → `resolveApiKey`→`""` → **không provider nào dùng được** cho tới khi user đặt key thật. **TUYỆT ĐỐI không tự ghi key** (§6.1). User thêm key qua `/connect` (overlay liệt kê cả 6 provider, gồm nvidia). Sau /connect → mở `/models` để fetch model live (`listAllModels`→`/v1/models`).

## 5. NHỊP MỖI SLICE + CẤM KỴ (xem SESSION_HANDOFF §3–§4)
investigate (đọc + grep CẢ `.ts/.tsx/.mts`, tra Canonical Homes) → phân loại (trùng-thật vs distinct-cố-ý; wire vs delete) → thay đổi **tối thiểu, behavior-preserving, tái dùng canonical home** → **cờ trong `runtime/flags.ts` nếu đổi hành vi runtime** (legacy byte-identical; tool/command/UI-copy thuần additive = KHÔNG cần cờ) → thêm/cập nhật test → **`pnpm verify` XANH (REAL_EXIT_CODE=0, 16 pkg)** → commit nhỏ trên `master` (soi `git status` trước `add`, KHÔNG amend/`--no-verify`, trailer `Co-Authored-By: Claude Opus 4.8`) → sync living docs (ROADMAP/SESSION_HANDOFF/PACKAGES) → cập nhật `memory/` + git chain. **Giữ 6 guard xanh.**
- Không assert "green". Không xóa/sửa khi chưa grep 0 live importer (CẢ `.tsx`). Không gộp cặp "trùng tên cố ý". Không tạo helper/tool/command trùng. **Không tự promote hardened→default. Không tự ghi BYOK key. BYOK là bước CUỐI.**

**Bắt đầu:** đọc §0 → **NHẮC user `pnpm -r build` + restart TUI** → tiếp tục chiến dịch amateur-tell theo §3 (gợi ý: (a) quét wording overlay còn lại trước vì nhanh+an toàn, hoặc lên kế hoạch (c) tool-card nếu user muốn đòn bẩy lớn). Làm theo nhịp §5. **BYOK/eval/promote chỉ khi user xác nhận mọi thứ đã đúng + UX chuyên nghiệp.**
