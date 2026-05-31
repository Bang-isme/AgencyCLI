import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";

export interface IndexPayload {
  filePath: string;
  content: string;
  gitRevision?: string;
  embeddingModel?: string;
  dbPath?: string;
}

/**
 * Worker Thread Execution entry point.
 * This runs when spawned as a thread to offload intensive text parsing and keying.
 */
if (parentPort) {
  parentPort.on("message", async (payload: IndexPayload) => {
    try {
      const parsedSymbols = await parseSymbols(
        payload.content,
        payload.filePath,
        payload.dbPath,
        payload.embeddingModel
      );
      
      // Send parsed symbols back to main process for batch insertion
      parentPort!.postMessage({
        success: true,
        filePath: payload.filePath,
        gitRevision: payload.gitRevision,
        symbols: parsedSymbols,
      });
    } catch (err: any) {
      parentPort!.postMessage({
        success: false,
        filePath: payload.filePath,
        error: err.message,
      });
    }
  });
}

let dbInstance: any = null;
let currentDbPath: string | null = null;

function getDbConnection(dbPath: string) {
  if (dbInstance && currentDbPath === dbPath) {
    return dbInstance;
  }
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
  }
  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  dbInstance.pragma("busy_timeout = 5000");
  dbInstance.pragma("temp_store = memory");
  dbInstance.pragma("mmap_size = 268435456");
  currentDbPath = dbPath;
  return dbInstance;
}

function getCachedEmbedding(dbPath: string, text: string, model: string): number[] | null {
  try {
    const db = getDbConnection(dbPath);
    const stmt = db.prepare("SELECT vector FROM embedding_cache WHERE text = ? AND embedding_model = ?");
    const row = stmt.get(text, model) as { vector: string } | undefined;
    if (row) {
      return JSON.parse(row.vector);
    }
  } catch (err) {
    // Fail silently
  }
  return null;
}

function cacheEmbedding(dbPath: string, text: string, model: string, vector: number[]): void {
  try {
    const db = getDbConnection(dbPath);
    const stmt = db.prepare("INSERT OR REPLACE INTO embedding_cache (text, embedding_model, vector, created_at) VALUES (?, ?, ?, ?)");
    stmt.run(text, model, JSON.stringify(vector), Date.now());
  } catch (err) {
    // Fail silently
  }
}

let ollamaChecked = false;
let ollamaRunning = false;

async function isOllamaAvailable(): Promise<boolean> {
  if (ollamaChecked) {
    return ollamaRunning;
  }
  ollamaChecked = true;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 100);
    const res = await fetch("http://localhost:11434/api/tags", { signal: controller.signal });
    clearTimeout(id);
    ollamaRunning = res.ok;
  } catch {
    ollamaRunning = false;
  }
  return ollamaRunning;
}

