# AgencyCLI — Prompt cho session sau (runtime-quality · token-efficiency · multimodal · TUI/UX)

> **Cách dùng:** dán nguyên khối từ dòng `---` dưới đây vào tin nhắn đầu của một phiên Claude Code mới trên repo này.
> Prompt **trỏ tới** docs/memory thật (không sao chép nội dung) nên không tự trở thành bản trùng lặp và luôn đồng bộ với docs.
> Số liệu trong prompt là ảnh chụp lúc soạn (2026-06-01, HEAD `515b5a5`) — phiên mới **xác nhận lại bằng docs + `git log` + `pnpm verify`**.

---

Bạn tiếp quản **AgencyCLI** (`D:\AgencyCLI`) — monorepo **pnpm, 16 package**, runtime agent **tự hành cục bộ** (KHÔNG phải chatbot), đang trong chiến dịch production-hardening + nâng chất lượng runtime. Hai "bệnh" cốt lõi của repo phải luôn cảnh giác: (1) **machinery xây xong nhưng không nối dây** (built-but-unwired) và (2) **trùng lặp logic/file/UI/kiến trúc**. Ba nguyên tắc bất di bất dịch: **không tạo trùng lặp · không xây thứ treo lơ lửng · VERIFY chứ đừng assert**.

## 0. ĐỌC TRƯỚC khi làm bất cứ gì (đúng thứ tự)
1. `memory/MEMORY.md` (1 dòng index) → `memory/agencycli-section8-overflow.md` (chi tiết "hướng mới" + facts "đừng-điều-tra-lại") → `memory/agencycli-production-hardening.md` (nhật ký campaign + git chain).
2. **`docs/ROADMAP_HANDOFF.md` → §8 (banner đầu mục + §8.1–§8.11)** — đây là bản đồ việc. Mỗi item ghi **SỰ THẬT → LỖI → SỬA (+file)** từ source thật; mục đã ✅ thì đừng làm lại, mục 🔴/🟡/🟢 là việc còn lại. **ĐỪNG điều tra lại root cause — đã nằm trong §8.**
3. `docs/SESSION_HANDOFF_PROMPT.md` — luật chống-trùng-lặp (mục 1), wired-or-dead + **6 guard** (mục 2), verify-đừng-assert (mục 3), quy ước cờ/kiến trúc (mục 4), nhịp slice (mục 5), trạng thái mới nhất (mục 6), **xử lý BYOK key AN TOÀN (mục 6.1 — key chỉ ở env, KHÔNG lên đĩa)**.
4. `docs/PACKAGES.md` → **"Canonical Homes & No-Duplication Map"** — tra TRƯỚC khi thêm BẤT KỲ helper/module/tool/command nào. Có "nhà" rồi → tái dùng.

