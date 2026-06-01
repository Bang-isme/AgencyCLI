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

> Không suy diễn từ trí nhớ — số liệu/cấu trúc có thể đã đổi. Luôn `grep`/đọc file THẬT rồi mới kết luận. (Bài học: đừng tin nhãn cũ — `OutputEngine` từng bị gán "dead" nhưng thực ra LIVE.)

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
- Nhà chung đã thiết lập: logic dùng chung 2 turn path → `chat/turn-helpers.ts`; output headless → `OutputEngine` (qua `cli/src/utils.ts` `out`/`handleError`); tool-loop breaker → `chat/circuit-breaker.ts`; DAG/plan → `task/runner.ts` `runPlan`; routing → `agents/agent-registry.ts`; journal+replay → `events/`; precise AST edit → `utils/ast-compiler.ts` (qua tool `ast_edit`); "tool nào ghi file" → `isFileWritingTool`; trace record/replay → telemetry tracker + benchmark `runRegressionReplay`.

## 2. WIRED-OR-DEAD đã ĐÓNG 100% — đừng tái tạo nợ
Mọi machinery export từ `core/index.ts` đều WIRED hoặc DELETED. Code mới phải **được nối dây + dùng ngay**, không "xây rồi treo". Tool mới auto-quảng bá cho model qua `registry.listTools()`→`buildSystemPrompt` (đăng ký = model thấy). Nếu thấy gì giống dead-code → grep 0 live importer rồi mới xử lý (wire-or-delete), ghi vào docs.

## 3. VERIFY = sự thật, đừng assert
- Gate DUY NHẤT: `pnpm verify` (= `pnpm -r build && pnpm -r test`). Baseline: build 16/16 sạch, **~2002 test, exit 0** (core 348 / cli 550 / tui 115 / providers 840 / memory 34 / …).
- **Chạy `pnpm verify` TRƯỚC khi nói "green" hay commit.** Repo có lịch sử "xanh ảo" — KHÔNG được assert.
- Test fail nghi flaky/timeout dưới tải đồng thời → **xác minh** bằng chạy riêng package đó; nếu flaky thật → **sửa gốc** (nới timeout), KHÔNG retry-cho-tới-khi-xanh.
- Thêm dep workspace mới → `pnpm install` trước khi build.

## 4. Quy ước flag & kiến trúc
- Thay đổi hành vi → giấu sau flag trong `runtime/flags.ts` (`AGENCY_PROFILE=legacy|hardened`; **legacy giữ hành vi cũ byte-identical**; risky = off-legacy/on-hardened; tốn-kém = opt-in off cả hai như `verifyTests`/`traceRecord`). Hiện 25 flag.
- Tính năng thuần additive (command/tool mới, không đổi path cũ) → KHÔNG cần flag.
- Tránh import cycle: package phụ thuộc KHÔNG import flags từ core (dùng tham số/setter). Thêm cross-package dep → verify package đích là leaf/không tạo vòng.
- Docs lịch sử `PRODUCTION_AUDIT*` = point-in-time → KHÔNG sửa. Chỉ cập nhật living docs (HARDENING_HANDOFF / ROADMAP / PACKAGES / CORE_ENGINE / CLI_REFERENCE / TESTING).

## 5. Nhịp mỗi slice (lặp lại)
investigate (đọc + grep) → phân loại (trùng thật vs distinct; wire vs delete) → thay đổi **tối thiểu, behavior-preserving, tái dùng canonical home** → thêm/cập nhật test → `pnpm verify` XANH → sync living docs (+ thêm row vào "Canonical Homes" nếu có nhà mới) → commit trên `master` (cây phải sạch) → cập nhật `memory/` + git chain trong MEMORY.md.

- Commit nhỏ từng slice; KHÔNG amend; KHÔNG `--no-verify`. Message kết bằng:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## 6. Trạng thái hiện tại & việc tiếp theo (xác nhận lại bằng docs/memory)
- Đã xong: P0+P1, audit gaps (B–F), §2.3 compaction, §2.4 tool layer (`ast_edit` + parallel đã an toàn), §2.5 **record producer** (telemetry tracker wired → `.agency/traces/`, cờ `AGENCY_TRACE_RECORD`). Git HEAD ≈ `f38400e` trên `master`.
- **NEXT không cần key:** (a) lệnh **replay-regression CLI** chạy `benchmark.runRegressionReplay` trên trace đã ghi (consumer đã có, chỉ thiếu driver) ← khuyến nghị; (b) re-execute agent thật (cần ghi thêm LLM response — trace hiện chỉ có tool I/O + timings).
- **Cần BYOK key (việc user):** đo legacy↔hardened `agency eval --suite hard` → rồi promote `hardened`→default.

## 7. Cấm kỵ
- Không xóa/sửa khi chưa grep xác nhận 0 live importer.
- Không gộp các cặp "trùng tên cố ý" (mục 1).
- Không assert "green"; không commit khi `pnpm verify` chưa xanh.
- Không tạo file/tool/command trùng chức năng đã có — luôn tra "Canonical Homes" trước.

**Bắt đầu:** đọc mục 0 → chạy quét trùng (mục 1) → nêu rõ slice bạn chọn + lý do "không trùng + nối dây thật" → thực thi theo nhịp mục 5.
