import { describe, expect, it } from "vitest";
import {
  collapseRepetitiveWaitLines,
  isLeakedToolMarkupDelta,
  isProviderToolLeakLine,
  sanitizeAssistantTranscript,
  sanitizeStreamingPreview,
  stripToolMarkup,
} from "../chat/transcript-sanitize.js";

describe("stripToolMarkup", () => {
  it("strips function_calls wrappers and function closers", () => {
    const input =
      "Start\n<function_calls><function_call name=\"read_file\"><parameter name=\"path\">src/page.tsx</parameter></function_call></function_calls>\nEnd";
    expect(stripToolMarkup(input)).toBe("Start\n\nEnd");
  });

  it("strips orphan closers without a trailing >", () => {
    const input = "Build đã start. Đợi + đọc log:\n</function_calls\nĐợi build xong:\n</invoke\nDone";
    expect(stripToolMarkup(input)).toBe("Build đã start. Đợi + đọc log:\n\nĐợi build xong:\n\nDone");
  });

  it("strips mid-line </function> leaks", () => {
    const input = "addresses/page.tsx dùng schema i...</function>\nNext";
    expect(stripToolMarkup(input)).toBe("addresses/page.tsx dùng schema i...\nNext");
  });

  it("strips function_commands typo tags and markup-only lines", () => {
    const input =
      "Build V5 fail. Tôi restart và monitor:\n</function_commands>\n</invoke>\nPlan tiếp.";
    expect(stripToolMarkup(input)).toBe(
      "Build V5 fail. Tôi restart và monitor:\n\nPlan tiếp."
    );
  });

  it("strips GLM-style _call regions including JSON/XML bodies (minimax-m3 leak)", () => {
    const input = `Tuyệt vời! Bắt đầu Route 4.
_call name="update_plan">
[
  {"content": "Route 1", "status": "completed"},
  {"content": "Route 4", "status": "in_progress"}
]
_call name="read_file">
  <path>D:\\\\FastFood\\\\src\\\\app\\\\checkout\\\\page.tsx</path>
invoke>
Done planning.`;
    const out = stripToolMarkup(input);
    expect(out).toContain("Tuyệt vời");
    expect(out).toContain("Done planning");
    expect(out).not.toContain("_call name=");
    expect(out).not.toContain("update_plan");
    expect(out).not.toContain("Route 1");
    expect(out).not.toContain("<path>");
    expect(out).not.toContain("invoke>");
  });

  it("strips MiniMax-m3 mid-line _call and mangled path/parameter lines", () => {
    const input = `Tôi sẽ kiểm tra trạng thái workspace hiện tại và tiếp tục task đang làm._call name="git_summary">
>D:\\FastFood\\build-new.logpath>
parameter>
>D:\\FastFood\\build-new.logpath>
parameter>
Tôi thấy vấn đề - node_modules\\next\\dist\\bin\\next không tồn tại. Để tôi kiểm tra cụ thể:_call name="file_info">
>D:\\FastFood\\node_modules\\next\\dist\\binpath>
parameter>`;
    const out = stripToolMarkup(input);
    expect(out).toContain("Tôi sẽ kiểm tra");
    expect(out).toContain("Tôi thấy vấn đề");
    expect(out).not.toContain("_call");
    expect(out).not.toContain("parameter>");
  });

  it("strips orphan tool_call> and split _call blocks", () => {
    const input = `Tiếp tục hoàn thiện checkout/page.tsx.tool_call>
Still working.`;
    const out = stripToolMarkup(input);
    expect(out).toContain("Tiếp tục hoàn thiện");
    expect(out).toContain("Still working");
    expect(out).not.toContain("tool_call>");
  });

  it("strips split _call + fused tool name + todos attribute inside code fences", () => {
    const input = `\`\`\`tsx
<div className="max-h-64">
  {items.map((item) => (
    <img src={item.image} alt={item.name} fill
_call
>update_planname>
name="todos">[{"step": "Tạo CartProvider", "status": "in_progress"}]
  ))}
</div>
\`\`\``;
    const out = stripToolMarkup(input);
    expect(out).toContain("items.map");
    expect(out).toContain("<div");
    expect(out).not.toContain("_call");
    expect(out).not.toContain("update_plan");
    expect(out).not.toContain("CartProvider");
  });

  it("strips mangled edit_file line markers", () => {
    const input = `Sẽ sửa file.
_line>210start_line>
Line>260EndLine>
Đọc lại file sau edit.`;
    const out = stripToolMarkup(input);
    expect(out).toContain("Sẽ sửa file");
    expect(out).toContain("Đọc lại file");
    expect(out).not.toContain("_line>");
    expect(out).not.toContain("EndLine");
  });
});