> **Bài học nhãn cũ:** khi kiểm dead-code phải grep CẢ `.ts` + `.tsx` + `.mts` (false-dead `semantic-orchestration.ts` từng wired qua `App.tsx`). Verify-đừng-assert áp cả cho **script audit tự viết** (background output có thể bị cắt — bài học cont'd 24; chạy lại trọn vẹn trước khi kết luận).

## 1. ĐÃ XONG phiên trước (2026-06-01, HEAD `515b5a5` trên `master`, cây sạch) — ĐỪNG làm lại
- **`b83b55a` fix crash TUI render-loop** (ảnh user): `stripToolCalls(m.content)` gọi không-guard ở `calculateFormattedLines` lúc render, `m.content` có thể `undefined` → "reading 'indexOf'" → ErrorBoundary loop. Coerce non-string→"" tại canonical home.
- **`106ee22` P0 overflow §8.1+8.2+8.3** (trị crash BYOK minimax/NVIDIA 197270 > 196608): §8.2 catalog provider-aware (`getCatalogSpec(model, providerId?)` clamp conservative robust-min → minimax/nvidia ra **196608**); §8.3 estimator err-high (`len/3.5` + overhead + non-string); §8.1 `reduceHistoryToFit` (helper dùng chung 2 turn path, cắt THÂN hội thoại thật) + **chặn ratchet phá hoại** (honor parsedLimit thật thay vì `oldLimit*0.8` mỗi vòng — cái đẩy minimax 196608→16887 ghi đĩa). Đã dọn override hỏng `16887` trong `~/.agency/config.json` (KHÔNG đụng API key).
- **`2172832` §8.5 paste dài** (verify-đừng-assert): gốc thật = perf (`applyTextInput` append mỗi ký tự → O(n²) freeze); sửa = gom 1 setBuffer O(n). **Cap chiều cao ĐÃ CÓ sẵn** (`PromptComposer` MAX_LINES=6) → không làm lại; **bracketed-paste KHÔNG bật** (Ink đã coalesce paste; bật `?2004h` sẽ vỡ).
- **`a550bd2` §8.11-A fix `truncateToolResult` CHẾT**: `require("@agency/providers")` trong ESM → throw → mọi model rơi default 30K chars (model nhỏ không được bảo vệ tràn). Sửa = import static `getModelSpec` + re-tune token-conscious (nhỏ<32K→8K, lớn≥200K→**48K** không còn 400K dump, medium→32K).
- **Docs/chẩn đoán đã ghi sẵn:** `dd9e581` (§8.10 TUI realtime), `515b5a5` (§8.11 token audit).
- **Baseline verify:** build 16/16, **REAL_EXIT_CODE=0**, ~2067 test (core 355 · cli 573 · tui 124 · providers 850 · memory 36 · benchmark 18 · workspace 11 · security 35 · tooling 14 · governance 7 · skills-bridge 14 · context 6 · heuristics 6 · browser 5 · telemetry 9). **27 cờ** (xác nhận qua `agency status` / `flags.ts`).

> **User đang TEST fix crash thật** (restart TUI, chạy lại minimax/NVIDIA + hội thoại dài) trước khi quyết nhánh kế. Nếu user báo còn lỗi → đọc `.agency/crash.log`, hỏi profile (legacy/hardened) + model/provider, điều tra từ source.

## 2. VIỆC KẾ TIẾP — chọn theo ưu tiên user (cả 3 đã chẩn đoán sẵn trong ROADMAP §8)

### 🔴 §8.11-B — Prompt caching = ĐÒN BẨY TOKEN LỚN NHẤT ("ít token cho MỌI model")
- **Đã đo:** system prompt cố định **~2069 token GỬI MỖI TURN** (tool-docs 1109 + prose 960); grep `cache_control|prompt_cache` trong `packages/providers` = **RỖNG**. `buildSystemPrompt` (`chat/prompt.ts`) xếp **VARIABLE lên đầu** (goal pillars/intent/workflow) → **phá automatic prefix-cache** của openai-compatible.
- **SỬA (2 phần):** (1) **reorder `buildSystemPrompt`: STATIC prefix trước** (protocol + tool-docs) → anchorBlock (ổn định/phiên) → contextPack/memories/user-question cuối → bật automatic prefix-cache cho NVIDIA/openrouter/deepseek — **verify được KHÔNG cần key** (đo độ ổn định prefix + test snapshot). (2) Adapter Anthropic gắn `cache_control:{type:"ephemeral"}` block cuối system — **cần BYOK key để đo cache-hit thật**. **Giấu sau cờ** (reorder đổi prompt mọi model nhìn → legacy byte-identical). Đây là phần user gợi ý làm tiếp ("phần an toàn không cần key").

### 🟠 §8.10 — TUI realtime activity ("đang làm gì" chưa realtime; UX chưa chuyên nghiệp)
- **Gốc lớn nhất (A):** main turn KHÔNG phát event tool có cấu trúc — nó nhồi text `[SYSTEM: Executing tool…]` vào stream LLM (`chat/stream.ts:70` `formatToolCallNotice` + onDelta) rồi TUI **regex-parse lại** (`conversation/TraceTelemetry.tsx` + `utils/conversation/tool-labels.ts`). Vòng lossy → nhãn sai (`list_dir·short video`), 2 dòng/tool, global `lastToolTargets` Map (vỡ khi parallel). `subagent:progress` cấu trúc CHỈ fire khi `agentId` set = chỉ subagent.
- **(B)** `activityPhase` chỉ "routing→writing→idle", không đổi theo tool + heartbeat chỉ update khi `thought:emitted` → status kẹt "Writing 8m39s". **(D)** 4 bề mặt chồng chéo (`ExecutionPanel` cây phase HARDCODE giả). **(E)** `SystemActivityLine`≈`formatSystemActivityLine`+`toConciseTelemetry` = 3 bản render trùng.
- **SỬA (thứ tự A→B→D/E→C):** phát **1 event tool-lifecycle cấu trúc cho main turn** (tái dùng EventBus / `emitThought` — KHÔNG thêm bề mặt thứ 5) mang `{callId, toolName, target, status, durationMs}` → TUI lấy nhãn thẳng từ `tc.arguments` (hết regex), 1 dòng/tool transition theo `callId`, lái `activityPhase` realtime (read→Reading, grep→Searching, edit→Editing) → gộp bề mặt + dedup render.

### 🟡 §8.4 — Gửi ảnh / multimodal (đa tầng, làm END-TO-END kẻo treo type)
- `ChatMessage.content: string | ContentPart[]` (additive, default string byte-identical) + **1 helper canonical** `messageContentToText` ở providers (mọi string-op tái dùng — blast radius: 3 adapter `anthropic/google/openai-compatible` + core history + TUI). Adapter openai-compatible map `image_url` **CHỈ khi** `getModelSpec(model).capabilities.vision` (catalog đã phát hiện — tái dùng, không đoán). Estimator §8.3 ĐÃ đếm `IMAGE_PART_TOKENS` sẵn. **Producer:** TUI đính ảnh — tận dụng cơ chế `@`-path đã resolve+badge IMG (`PromptComposer`), đọc file→base64→ContentPart. ⚠️ Phải nối dây trọn vẹn (producer→type→adapter) — thêm `ContentPart[]` mà chưa có producer = built-but-unwired.

### 🟢 Token-efficiency còn lại + P2 (sau B/8.10/8.4)
- **§8.11-C** "5-APPROACHES RULE" (`chat/prompt.ts:77`) ép 5 hướng/turn → phí output token; mềm hoá (cờ). **§8.11-D** rút tool-docs args. **§8.11-E** đổi tên grep cho rõ + ứng viên: **patch tool** (sửa nhiều hunk ít token hơn rewrite) + **index-backed search** (`grep_search` đang walk lại cây; `loadIndex` đã có).
- **§8.6** memory recall precision@k (embedder placeholder). **§8.7** index incremental/độ tươi. **§8.8** sandbox edge-case.

## 3. NHỊP MỖI SLICE (bắt buộc, lặp lại)
investigate (đọc + grep CẢ `.ts/.tsx/.mts`, tra Canonical Homes) → phân loại (trùng-thật vs distinct-cố-ý; wire vs delete) → thay đổi **tối thiểu, behavior-preserving, tái dùng canonical home** → **cờ trong `runtime/flags.ts` nếu đổi hành vi** (legacy byte-identical; risky=off-legacy/on-hardened; tốn-kém=opt-in off cả hai) → thêm/cập nhật test → **`pnpm verify` XANH (REAL_EXIT_CODE=0, 16 pkg)** → commit nhỏ trên `master` (cây sạch, KHÔNG amend/`--no-verify`, trailer `Co-Authored-By: Claude Opus 4.8`) → sync living docs (ROADMAP/SESSION_HANDOFF/PACKAGES + thêm row Canonical Homes nếu có nhà mới) → cập nhật `memory/` + git chain. **Giữ 6 guard xanh** (skills↔manifest · agents↔prompt/seed · flags↔status · cycles-module · cycles-package · deps↔imports). Thêm skill/agent/flag/dep mới → cập nhật manifest/seed/`buildFlagRows`/package.json trong CÙNG slice.

## 4. Cấm kỵ
- Không assert "green" — chạy `pnpm verify` trước khi commit (bỏ qua warning cố ý: failover/rate-limit/Playwright-missing/docker-unreachable).
- Không xóa/sửa khi chưa grep xác nhận 0 live importer (CẢ `.tsx`). Không gộp cặp "trùng tên cố ý" (`ReplayEngine`, `truncateText`, `ToolCall`, `GraphEdge`, `VerificationResult`, `AuditEntry`…).
- Không tạo helper/tool/estimator/command trùng cái đã có — tra Canonical Homes trước.
- Không tự `promote hardened→default` (cần BYOK eval delta sạch + user OK rõ ràng).
- BYOK key (nếu user cấp): theo `SESSION_HANDOFF §6.1` — backup config, placeholder `${VAR}`, `trap … EXIT` restore trong CÙNG lệnh bash, key chỉ ở env per-command, xác nhận `grep -rn "nvapi-\|sk-" packages docs` RỖNG sau khi xong.

**Bắt đầu:** đọc §0 → mở ROADMAP §8 (banner + §8.10/§8.11/§8.4) → hỏi/chốt user muốn nhánh nào (gợi ý: **§8.11-B reorder prompt caching** = token win lớn nhất, verify không cần key) → làm theo nhịp §3.
