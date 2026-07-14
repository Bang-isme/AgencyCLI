import { Embedder, LocalDeterministicEmbedder } from "@agency/memory";
import { loadAgencyConfig, resolveApiKey } from "@agency/providers";

export class ProviderBackedEmbedder implements Embedder {
  readonly id = "provider-backed-embedder-v1";
  readonly dimension = 256;
  private fallback: LocalDeterministicEmbedder;

  constructor() {
    this.fallback = new LocalDeterministicEmbedder(256);
  }

  embed(text: string): number[] | Promise<number[]> {
    try {
      const config = loadAgencyConfig();
      const googleProfile = config.providers?.google;
      const openaiProfile = config.providers?.openai;

      const googleKey = resolveApiKey(googleProfile);
      const openaiKey = resolveApiKey(openaiProfile);

      if (googleKey || openaiKey) {
        return (async () => {
          try {
            if (googleKey) {
              const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${googleKey}`;
              const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "models/text-embedding-004",
                  content: { parts: [{ text }] },
                  outputDimensionality: 256,
                }),
              });
              if (response.ok) {
                const json = await response.json() as any;
                const values = json?.embedding?.values;
                if (Array.isArray(values) && values.length === 256) {
                  return values as number[];
                }
              }
            }

            if (openaiKey) {
              const baseUrl = openaiProfile?.baseUrl || "https://api.openai.com/v1";
              const url = `${baseUrl}/embeddings`;
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${openaiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  input: text,
                  model: "text-embedding-3-small",
                  dimensions: 256,
                }),
              });
              if (response.ok) {
                const json = await response.json() as any;
                const values = json?.data?.[0]?.embedding;
                if (Array.isArray(values) && values.length === 256) {
                  return values as number[];
                }
              }
            }
          } catch {
            // fallback
          }
          return this.fallback.embed(text);
        })();
      }
    } catch {
      // Degrade gracefully to local fallback
    }

    return this.fallback.embed(text);
  }
}
