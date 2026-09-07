/** Only non-content operation metadata is persisted. Private text stays in memory. */
export type PendingEndOperation = {
  conversationId: string;
  requestId: string;
  lastSequence: number;
};

type OperationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = "meet.pending-end.v1:";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function storage(): OperationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
function key(userId: string, conversationId: string): string {
  return `${prefix}${encodeURIComponent(userId)}:${conversationId}`;
}
function parse(raw: string | null): PendingEndOperation | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.conversationId !== "string" ||
      !uuid.test(item.conversationId) ||
      typeof item.requestId !== "string" ||
      !uuid.test(item.requestId) ||
      typeof item.lastSequence !== "number" ||
      !Number.isSafeInteger(item.lastSequence) ||
      item.lastSequence < 0
    )
      return null;
    return {
      conversationId: item.conversationId,
      requestId: item.requestId,
      lastSequence: item.lastSequence,
    };
  } catch {
    return null;
  }
}
export function savePendingEndOperation(
  userId: string,
  operation: PendingEndOperation,
  target = storage(),
): boolean {
  if (!target) return false;
  const safe = parse(JSON.stringify(operation));
  if (!safe) return false;
  try {
    target.setItem(key(userId, safe.conversationId), JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}
export function getPendingEndOperation(
  conversationId: string,
  userId: string,
  target = storage(),
): PendingEndOperation | null {
  try {
    return target ? parse(target.getItem(key(userId, conversationId))) : null;
  } catch {
    return null;
  }
}
export function clearPendingEndOperation(
  conversationId: string,
  userId: string,
  target = storage(),
): void {
  try {
    target?.removeItem(key(userId, conversationId));
  } catch {
    /* Best effort when storage is unavailable. */
  }
}
export function listPendingEndOperations(
  userId: string,
  target = storage(),
): PendingEndOperation[] {
  if (!target) return [];
  const scope = `${prefix}${encodeURIComponent(userId)}:`;
  try {
    const operations: PendingEndOperation[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const candidate = target.key(index);
      if (!candidate?.startsWith(scope)) continue;
      const operation = parse(target.getItem(candidate));
      if (operation) operations.push(operation);
    }
    return operations;
  } catch {
    return [];
  }
}

let pageClientId: string | undefined;
/** A page owns one identity. Other tabs must never inherit its write lease. */
export function getConversationClientId(): string {
  return (pageClientId ??= crypto.randomUUID());
}