async function generateEmbedding(text: string, dbPath?: string, modelOverride?: string): Promise<number[]> {
  const endpoint = process.env.EMBEDDING_ENDPOINT;
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = modelOverride || process.env.EMBEDDING_MODEL;
  const provider = process.env.EMBEDDING_PROVIDER;

  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Resolve provider
  let resolvedProvider = provider;
  if (!resolvedProvider) {
    if (endpoint) {
      if (endpoint.includes("generativelanguage.googleapis.com")) {
        resolvedProvider = "google";
      } else if (endpoint.includes("11434") || endpoint.includes("ollama")) {
        resolvedProvider = "ollama";
      } else {
        resolvedProvider = "openai";
      }
    } else {
      if (geminiKey) {
        resolvedProvider = "google";
      } else if (openaiKey) {
        resolvedProvider = "openai";
      } else if (await isOllamaAvailable()) {
        resolvedProvider = "ollama";
      }
    }
  }

  // Resolve model name depending on provider
  let resolvedModel = model;
  if (!resolvedModel) {
    if (resolvedProvider === "google") {
      resolvedModel = "text-embedding-004";
    } else if (resolvedProvider === "openai") {
      resolvedModel = "text-embedding-3-small";
    } else if (resolvedProvider === "ollama") {
      resolvedModel = "nomic-embed-text";
    } else {
      resolvedModel = "mock-model";
    }
  }

  // Check cache first if dbPath is provided and provider is not mock-model
  if (dbPath && resolvedProvider !== "mock-model") {
    const cached = getCachedEmbedding(dbPath, text, resolvedModel);
    if (cached) {
      return cached;
    }
  }

  let embeddingResult: number[] | null = null;

  try {
    if (resolvedProvider === "google") {
      const key = apiKey || geminiKey;
      if (!key) {
        return generateMockVector(text);
      }
      let resolvedUrl = endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:embedContent?key=${key}`;
      if (endpoint && key && !endpoint.includes("key=")) {
        const sep = endpoint.includes("?") ? "&" : "?";
        resolvedUrl = `${endpoint}${sep}key=${key}`;
      }
      const response = await fetch(resolvedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: `models/${resolvedModel}`,
          content: {
            parts: [{ text }],
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Gemini embedContent failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json() as any;
      if (data?.embedding?.values) {
        embeddingResult = data.embedding.values;
      } else {
        throw new Error("Invalid Gemini embedding response structure");
      }
    } else if (resolvedProvider === "openai") {
      const key = apiKey || openaiKey;
      const resolvedUrl = endpoint || "https://api.openai.com/v1/embeddings";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (key) {
        headers["Authorization"] = `Bearer ${key}`;
      }
      const response = await fetch(resolvedUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: text,
          model: resolvedModel,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json() as any;
      if (data?.data?.[0]?.embedding) {
        embeddingResult = data.data[0].embedding;
      } else {
        throw new Error("Invalid OpenAI embedding response structure");
      }
    } else if (resolvedProvider === "ollama") {
      let resolvedUrl = endpoint || "http://localhost:11434/api/embeddings";
      if (resolvedUrl.endsWith("11434") || resolvedUrl.endsWith("11434/")) {
        resolvedUrl = resolvedUrl.replace(/\/?$/, "/api/embeddings");
      }
      const response = await fetch(resolvedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: text,
          model: resolvedModel,
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama embeddings failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json() as any;
      if (data?.embedding) {
        embeddingResult = data.embedding;
      } else if (data?.data?.[0]?.embedding) {
        embeddingResult = data.data[0].embedding;
      } else {
        throw new Error("Invalid Ollama embedding response structure");
      }
    }
  } catch (err) {
    console.error(`Error fetching ${resolvedProvider} embedding:`, err);
  }

  if (embeddingResult) {
    if (dbPath && resolvedProvider !== "mock-model") {
      cacheEmbedding(dbPath, text, resolvedModel, embeddingResult);
    }
    return embeddingResult;
  }

  return generateMockVector(text);
}

async function parseSymbols(
  content: string,
  _filePath: string,
  dbPath?: string,
  embeddingModel?: string
): Promise<{ name: string; type: string; line: number; vector: number[] }[]> {
  const lines = content.split("\n");
  const symbols: { name: string; type: string; line: number; vector: number[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Naive regex matching for function/class symbols (JS/TS/Python)
    if (trimmed.startsWith("function ") || trimmed.startsWith("export function ") || trimmed.startsWith("async function ")) {
      const match = trimmed.match(/function\s+(\w+)/);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          type: "function",
          line: i + 1,
          vector: await generateEmbedding(match[1], dbPath, embeddingModel),
        });
      }
    } else if (trimmed.startsWith("class ") || trimmed.startsWith("export class ")) {
      const match = trimmed.match(/class\s+(\w+)/);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          type: "class",
          line: i + 1,
          vector: await generateEmbedding(match[1], dbPath, embeddingModel),
        });
      }
    } else if (trimmed.startsWith("def ")) {
      const match = trimmed.match(/def\s+(\w+)/);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          type: "function",
          line: i + 1,
          vector: await generateEmbedding(match[1], dbPath, embeddingModel),
        });
      }
    }
  }

  return symbols;
}

/**
 * Generate highly deterministic mock vector embedding based on string contents
 */
function generateMockVector(text: string): number[] {
  const hash = Array.from(text).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const vector: number[] = [];
  const dim = 1536; // standard OpenAI dimension size for default consistency
  for (let i = 0; i < dim; i++) {
    vector.push(Math.sin(hash + i) * 0.1);
  }
  return vector;
}
