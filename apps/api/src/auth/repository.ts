import type {
  AccountStatus,
  AccountType,
  GuardianHistoryAccess,
} from "@meet/protocol";

export type AuthUserRecord = {
  id: string;
  username: string;
  displayName: string;
  accountType: AccountType;
  status: AccountStatus;
  guardianHistoryAccess: GuardianHistoryAccess | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialRecord = {
  user: AuthUserRecord;
  passwordHash: string;
};

export type LoginSessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
};

export type ChangeOwnPasswordResult =
  | { kind: "changed"; revokedSessionCount: number }
  | { kind: "invalid_session" }
  | { kind: "credential_changed" };

export type InitialAdminInput = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  now: Date;
};

export interface AuthRepository {
  findCredentialByUsername(username: string): Promise<CredentialRecord | null>;
  findCredentialBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<CredentialRecord | null>;
  createLoginSessionIfCredentialCurrent(
    session: LoginSessionRecord,
    expectedPasswordHash: string,
  ): Promise<boolean>;
  findUserBySessionTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthUserRecord | null>;
  revokeLoginSession(tokenHash: string, revokedAt: Date): Promise<void>;
  changeOwnPassword(input: {
    userId: string;
    currentSessionTokenHash: string;
    expectedPasswordHash: string;
    newPasswordHash: string;
    changedAt: Date;
  }): Promise<ChangeOwnPasswordResult>;
}

export interface AdminAccountRepository extends AuthRepository {
  createInitialAdmin(input: InitialAdminInput): Promise<AuthUserRecord>;
  resetAdminPassword(
    username: string,
    passwordHash: string,
    changedAt: Date,
  ): Promise<AuthUserRecord | null>;
}
