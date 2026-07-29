export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function assertJsonValueInternal(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${path} is not a JSON value.`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference.`);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValueInternal(item, `${path}[${String(index)}]`, nextAncestors);
    });
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} contains a non-plain object.`);
  }

  for (const [key, item] of Object.entries(value)) {
    assertJsonValueInternal(item, `${path}.${key}`, nextAncestors);
  }
}

export function assertJsonValue(value: unknown, name = "value"): asserts value is JsonValue {
  assertJsonValueInternal(value, name, new Set());
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  assertJsonValue(value);
  return structuredClone(value);
}

export function freezeJsonValue<T extends JsonValue>(value: T): T {
  if (isJsonArray(value)) {
    value.forEach((item) => {
      freezeJsonValue(item);
    });
    Object.freeze(value);
    return value;
  }

  if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => {
      freezeJsonValue(item);
    });
    Object.freeze(value);
    return value;
  }

  return value;
}

function canonicalize(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }

  return value;
}

export function canonicalJsonStringify(value: JsonValue): string {
  assertJsonValue(value);
  return JSON.stringify(canonicalize(value));
}
