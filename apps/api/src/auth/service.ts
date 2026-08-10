import type { UserAccount } from "@meet/protocol";
import { randomUUID } from "node:crypto";

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password.js";
import type { AuthRepository, AuthUserRecord } from "./repository.js";
import { createSessionToken, hashSessionToken } from "./session-token.js";

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_CURRENT_PASSWORD"
  | "AUTHENTICATION_REQUIRED"
  | "AUTH_UNAVAILABLE";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

export type LoginResult = {
  user: UserAccount;
  sessionToken: string;
  expiresAt: Date;
};

type PasswordHasher = (password: string) => Promise<string>;

export class AuthService {
  constructor(
    private readonly repository: AuthRepository | null,
    private readonly sessionTtlMs: number,
    private readonly passwordHasher: PasswordHasher = hashPassword,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const credential = await this.callRepository((repository) =>
      repository.findCredentialByUsername(username.trim()),
    );
    const passwordMatches = await verifyPassword(
      password,
      credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!credential || !passwordMatches) throw invalidCredentialsError();
    if (credential.user.status !== "active") {
      throw invalidCredentialsError();
    }

    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.sessionTtlMs);
    const sessionToken = createSessionToken();
    const sessionCreated = await this.callRepository((repository) =>
      repository.createLoginSessionIfCredentialCurrent(
        {
          id: randomUUID(),
          userId: credential.user.id,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt,
          createdAt,
        },
        credential.passwordHash,
      ),
    );
    if (!sessionCreated) throw invalidCredentialsError();

    return {
      user: toPublicUser(credential.user),
      sessionToken,
      expiresAt,
    };
  }

  async authenticate(sessionToken: string | undefined): Promise<UserAccount> {
    if (!sessionToken) {
      throw authenticationRequiredError("请先登录。");
    }

    const user = await this.callRepository((repository) =>
      repository.findUserBySessionTokenHash(
        hashSessionToken(sessionToken),
        this.now(),
      ),
    );
    if (!user || user.status !== "active") {
      throw authenticationRequiredError("登录状态已失效。");
    }

    return toPublicUser(user);
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken) {
      return;
    }
    await this.callRepository((repository) =>
      repository.revokeLoginSession(hashSessionToken(sessionToken), this.now()),
    );
  }

  async changePassword(
    sessionToken: string | undefined,
    currentPassword: string,
    newPassword: string,
  ): Promise<number> {
    if (!sessionToken) throw authenticationRequiredError("请先登录。");

    const authenticatedAt = this.now();
    const currentSessionTokenHash = hashSessionToken(sessionToken);
    const credential = await this.callRepository((repository) =>
      repository.findCredentialBySessionTokenHash(
        currentSessionTokenHash,
        authenticatedAt,
      ),
    );
    if (!credential || credential.user.status !== "active") {
      throw authenticationRequiredError("登录状态已失效。");
    }

    const passwordMatches = await verifyPassword(
      currentPassword,
      credential.passwordHash,
    );
    if (!passwordMatches) throw invalidCurrentPasswordError();

    const newPasswordHash = await this.passwordHasher(newPassword);
    const changedAt = this.now();
    const result = await this.callRepository((repository) =>
      repository.changeOwnPassword({
        userId: credential.user.id,
        currentSessionTokenHash,
        expectedPasswordHash: credential.passwordHash,
        newPasswordHash,
        changedAt,
      }),
    );
    if (result.kind === "invalid_session") {
      throw authenticationRequiredError("登录状态已失效。");
    }
    if (result.kind === "credential_changed") {
      throw invalidCurrentPasswordError();
    }
    return result.revokedSessionCount;
  }

  private async callRepository<T>(
    operation: (repository: AuthRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.requireRepository();
    try {
      return await operation(repository);
    } catch (error) {
      throw new AuthError(
        "AUTH_UNAVAILABLE",
        "账号服务暂时不可用，请稍后重试。",
        503,
        { cause: error },
      );
    }
  }

  private requireRepository(): AuthRepository {
    if (!this.repository) {
      throw new AuthError("AUTH_UNAVAILABLE", "账号服务尚未配置数据库。", 503);
    }
    return this.repository;
  }
}

function invalidCredentialsError(): AuthError {
  return new AuthError("INVALID_CREDENTIALS", "用户名或密码不正确。", 401);
}

function invalidCurrentPasswordError(): AuthError {
  return new AuthError("INVALID_CURRENT_PASSWORD", "当前密码不正确。", 400);
}

function authenticationRequiredError(message: string): AuthError {
  return new AuthError("AUTHENTICATION_REQUIRED", message, 401);
}

function toPublicUser(user: AuthUserRecord): UserAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    accountType: user.accountType,
    status: user.status,
    guardianHistoryAccess: user.guardianHistoryAccess,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
