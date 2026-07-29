import type { JsonObject } from "@a1/core";

export type MemoryScope = "agent" | "global" | "project" | "semantic";
export interface ConversationMessage {
  readonly content: string;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: JsonObject;
  readonly role: "assistant" | "system" | "tool" | "user";
}
export interface MemoryRecord {
  readonly content: string;
  readonly createdAt: string;
  readonly embedding?: readonly number[];
  readonly id: string;
  readonly key: string;
  readonly metadata: JsonObject;
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly updatedAt: string;
}
export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}
export interface GraphEntity {
  readonly id: string;
  readonly kind: string;
  readonly metadata: JsonObject;
  readonly name: string;
  readonly updatedAt: string;
}
export interface GraphEdge {
  readonly fromId: string;
  readonly metadata: JsonObject;
  readonly relation: string;
  readonly toId: string;
  readonly updatedAt: string;
}
export interface RememberInput {
  readonly content: string;
  readonly embedding?: readonly number[];
  readonly key: string;
  readonly metadata?: JsonObject;
  readonly scope: MemoryScope;
  readonly scopeId: string;
}
export interface SearchMemoryInput {
  readonly embedding?: readonly number[];
  readonly limit: number;
  readonly query?: string;
  readonly scopes?: readonly { readonly scope: MemoryScope; readonly scopeId: string }[];
}
export interface MemoryEngine {
  addMessage(
    conversationId: string,
    role: ConversationMessage["role"],
    content: string,
    metadata?: JsonObject
  ): Promise<ConversationMessage>;
  close(): Promise<void>;
  connect(edge: Omit<GraphEdge, "updatedAt">): Promise<GraphEdge>;
  conversation(conversationId: string, limit?: number): Promise<readonly ConversationMessage[]>;
  neighbors(entityId: string, relation?: string): Promise<readonly GraphEdge[]>;
  open(): Promise<void>;
  remember(input: RememberInput): Promise<MemoryRecord>;
  search(input: SearchMemoryInput): Promise<readonly MemorySearchResult[]>;
  upsertEntity(entity: Omit<GraphEntity, "updatedAt">): Promise<GraphEntity>;
}
