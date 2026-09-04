export type DirectiveConnectionState =
  | "active"
  | "update_pending"
  | "restore_required"
  | "enhancement_disabled"
  | "safety_reset"
  | "closed";

export type DirectiveTurnState =
  "idle" | "user_active" | "awaiting_response" | "assistant_active";

export type DirectiveUpdateKind = "apply" | "restore";
export type DirectiveUpdateFailure =
  "known_not_applied" | "outcome_unknown" | "connection_lost";

export type DirectiveMuteAction =
  | "none"
  | "restore_required"
  | "cancel_response_then_restore"
  | "await_restore_ack"
  | "safety_reset";

export type DirectiveStateSnapshot = {
  connection: DirectiveConnectionState;
  turn: DirectiveTurnState;
  sessionMuted: boolean;
  activeRevision: number | null;
  pendingRevision: number | null;
  pendingKind: DirectiveUpdateKind | null;
  expiredOnDisconnect: boolean;
};

type PendingUpdate = {
  kind: DirectiveUpdateKind;
  revision: number;
  instructionHash: string;
  previousRevision: number | null;
};

export class TeachingDirectiveStateMachine {
  private connection: DirectiveConnectionState = "active";
  private turn: DirectiveTurnState = "idle";
  private sessionMuted = false;
  private activeRevision: number | null = null;
  private lastRequestedRevision = 0;
  private pending: PendingUpdate | null = null;
  private expiredOnDisconnect = false;

  snapshot(): DirectiveStateSnapshot {
    return {
      connection: this.connection,
      turn: this.turn,
      sessionMuted: this.sessionMuted,
      activeRevision: this.activeRevision,
      pendingRevision: this.pending?.revision ?? null,
      pendingKind: this.pending?.kind ?? null,
      expiredOnDisconnect: this.expiredOnDisconnect,
    };
  }

  canStartUserTurn(): boolean {
    return (
      (this.connection === "active" ||
        this.connection === "enhancement_disabled") &&
      this.pending === null &&
      this.turn === "idle"
    );
  }

  beginApply(input: { revision: number; instructionHash: string }): void {
    if (this.sessionMuted) throw stateError("SESSION_MUTED");
    this.beginUpdate("apply", input);
  }

  beginRestore(input: { revision: number; instructionHash: string }): void {
    if (this.activeRevision === null) throw stateError("NO_ACTIVE_DIRECTIVE");
    this.beginUpdate("restore", input);
  }

  acknowledgeUpdate(input: {
    revision: number;
    instructionHash: string;
  }): void {
    const pending = this.pending;
    if (!pending || this.connection !== "update_pending") {
      throw stateError("NO_UPDATE_PENDING");
    }
    if (
      input.revision !== pending.revision ||
      input.instructionHash !== pending.instructionHash
    ) {
      throw stateError("ACK_MISMATCH");
    }

    this.pending = null;
    this.connection = "active";
    this.activeRevision = pending.kind === "apply" ? pending.revision : null;
  }

  failUpdate(failure: DirectiveUpdateFailure): void {
    const pending = this.pending;
    if (!pending || this.connection !== "update_pending") {
      throw stateError("NO_UPDATE_PENDING");
    }

    this.pending = null;
    const applicationIsKnownAbsent =
      failure === "known_not_applied" &&
      pending.kind === "apply" &&
      pending.previousRevision === null;
    if (applicationIsKnownAbsent) {
      this.connection = "enhancement_disabled";
      this.activeRevision = null;
      return;
    }

    this.connection = "safety_reset";
  }

  markUserSpeechStarted(): void {
    if (!this.canStartUserTurn()) throw stateError("TURN_NOT_READY");
    this.turn = "user_active";
  }

  markUserTurnCompleted(): void {
    if (this.turn !== "user_active") throw stateError("USER_NOT_ACTIVE");
    this.turn = "awaiting_response";
  }

