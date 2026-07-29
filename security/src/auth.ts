import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface Principal {
  readonly id: string;
  readonly permissions: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
}
interface TokenPayload {
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly jti: string;
  readonly permissions: readonly string[];
  readonly roles: readonly string[];
  readonly sub: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

export interface HmacTokenServiceOptions {
  readonly audience: string;
  readonly issuer: string;
  readonly secret: Uint8Array;
  readonly ttlSeconds: number;
}

export class HmacTokenService {
  public constructor(private readonly options: HmacTokenServiceOptions) {
    if (options.secret.byteLength < 32)
      throw new RangeError("Token secret must be at least 32 bytes.");
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new RangeError("Token TTL must be a positive integer.");
    }
  }

  public issue(principal: Principal): string {
    const now = Math.floor(Date.now() / 1_000);
    const payload: TokenPayload = {
      aud: this.options.audience,
      exp: now + this.options.ttlSeconds,
      iat: now,
      iss: this.options.issuer,
      jti: randomUUID(),
      permissions: [...principal.permissions].sort(),
      roles: [...principal.roles].sort(),
      sub: principal.id
    };
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
    return `${unsigned}.${this.#sign(unsigned)}`;
  }

  public verify(token: string): Principal {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Authentication token is malformed.");
    const [headerPart = "", payloadPart = "", signature = ""] = parts;
    const expected = this.#sign(`${headerPart}.${payloadPart}`);
    const suppliedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new Error("Authentication token signature is invalid.");
    }
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    if (
      header === null ||
      typeof header !== "object" ||
      (header as Record<string, unknown>).alg !== "HS256" ||
      payload === null ||
      typeof payload !== "object"
    ) {
      throw new Error("Authentication token header or payload is invalid.");
    }
    const claims = payload as Record<string, unknown>;
    if (
      claims.iss !== this.options.issuer ||
      claims.aud !== this.options.audience ||
      typeof claims.sub !== "string" ||
      typeof claims.exp !== "number" ||
      claims.exp <= Math.floor(Date.now() / 1_000) ||
      !Array.isArray(claims.roles) ||
      !claims.roles.every((role) => typeof role === "string") ||
      !Array.isArray(claims.permissions) ||
      !claims.permissions.every((permission) => typeof permission === "string")
    ) {
      throw new Error("Authentication token claims are invalid or expired.");
    }
    return {
      id: claims.sub,
      permissions: new Set(claims.permissions),
      roles: new Set(claims.roles)
    };
  }

  #sign(input: string): string {
    return createHmac("sha256", this.options.secret).update(input).digest("base64url");
  }
}

export class AuthorizationDeniedError extends Error {
  public constructor(
    public readonly principalId: string,
    public readonly permission: string
  ) {
    super(`Principal "${principalId}" lacks permission "${permission}".`);
    this.name = "AuthorizationDeniedError";
  }
}

function matches(grant: string, permission: string): boolean {
  return (
    grant === "*" ||
    grant === permission ||
    (grant.endsWith("*") && permission.startsWith(grant.slice(0, -1)))
  );
}

export class PermissionAuthorizer {
  public constructor(private readonly rolePermissions: ReadonlyMap<string, ReadonlySet<string>>) {}

  public allows(principal: Principal, permission: string): boolean {
    const grants = [
      ...principal.permissions,
      ...[...principal.roles].flatMap((role) => [...(this.rolePermissions.get(role) ?? [])])
    ];
    return grants.some((grant) => matches(grant, permission));
  }

  public require(principal: Principal, permission: string): void {
    if (!this.allows(principal, permission)) {
      throw new AuthorizationDeniedError(principal.id, permission);
    }
  }
}