describe("isProviderToolLeakLine", () => {
  it("flags known provider leak lines", () => {
    expect(isProviderToolLeakLine("tool_call>")).toBe(true);
    expect(isProviderToolLeakLine("_call")).toBe(true);
    expect(isProviderToolLeakLine(">update_planname>")).toBe(true);
    expect(isProviderToolLeakLine('name="todos">[{')).toBe(true);
    expect(isProviderToolLeakLine("_line>210start_line>")).toBe(true);
    expect(isProviderToolLeakLine("Tôi sẽ đọc file checkout.")).toBe(false);
  });
});

describe("collapseRepetitiveWaitLines", () => {
  it("collapses consecutive wait narration to one line", () => {
    const input = "Build V5 chạy dài.\nĐợi thêm:\nĐợi thêm:\nĐợi:\nĐợi tiếp:\nDone";
    expect(collapseRepetitiveWaitLines(input)).toBe(
      "Build V5 chạy dài.\nĐợi thêm:\nDone"
    );
  });
});

describe("isLeakedToolMarkupDelta", () => {
  it("detects pure markup deltas", () => {
    expect(isLeakedToolMarkupDelta("</function_calls")).toBe(true);
    expect(isLeakedToolMarkupDelta("tool_call>")).toBe(true);
    expect(isLeakedToolMarkupDelta("_call")).toBe(true);
    expect(isLeakedToolMarkupDelta(">update_planname>")).toBe(true);
    expect(isLeakedToolMarkupDelta("Đợi thêm:")).toBe(false);
  });
});

describe("sanitizeStreamingPreview", () => {
  it("strips tool leaks in one pass for live stream", () => {
    const raw =
      'Prose here._call name="read_file">\n>path>\nparameter>\nMore prose.';
    const preview = sanitizeStreamingPreview(raw);
    expect(preview).toContain("Prose here");
    expect(preview).toContain("More prose");
    expect(preview).not.toContain("_call");
  });
});

describe("sanitizeAssistantTranscript", () => {
  it("applies both markup strip and wait collapse", () => {
    const input =
      "Subagent timeout.</function_calls>\nĐợi thêm:\nĐợi thêm:\nĐợi:\nTiếp tục sửa file.";
    expect(sanitizeAssistantTranscript(input)).toBe(
      "Subagent timeout.\nĐợi thêm:\nTiếp tục sửa file."
    );
  });

  it("strips Vietnamese narrative pseudo-tags and shell prompt lines", () => {
    const input = `<Tốt - đã thấy:
- data.ts đầy đủ
</Đã thấy
Tóm tắt tình trạng thực tế.
>cd D:\\PizzaHoods && git status --short | head -50
Bắt đầu ngay:`;
    const out = sanitizeAssistantTranscript(input);
    expect(out).toContain("Tóm tắt tình trạng thực tế");
    expect(out).toContain("Bắt đầu ngay:");
    expect(out).not.toContain("<Tốt");
    expect(out).not.toContain("</Đã");
    expect(out).not.toContain(">cd D:");
  });

  it("strips stray </ tag residues from the beginning of lines", () => {
    const input = "</Cả src/hooks/useCart.ts và src/app/page.tsx đều chưa được tạo trên disk.";
    expect(sanitizeAssistantTranscript(input)).toBe("Cả src/hooks/useCart.ts và src/app/page.tsx đều chưa được tạo trên disk.");
    expect(sanitizeStreamingPreview(input)).toBe("Cả src/hooks/useCart.ts và src/app/page.tsx đều chưa được tạo trên disk.");
  });

  it("strips stray </ tag residues from the beginning of lines when followed by emoji/symbols", () => {
    const input = "</⚠️ PHÁT HIỆN NGHIÊM TRỌNG: data.ts có 2 bản duplicate";
    expect(sanitizeAssistantTranscript(input)).toBe("⚠️ PHÁT HIỆN NGHIÊM TRỌNG: data.ts có 2 bản duplicate");
    expect(sanitizeStreamingPreview(input)).toBe("⚠️ PHÁT HIỆN NGHIÊM TRỌNG: data.ts có 2 bản duplicate");
  });

  it("strips standalone stray closing tags or tag starts", () => {
    const input = "</\nCả src/hooks/useCart.ts";
    expect(sanitizeAssistantTranscript(input)).toBe("Cả src/hooks/useCart.ts");
    expect(sanitizeStreamingPreview(input)).toBe("Cả src/hooks/useCart.ts");
  });
});
