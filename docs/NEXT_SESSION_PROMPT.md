# AgencyCLI — Prompt cho session sau (hướng mới: chất lượng runtime + đa phương thức)

> **Cách dùng:** dán nguyên khối dưới đây vào tin nhắn đầu của một phiên Claude Code mới trên repo này.
> Prompt **trỏ tới** docs thật (không sao chép) nên không tự trở thành bản trùng lặp và luôn cập nhật theo docs.

---

Bạn tiếp quản **AgencyCLI** (`D:\AgencyCLI`) — monorepo pnpm 16 package, runtime agent tự hành cục bộ (KHÔNG phải chatbot). Hai "bệnh" cốt lõi của repo: (1) **machinery xây xong nhưng không nối dây** và (2) **trùng lặp logic/file/UI/kiến trúc**. Tuyệt đối: **không tạo trùng lặp**, **không xây thứ treo lơ lửng**, **verify chứ đừng assert**.

## 0. ĐỌC TRƯỚC (đúng thứ tự)
1. `memory/MEMORY.md` — nhật ký + git chain + trạng thái mới nhất.
2. **`docs/ROADMAP_HANDOFF.md` → §8 "HƯỚNG MỚI"** — **đây là việc của session này.** Mỗi item đã có chẩn đoán từ source thật (SỰ THẬT → LỖI → SỬA + file). **ĐỪNG điều tra lại root cause — đã nằm trong §8.**
3. `docs/SESSION_HANDOFF_PROMPT.md` — luật chống-trùng-lặp + nhịp slice + 6 guard + xử lý BYOK key an toàn (mục 1, 2, 4, 5, 6.1). Áp dụng y nguyên.
4. `docs/PACKAGES.md` → "Canonical Homes & No-Duplication Map" — tra TRƯỚC khi thêm bất kỳ helper/module nào.

## 1. Bối cảnh — crash thật cần sửa
User chạy BYOK NVIDIA NIM `minimaxai/minimax-m2.7` và gặp:
`nvidia API error: maximum context length is 196608 tokens. However, your messages resulted in 197270 tokens`
— DÙ harness in `Auto-reducing context window from 197270 to 128515`. Tức "auto-reduce" **chạy mà không hiệu lực**. Đã chẩn đoán đủ 3 gốc rễ (ROADMAP §8.1/8.2/8.3).

## 2. Việc — theo thứ tự ROADMAP §8

### 🔴 P0 — trị crush overflow (làm 3 cái CÙNG 1 đợt, cùng gốc "không tràn"):
- **§8.2 catalog provider-aware** (`packages/providers/src/model-catalog.ts`): `matchModelKey` bỏ provider → khớp nhầm entry provider khác (`302ai`=204800 thay vì `ollama-cloud`/nvidia=196608). Thread `providerId` vào `getCatalogSpec`; key thêm `"<provider>/<model>"`; lookup provider-first, không có thì **chọn context NHỎ NHẤT** (conservative).
- **§8.3 estimator err-high** (`packages/providers/src/error-parser.ts:71` `estimateMessagesTokens`): `len/4` ước THIẾU (192627 vs 197270 thật). Đổi sang ước DƯ (ratio bảo thủ + overhead role/structure + xử lý content non-string). 1 hàm canonical, đừng tạo cái thứ 2.
- **§8.1 reactive cắt THÂN hội thoại** (`chat/stream.ts` + `chat/orchestrator.ts`, hiện chỉ `turnHistory[0].content = repack(...)`): helper DÙNG CHUNG mới trong `chat/turn-helpers.ts` (vd `reduceHistoryToFit`) tái dùng `compactTurnHistory` + cắt tool-result lớn/bỏ lượt cũ tới khi `estimateMessagesTokens(turnHistory) <= newLimit*safety`; **assert vừa TRƯỚC khi retry**. Gọi từ CẢ 2 turn path (no copy-paste).
- **Test:** case minimax đa-provider → assert NVIDIA ra 196608; case history lớn → assert reactive đưa về ≤ newLimit. Nếu user cấp BYOK key → đo lại theo `SESSION_HANDOFF_PROMPT §6.1` (key chỉ ở env, không lên đĩa).

### 🟡 P1 — tính năng user yêu cầu:
- **§8.5 paste dài không gãy UI** (`tui/components/PromptComposer.tsx`/`ComposerBlock.tsx`): bracketed-paste + cap chiều cao composer + paste cực dài → attachment placeholder. Chạy TUI thật để kiểm.
- **§8.4 gửi ảnh / multimodal** (đa tầng): `ChatMessage.content: string | ContentPart[]` (additive); adapter openai-compatible map sang `image_url` CHỈ khi `capabilities.vision` (catalog đã phát hiện — tái dùng); estimator đếm token ảnh; TUI đính ảnh. Giữ provider-agnostic.

### 🟢 P2 — kiểm chất lượng + cải thiện thật:
- **§8.6 memory recall**: `LocalDeterministicEmbedder` là placeholder (feature-hashing, recall yếu) — thêm bài đo precision@k; đường nâng cấp = provider-embedder sau interface `Embedder` (giữ determinism eval).
- **§8.7 codebase index** (`index/workspace-indexer.ts`, đã wired vào `context/pack.ts:63`): kiểm incremental (đổi/đổi tên/xoá), staleness, CHẤT LƯỢNG retrieval.
- **§8.8 sandbox + tools** (`security/sandbox.ts`, 17 built-in tools): rà docker/native path + edge-case (đa số đã chắc).

## 3. Bảo trì & mở rộng (mục tiêu xuyên suốt — ROADMAP §8.9)
Mỗi tính năng mới: **tái dùng canonical home → cờ trong `flags.ts` nếu đổi hành vi (legacy byte-identical) → test → `pnpm verify` xanh → commit `master` → sync docs + memory**. Giữ 6 guard xanh (skills↔manifest, agents↔prompt/seed, flags↔status, cycles-module, cycles-package, deps↔imports). Điểm mở rộng: adapter (provider), `registry.register` (tool), manifest/seed (skill/agent), `Embedder` (embedder), `flags.ts` (behavior).

## 4. Cấm kỵ
- Không assert "green"; chạy `pnpm verify` (build+test 16 pkg, REAL_EXIT_CODE=0) trước khi commit. Bỏ qua warning cố ý (failover/rate-limit/Playwright/docker-unreachable).
- Không tạo helper/tool/estimator trùng cái đã có — tra Canonical Homes trước.
- Không tự `promote hardened→default` (cần BYOK eval delta + user OK).
- Verify-đừng-assert áp cả cho script tự viết (background output có thể bị cắt — bài học cont'd 24).

**Bắt đầu:** đọc §0 → mở ROADMAP §8 → làm P0 (8.2+8.3+8.1 cùng đợt) theo nhịp mục 3.
