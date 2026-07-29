import { ModelProviderError } from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface HttpAdapterOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly timeoutMs: number;
}

export function adapterHeaders(
  options: HttpAdapterOptions,
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return { "content-type": "application/json", ...options.defaultHeaders, ...extra };
}

export async function providerFetch(
  options: HttpAdapterOptions,
  path: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref();
  try {
    const response = await fetch(new URL(path, `${options.baseUrl.replace(/\/+$/, "")}/`), {
      ...init,
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000);
      throw new ModelProviderError(
        `${options.id} returned HTTP ${String(response.status)}: ${body}`,
        options.id,
        response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500
      );
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof ModelProviderError) throw error;
    throw new ModelProviderError(`${options.id} request failed.`, options.id, true, {
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new TypeError("Model provider returned a non-object JSON response.");
  }
  return value;
}

export async function* sseEvents(response: Response): AsyncIterable<Record<string, unknown>> {
  if (response.body === null) throw new TypeError("Streaming model response has no body.");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (done) continue;
    const chunk: unknown = result.value;
    if (!(chunk instanceof Uint8Array)) throw new TypeError("SSE response contained invalid data.");
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        const value = JSON.parse(data) as unknown;
        if (isRecord(value)) yield value;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
