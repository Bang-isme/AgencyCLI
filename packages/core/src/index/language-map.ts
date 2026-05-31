/** Extension → language name mapping for index metadata */
const EXT_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",

  // Python
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",

  // Web
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",

  // Data / Config
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".csv": "csv",
  ".env": "env",
  ".ini": "ini",
  ".cfg": "ini",

  // Systems
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cs": "csharp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".m": "objc",
  ".mm": "objc",

  // Scripting
  ".rb": "ruby",
  ".php": "php",
  ".pl": "perl",
  ".pm": "perl",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".jl": "julia",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".scala": "scala",
  ".dart": "dart",
  ".zig": "zig",
  ".nim": "nim",
  ".v": "vlang",

  // Shell
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",

  // Docs
  ".md": "markdown",
  ".mdx": "markdown",
  ".rst": "restructuredtext",
  ".txt": "text",
  ".tex": "latex",

  // DevOps
  ".dockerfile": "dockerfile",
  ".tf": "terraform",
  ".hcl": "hcl",
  ".nix": "nix",

  // Database
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".prisma": "prisma",

  // Other
  ".proto": "protobuf",
  ".wasm": "wasm",
  ".sol": "solidity",
  ".move": "move",
};

/** Special filenames → language */
const NAME_MAP: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  CMakeLists: "cmake",
  Rakefile: "ruby",
  Gemfile: "ruby",
  Vagrantfile: "ruby",
  Justfile: "just",
};

/**
 * Detect language from filename/extension.
 * Returns undefined for unknown extensions.
 */
export function detectLanguage(filename: string): string | undefined {
  // Check special names first
  const base = filename.split("/").pop() ?? filename;
  const nameOnly = base.replace(/\.[^.]*$/, "");
  if (NAME_MAP[nameOnly]) return NAME_MAP[nameOnly];
  if (NAME_MAP[base]) return NAME_MAP[base];

  // Check extension
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx === -1) return undefined;
  const ext = base.slice(dotIdx).toLowerCase();
  return EXT_MAP[ext];
}

/** Check if a file is likely binary (by extension) */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".avi", ".mkv", ".mov",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".obj",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db",
  ".lock",
]);

export function isBinaryExtension(filename: string): boolean {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return BINARY_EXTS.has(filename.slice(dotIdx).toLowerCase());
}
