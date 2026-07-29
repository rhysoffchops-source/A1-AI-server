import { randomBytes, randomUUID } from "node:crypto";

import { HmacTokenService, type Principal } from "./auth.js";

export interface Approval {
  readonly action: string;
  readonly approvedBy: string;
  readonly id: string;
  readonly target: string;
  readonly token: string;
}

export class ApprovalGate {
  readonly #consumed = new Set<string>();
  readonly #tokens: HmacTokenService;
  public constructor(secret: Uint8Array, ttlSeconds = 300) {
    this.#tokens = new HmacTokenService({
      audience: "a1-approval",
      issuer: "a1",
      secret,
      ttlSeconds
    });
  }

  public issue(approver: Principal, action: string, target: string): Approval {
    if (action.trim() === "" || target.trim() === "")
      throw new TypeError("Approval action and target are required.");
    const id = randomUUID();
    const token = this.#tokens.issue({
      id: approver.id,
      permissions: new Set([`approval:${id}:${action}:${target}`]),
      roles: new Set()
    });
    return { action, approvedBy: approver.id, id, target, token };
  }

  public consume(approval: Approval, action: string, target: string): void {
    if (this.#consumed.has(approval.id)) throw new Error("Approval token was already consumed.");
    const principal = this.#tokens.verify(approval.token);
    if (
      action !== approval.action ||
      target !== approval.target ||
      principal.id !== approval.approvedBy ||
      !principal.permissions.has(`approval:${approval.id}:${action}:${target}`)
    ) {
      throw new Error("Approval token does not match this action.");
    }
    this.#consumed.add(approval.id);
  }

  public static generateSecret(): Uint8Array {
    return randomBytes(32);
  }
}