  markResponseStarted(): void {
    this.requireUsableConnection();
    if (this.pending) throw stateError("UPDATE_NOT_ACKNOWLEDGED");
    if (this.turn !== "awaiting_response" && this.turn !== "idle") {
      throw stateError("RESPONSE_NOT_EXPECTED");
    }
    this.turn = "assistant_active";
  }

  markResponseDone(): void {
    if (this.turn !== "assistant_active" && this.turn !== "awaiting_response") {
      throw stateError("RESPONSE_NOT_ACTIVE");
    }
    this.turn = "idle";
    if (this.activeRevision !== null) this.connection = "restore_required";
  }

  muteSession(): DirectiveMuteAction {
    this.sessionMuted = true;
    if (this.connection === "safety_reset") return "safety_reset";
    if (this.connection === "closed") return "none";
    if (this.pending?.kind === "restore") return "await_restore_ack";
    if (this.pending?.kind === "apply") {
      this.pending = null;
      this.connection = "safety_reset";
      return "safety_reset";
    }
    if (this.activeRevision === null) return "none";
    if (this.turn === "user_active") {
      this.connection = "safety_reset";
      return "safety_reset";
    }

    this.connection = "restore_required";
    if (this.turn === "assistant_active" || this.turn === "awaiting_response") {
      return "cancel_response_then_restore";
    }
    return "restore_required";
  }

  disconnect(): void {
    this.expiredOnDisconnect =
      this.activeRevision !== null || this.pending?.kind === "apply";
    this.pending = null;
    this.activeRevision = null;
    this.connection = "closed";
    this.turn = "idle";
  }

  private beginUpdate(
    kind: DirectiveUpdateKind,
    input: { revision: number; instructionHash: string },
  ): void {
    const connectionAllowsUpdate =
      this.connection === "active" ||
      (kind === "restore" && this.connection === "restore_required");
    if (!connectionAllowsUpdate) {
      throw stateError(
        this.connection === "update_pending"
          ? "UPDATE_IN_PROGRESS"
          : "CONNECTION_NOT_ACTIVE",
      );
    }
    if (this.turn !== "idle") throw stateError("TURN_NOT_IDLE");
    if (this.pending) throw stateError("UPDATE_IN_PROGRESS");
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision <= this.lastRequestedRevision
    ) {
      throw stateError("STALE_REVISION");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.instructionHash)) {
      throw stateError("INVALID_INSTRUCTION_HASH");
    }

    this.pending = {
      kind,
      revision: input.revision,
      instructionHash: input.instructionHash,
      previousRevision: this.activeRevision,
    };
    this.lastRequestedRevision = input.revision;
    this.connection = "update_pending";
  }

  private requireUsableConnection(): void {
    if (
      this.connection !== "active" &&
      this.connection !== "enhancement_disabled"
    ) {
      throw stateError("CONNECTION_NOT_ACTIVE");
    }
  }
}

export type DirectiveStateErrorCode =
  | "SESSION_MUTED"
  | "NO_ACTIVE_DIRECTIVE"
  | "NO_UPDATE_PENDING"
  | "ACK_MISMATCH"
  | "UPDATE_IN_PROGRESS"
  | "CONNECTION_NOT_ACTIVE"
  | "TURN_NOT_IDLE"
  | "TURN_NOT_READY"
  | "USER_NOT_ACTIVE"
  | "UPDATE_NOT_ACKNOWLEDGED"
  | "RESPONSE_NOT_EXPECTED"
  | "RESPONSE_NOT_ACTIVE"
  | "STALE_REVISION"
  | "INVALID_INSTRUCTION_HASH";

export class TeachingDirectiveStateError extends Error {
  constructor(public readonly code: DirectiveStateErrorCode) {
    super(code);
    this.name = "TeachingDirectiveStateError";
  }
}

function stateError(
  code: DirectiveStateErrorCode,
): TeachingDirectiveStateError {
  return new TeachingDirectiveStateError(code);
}
