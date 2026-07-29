import { assertJsonValue, type JsonObject, type JsonValue } from "@a1/core";

interface JsonRpcResponse {
  readonly error?: { readonly code: number; readonly message: string };
  readonly id: number;
  readonly result?: JsonValue;
}

export function parseResponse(value: unknown): JsonRpcResponse {
  assertJsonValue(value, "MCP response");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP response must be an object.");
  }
  const record = value as JsonObject;
  if (typeof record.id !== "number") throw new TypeError("MCP response has no numeric ID.");
  let error: JsonRpcResponse["error"];
  if (record.error !== undefined) {
    if (record.error === null || typeof record.error !== "object" || Array.isArray(record.error)) {
      throw new TypeError("MCP error is invalid.");
    }
    const detail = record.error as JsonObject;
    if (typeof detail.code !== "number" || typeof detail.message !== "string") {
      throw new TypeError("MCP error detail is invalid.");
    }
    error = { code: detail.code, message: detail.message };
  }
  return {
    ...(error === undefined ? {} : { error }),
    id: record.id,
    ...(record.result === undefined ? {} : { result: record.result })
  };
}

export function request(id: number, method: string, params: JsonObject = {}): string {
  return `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
}

export function resultObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP result must be an object.");
  }
  return value as JsonObject;
}
