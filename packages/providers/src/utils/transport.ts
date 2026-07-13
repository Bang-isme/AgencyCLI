import type { Transport, TransportRequest, TransportResponse } from "../types.js";

export class FetchTransport implements Transport {
  constructor(private fetchImpl: typeof fetch = globalThis.fetch) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    const res = await this.fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
    });

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: res.body,
      json: () => res.json(),
      text: () => res.text(),
    };
  }
}
