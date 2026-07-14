# Workflow Discipline and Loop Engineering Guidelines

These rules are established to guide the coding agent (Antigravity) through a disciplined, token-efficient, and professional software engineering lifecycle in the `AgencyCLI` workspace.

The pack is designed for 3 outcomes:
1. **Less generic output** (specific, production-ready, highly tailored solutions).
2. **Stronger workflow discipline** (following a strict structural lifecycle).
3. **Deliverables that read more like accountable human engineering work**.

---

## 1. Loop Engineering & Token Budget Optimization

To prevent file truncation (Max Output Token exhaustion) and avoid wasteful turn churning (token budget drain):
* **Targeted Code Replacements**: Do NOT use `write_to_file` to rewrite entire large files. Always prefer `replace_file_content` or `multi_replace_file_content` to make focused, surgical edits to only the lines changing.
* **Proactive Syntax and Build Checks**: Before running tools, mentally trace the syntax of imports, types, and variables to ensure no compilation/linting errors are introduced.
* **Stop on Recurrent Failures**: If a fix fails compilation or unit tests 2 times, stop immediately. Do not keep repeating the same edit. Pause, re-evaluate, perform a self-reflection loop, or request guidance.
* **Background Task Verification (Xác thực Task chạy ngầm)**: Khi chạy các lệnh kiểm tra, build hoặc compile qua `run_command` mà lệnh bị đẩy xuống chạy ngầm (background task), Model **tuyệt đối không được đoán kết quả hoặc tiếp tục bước tiếp theo**. Model bắt buộc phải chờ thông báo hoàn thành từ hệ thống (hoặc dùng `manage_task` kiểm tra trạng thái) để nhận được đầy đủ `exitCode`, `stdout`, và `stderr` trước khi đưa ra bất kỳ kết luận nào.
* **Handling File Truncation (Xử lý file bị cắt cụt do hết token)**: Khi viết các tệp mã nguồn lớn (CSS, React components), Model phải kiểm tra xem file có bị cắt cụt giữa chừng do chạm ngưỡng Max Output Tokens hay không. Nếu bị cắt cụt, Model phải thực hiện thêm lượt gọi tool bổ sung để hoàn thành nốt phần code còn thiếu trước khi tiến hành build và báo cáo kết quả.

---

## 2. The Strict Task Lifecycle

Every task must progress through these explicit phases:

```
Intent ➔ Spec ➔ Plan ➔ Route ➔ Implement ➔ Verify ➔ Persist ➔ Commit
```

### 1. Intent (Hiểu rõ ý định)
* Clarify requirements and verify the user's intent. Ask clarifying questions if requirements are underspecified or ambiguous.

### 2. Spec (Xác định Đặc tả)
* Check relevant package boundaries, model specifications (context windows, rate limits), and dependencies.

### 3. Plan (Lập Kế hoạch)
* Create or update the `implementation_plan.md` artifact when appropriate. 
* Break the task down into a checklist in `task.md`.

### 5. Route (Định tuyến File)
* List precisely which files, classes, components, or test files will be modified. Avoid touching files outside the scope of the task.

### 6. Implement (Thực thi)
* Apply targeted modifications. Keep code changes clean, commented, and typed. Maintain original comments and document patterns.

### 7. Verify (Xác minh)
* Run automated builds (`pnpm build`) and unit tests (`pnpm test` or specific filter commands) to verify correctness.

### 8. Persist (Lưu trữ và Ổn định)
* Ensure all files are successfully written, lint errors are resolved, and the local workspace state is completely stable.

### 9. Commit (Bảo mật luồng Git / CI-CD)
* Implement a **smart and safe git workflow** that protects teammate branches and ensures CI/CD verification:
  * Never commit directly to a shared base branch without ensuring all workspace tests are green.
  * Write clear, detailed, and professional git commit messages following the Conventional Commits style (e.g., `feat(providers): ...`, `fix(rate-limiter): ...`).
  * Ensure the local branch tree remains secure and branch trees are not broken.

---

## 3. Visual Verification & Integration Guardrail Protocol (Quy trình xác minh trực quan & Tích hợp)

Để loại bỏ hoàn toàn việc Model AI tự đoán (guessing) và báo cáo hoàn thành nhiệm vụ khi giao diện còn lỗi, thiếu file CSS, hoặc CSS chưa được import:

### 1. Quy tắc kiểm tra kết nối tài nguyên (Asset & CSS Import Validation)
* **Kiểm tra import**: Khi tạo hoặc sửa đổi bất kỳ file CSS, SCSS, component, hoặc asset nào, Model bắt buộc phải kiểm tra xem file đó đã được import trực tiếp hay gián tiếp vào file chạy chính (ví dụ: `App.tsx`, `index.css`, `main.tsx`, hoặc `index.html`) chưa. Không được để tình trạng file tồn tại nhưng chưa liên kết.
* **Kiểm tra biên dịch CSS**: Đảm bảo cấu trúc class và các utility classes (như Tailwind) được khai báo đúng và nằm trong cấu hình compile.

### 2. Quy trình kiểm thử trực quan bắt buộc (Mandatory Visual Inspection)
Nếu nhiệm vụ có liên quan đến việc thay đổi giao diện (UI, CSS, HTML, Components, Animations):
* **Không đoán kết quả**: Tuyệt đối không được báo cáo hoàn thành dựa trên việc chạy lệnh build thành công. Build thành công không có nghĩa là giao diện hiển thị đúng.
* **Quy trình Browser Verification**:
  1. Chạy server phát triển cục bộ (`npm run dev` hoặc `pnpm dev`).
  2. Sử dụng công cụ Browser để mở trang web tương ứng.
  3. Thực hiện chụp ảnh màn hình giao diện (Screenshot).
  4. **BẮT BUỘC** gọi tool `view_file` để xem và phân tích ảnh chụp màn hình trực quan nhằm phát hiện lỗi lệch layout, thiếu CSS, hay chồng chéo chữ.
  5. Đưa ra minh chứng cụ thể trong tin nhắn hội thoại (đường dẫn screenshot đã xem và phân tích).
* **Quy trình TUI Verification**: Đối với các thay đổi trên TUI, phải chạy thử hoặc kiểm tra các test suite render của Ink/React để đảm bảo các component vẽ đúng dòng.

