import type {
  Character,
  CharacterRuntimeResponse,
  CharacterSummary,
  ConversationContinuityStatus,
  ConversationMode,
  CreateCharacterRequest,
  RealtimeModelProfile,
  UserAccount,
  VoiceProfile,
} from "@meet/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { registerSW } from "virtual:pwa-register";

import type { AuthenticatedAppSession } from "./auth/AuthGate.js";
import {
  CharacterApiError,
  copyCharacter,
  createCharacter,
  deleteCharacter,
  getCharacter,
  getCharacterCatalog,
  getCharacterRuntime,
  listCharacters,
  listFavoriteCharacterIds,
  setCharacterFavorite,
  restoreCharacter,
  updateCharacter,
  updateCharacterVisibility,
} from "./characters/character-api.js";
import CharacterDetail from "./characters/CharacterDetail.js";
import CharacterEditor from "./characters/CharacterEditor.js";
import CharacterLibrary from "./characters/CharacterLibrary.js";
import {
  canCreateCharacter,
  presentCharacterError,
} from "./characters/character-logic.js";
import {
  RelationshipTransferApiError,
  downloadRelationshipTransfer,
  exportCharacterRelationship,
  importCharacterRelationship,
  parseRelationshipTransferFile,
} from "./characters/relationship-transfer-api.js";
import HistoryPage from "./history/HistoryPage.js";
import MemoryPage from "./memory/MemoryPage.js";
import CharacterCall from "./realtime/CharacterCall.js";
import { useConversationOverview } from "./history/use-conversation-overview.js";
import {
  finishSavedConversation,
  getPendingEndOperation,
  getStatus,
} from "./history/continuity-api.js";
import { ConversationApiError } from "./history/conversation-api.js";
import type { MemoryLocation } from "./history/ConversationReview.js";
import "./continuity.css";

type ProductSection = "characters" | "history" | "memory" | "profile";

type DetailState =
  | { status: "idle" }
  | { status: "loading"; characterId: string }
  | { status: "error"; characterId: string; message: string }
  | { status: "ready"; character: Character };

type EditorState =
  | { status: "closed" }
  | { status: "catalog"; character: Character | null }
  | {
      status: "ready";
      character: Character | null;
      realtimeModels: RealtimeModelProfile[];
      voices: VoiceProfile[];
      realtimeDefaultModelProfileId: string | null;
    };

type Notice = { kind: "success" | "error"; message: string };

export default function App(session: AuthenticatedAppSession) {
  const { user } = session;
  const [section, setSection] = useState<ProductSection>("characters");
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [charactersError, setCharactersError] = useState("");
  const [listReload, setListReload] = useState(0);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const [editor, setEditor] = useState<EditorState>({ status: "closed" });
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [runtime, setRuntime] = useState<CharacterRuntimeResponse | null>(null);
  const callActiveRef = useRef(false);
  callActiveRef.current = runtime !== null;
  const invalidateOutsideCall = useCallback(() => {
    if (!callActiveRef.current) session.invalidateSession();
  }, [session.invalidateSession]);
  const [callOptions, setCallOptions] = useState<{
    initialMode: ConversationMode;
    resumeConversationId?: string;
  }>({ initialMode: "normal" });
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  const [overviewReload, setOverviewReload] = useState(0);
  const [historyConversationId, setHistoryConversationId] = useState<
    string | undefined
  >();
  const [memoryLocation, setMemoryLocation] = useState<
    MemoryLocation | undefined
  >();
  const [callOverlay, setCallOverlay] = useState<
    | { type: "history"; id: string }
    | { type: "memory"; location: MemoryLocation }
    | null
  >(null);
  const {
    overview,
    loading: overviewLoading,
    error: overviewError,
  } = useConversationOverview({
    userId: user.id,
    reload: overviewReload,
    enabled: !runtime && section === "characters" && detail.status === "idle",
    onUnauthorized: session.invalidateSession,
  });
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateServiceWorker, setUpdateServiceWorker] = useState<
    ((reloadPage?: boolean) => Promise<void>) | null
  >(null);

  useEffect(() => {
    if (runtime) return;
    const controller = new AbortController();
    void listFavoriteCharacterIds(controller.signal)
      .then(setFavoriteIds)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, invalidateOutsideCall)) return;
        setNotice({
          kind: "error",
          message: "收藏暂时没有同步，请稍后刷新角色列表。",
        });
      });
    return () => controller.abort();
  }, [listReload, invalidateOutsideCall, runtime]);

  useEffect(() => {
    if (runtime) return;
    const controller = new AbortController();
    setCharactersLoading(true);
    setCharactersError("");
    void listCharacters(controller.signal)
      .then((result) => {
        setCharacters(result);
        setCharactersLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, invalidateOutsideCall)) return;
        setCharactersError(presentCharacterError(error, "list"));
        setCharactersLoading(false);
      });
    return () => controller.abort();
  }, [listReload, invalidateOutsideCall, runtime]);

  useEffect(() => {
    if (runtime || detail.status !== "loading") return;
    const controller = new AbortController();
    const characterId = detail.characterId;
    void getCharacter(characterId, controller.signal)
      .then((character) => setDetail({ status: "ready", character }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, invalidateOutsideCall)) return;
        setDetail({
          status: "error",
          characterId,
          message: presentCharacterError(error, "detail"),
        });
      });
    return () => controller.abort();
  }, [detail, invalidateOutsideCall, runtime]);

  useEffect(() => {
    if (runtime || editor.status !== "catalog") return;
    const controller = new AbortController();
    const character = editor.character;
    setEditorError("");
    void getCharacterCatalog(controller.signal)
      .then((catalog) => {
        const realtimeModels =
          character &&
          !catalog.realtimeModels.some(
            (model) => model.id === character.realtimeModelProfile.id,
          )
            ? [character.realtimeModelProfile, ...catalog.realtimeModels]
            : catalog.realtimeModels;
        const voices =
          character &&
          !catalog.voices.some(
            (voice) => voice.id === character.voiceProfile.id,
          )
            ? [character.voiceProfile, ...catalog.voices]
            : catalog.voices;
        setEditor({
          status: "ready",
          character,
          realtimeModels,
          voices,
          realtimeDefaultModelProfileId: catalog.realtimeDefaultModelProfileId,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, invalidateOutsideCall)) return;
        setEditorError(presentCharacterError(error, "detail"));
        setEditor({ status: "closed" });
      });
    return () => controller.abort();
  }, [editor, invalidateOutsideCall, runtime]);

  useEffect(() => {
    const updater = registerSW({
      immediate: true,
      onNeedRefresh: () => setUpdateAvailable(true),
      onOfflineReady: () => setOfflineReady(true),
    });
    setUpdateServiceWorker(() => updater);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [section, detail.status, editor.status, runtime?.character.id]);

  const openCharacter = (characterId: string) => {
    setNotice(null);
    setDetail({ status: "loading", characterId });
  };

  const beginCreate = () => {
    if (!canCreateCharacter(user)) return;
    setEditorError("");
    setEditor({ status: "catalog", character: null });
  };

  const beginEdit = (character: Character) => {
    if (!character.permissions.canEdit || user.accountType === "child") return;
    setEditorError("");
    setEditor({ status: "catalog", character });
  };

  const beginCall = async (
    characterId: string,
    initialMode: ConversationMode = "normal",
  ) => {
    if (busyAction) return;
    setBusyAction(characterId);
    setNotice(null);
    try {
      const value = await getCharacterRuntime(characterId);
      setCallOptions({ initialMode });
      setRuntime(value);
    } catch (error) {
      if (handleUnauthorized(error, invalidateOutsideCall)) return;
      const message = presentCharacterError(error, "runtime");
      setNotice({ kind: "error", message });
    } finally {
      setBusyAction(null);
    }
  };

  const resumeCall = async (status: ConversationContinuityStatus) => {
    if (
      busyAction ||
      !status.isOwner ||
      !status.canResume ||
      status.endRequestId
    )
      return;
    setBusyAction(status.conversation.id);
    setNotice(null);
    try {
      const character = await getCharacter(status.conversation.character.id);
      setCallOptions({
        initialMode: status.conversation.mode,
        resumeConversationId: status.conversation.id,
      });
      // The server's prepare result replaces these display defaults before any connection.
      setRuntime({
        character,
        realtime: {
          provider: character.realtimeModelProfile.provider,
          realtimeModelProfileId: character.realtimeModelProfile.id,
          model: status.conversation.model,
          voice: status.conversation.voice,
          instructions: "恢复原通话",
          firstSpeaker: "user",
          openingLine: null,
        },
      });
    } catch (cause) {
      if (handleUnauthorized(cause, invalidateOutsideCall)) return;
      setNotice({
        kind: "error",
        message: "这次通话暂时无法恢复。你仍可以查看记录或结束已保存的内容。",
      });
      setOverviewReload((current) => current + 1);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleFavorite = async (characterId: string) => {
    if (favoriteBusyId) return;
    setFavoriteBusyId(characterId);
    try {
      const favorite = await setCharacterFavorite(
        characterId,
        !favoriteIds.includes(characterId),
      );
      setFavoriteIds((current) =>
        favorite
          ? [...new Set([...current, characterId])]
          : current.filter((id) => id !== characterId),
      );
    } catch (cause) {
      if (handleUnauthorized(cause, invalidateOutsideCall)) return;
      setNotice({ kind: "error", message: "收藏没有保存成功，请重试。" });
    } finally {
      setFavoriteBusyId(null);
    }
  };

  const finishInterruptedCall = async (
    status: ConversationContinuityStatus,
  ): Promise<void> => {
    if (busyAction || !status.isOwner || !status.canFinish) return;
    setBusyAction(status.conversation.id);
    setNotice(null);
    try {
      const marker = getPendingEndOperation(status.conversation.id, user.id);
      const missing = Math.max(
        0,
        (marker?.lastSequence ??
          status.endTargetSequence ??
          status.conversation.lastSequence) - status.conversation.lastSequence,
      );
      if (
        missing &&
        !window.confirm(
          `原页面还有 ${missing} 条文字未同步，当前设备无法恢复这些文字。只保留服务器已收到的内容并结束吗？`,
        )
      )
        return;
      await finishSavedConversation(status, user.id, {
        discardMissing: missing > 0,
      });
      setNotice({
        kind: "success",
        message: "通话已结束，服务器收到的文字记录已保存。",
      });
    } catch (cause) {
      if (cause instanceof ConversationApiError && cause.status === 401) {
        session.invalidateSession();
        return;
      }
      const marker = getPendingEndOperation(status.conversation.id, user.id);
      try {
        const checked = await getStatus(
          status.conversation.id,
          marker?.requestId,
        );
        if (checked.connectionState === "completed") {
          setNotice({
            kind: "success",
            message: "已经确认通话结束，文字记录已保存。",
          });
          return;
        }
      } catch {
        /* Keep the original request marker for the next status check. */
      }
      setNotice({
        kind: "error",
        message: "暂时无法确认结束状态，请刷新后重试；已有文字记录不会删除。",
      });
    } finally {
      setBusyAction(null);
      setOverviewReload((current) => current + 1);
    }
  };

  const viewHistory = (conversationId: string) => {
    if (runtime) {
      setCallOverlay({ type: "history", id: conversationId });
      return;
    }
    setHistoryConversationId(conversationId);
    setSection("history");
    setNotice(null);
  };
  const viewMemories = (location: MemoryLocation) => {
    if (runtime) {
      setCallOverlay({ type: "memory", location });
      return;
    }
    setMemoryLocation(location);
    setSection("memory");
    setNotice(null);
  };

  const saveCharacter = async (request: CreateCharacterRequest) => {
    if (editor.status !== "ready" || user.accountType === "child") return;
    setSaving(true);
    setEditorError("");
    try {
      const saved = editor.character
        ? await updateCharacter(editor.character.id, {
            revision: editor.character.revision,
            ...request,
          })
        : await createCharacter(request);
      blurActiveControl();
      setEditor({ status: "closed" });
      setDetail({ status: "ready", character: saved });
      setNotice({
        kind: "success",
        message: editor.character
          ? "角色卡已经更新。"
          : `${saved.name} 已加入你的角色。`,
      });
      setListReload((current) => current + 1);
    } catch (error) {
      if (handleUnauthorized(error, invalidateOutsideCall)) return;
      setEditorError(presentCharacterError(error, "save"));
    } finally {
      setSaving(false);
    }
  };

  const performDetailAction = async (
    action: "copy" | "share" | "restore" | "delete",
  ) => {
    if (detail.status !== "ready" || user.accountType === "child") return;
    if (busyAction) return;
    const character = detail.character;
    const allowed = {
      copy: character.permissions.canCopy,
      share: character.permissions.canShare,
      restore: character.permissions.canRestore,
      delete: character.permissions.canDelete,
    }[action];
    if (!allowed) return;

    if (
      action === "restore" &&
      !window.confirm(
        "恢复后会使用当前应用内置的人设与声音，但不会删除任何历史或记忆。继续吗？",
      )
    )
      return;
    if (
      action === "delete" &&
      !window.confirm(
        `确定删除“${character.name}”吗？角色的历史数据不会在这个步骤中处理。`,
      )
    )
      return;
    if (
      action === "share" &&
      character.visibility === "private" &&
      !window.confirm(
        "共享后，全家成员都能看到这个角色，并使用同一套人设与声音。继续吗？",
      )
    )
      return;

    setBusyAction(action);
    setNotice(null);
    try {
      let changed: Character | null = null;
      if (action === "copy") changed = await copyCharacter(character.id);
      if (action === "restore") changed = await restoreCharacter(character.id);
      if (action === "share") {
        changed = await updateCharacterVisibility(character.id, {
          revision: character.revision,
          visibility: character.visibility === "private" ? "family" : "private",
        });
      }
      if (action === "delete") {
        await deleteCharacter(character.id, character.revision);
        setDetail({ status: "idle" });
        setNotice(null);
      } else if (changed) {
        setDetail({ status: "ready", character: changed });
        setNotice({
          kind: "success",
          message:
            action === "copy"
              ? `已创建“${changed.name}”。`
              : action === "restore"
                ? "预置角色已恢复到当前版本。"
                : changed.visibility === "family"
                  ? "角色已共享给全家。"
                  : "角色已改为仅自己可见。",
        });
      }
      setListReload((current) => current + 1);
    } catch (error) {
      if (handleUnauthorized(error, invalidateOutsideCall)) return;
      setNotice({
        kind: "error",
        message: presentCharacterError(error, action),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const exportRelationship = async (character: Character) => {
    if (busyAction) return;
    setBusyAction("export");
    setNotice(null);
    try {
      const exported = await exportCharacterRelationship(character.id);
      downloadRelationshipTransfer(exported.transferPackage, exported.fileName);
      setNotice({
        kind: "success",
        message: `已导出 ${exported.transferPackage.payload.conversations.length} 次通话和 ${exported.transferPackage.payload.memories.length} 条长期记忆。`,
      });
    } catch (error) {
      if (handleUnauthorized(error, invalidateOutsideCall)) return;
      setNotice({
        kind: "error",
        message:
          error instanceof RelationshipTransferApiError
            ? error.message
            : "导出失败，请稍后重试。",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const importRelationship = async (character: Character, file: File) => {
    if (busyAction) return;
    setBusyAction("import");
    setNotice(null);
    try {
      const transferPackage = await parseRelationshipTransferFile(file);
      const sourceCharacter = transferPackage.payload.character;
      const sameCharacter = characterIdentityMatches(
        sourceCharacter,
        character,
      );
      if (
        !sameCharacter &&
        !window.confirm(
          `这份文件来自“${sourceCharacter.name}”，当前选择的是“${character.name}”。导入后，这些历史和记忆会用于当前角色。仍要继续吗？`,
        )
      ) {
        return;
      }
      if (
        !window.confirm(
          `将文件中的 ${transferPackage.payload.conversations.length} 次通话和 ${transferPackage.payload.memories.length} 条记忆合并到当前账号与“${character.name}”的关系中。已有数据不会被覆盖，重复内容会跳过。继续吗？`,
        )
      ) {
        return;
      }
      const result = await importCharacterRelationship(
        character.id,
        transferPackage,
        !sameCharacter,
      );
      setNotice({
        kind: "success",
        message: result.wasAlreadyImported
          ? "这份迁移文件之前已经导入，未重复写入数据。"
          : `迁移完成：新增 ${result.importedConversations} 次通话和 ${result.importedMemories} 条记忆，跳过 ${result.skippedConversations + result.skippedMemories} 条重复数据。`,
      });
    } catch (error) {
      if (handleUnauthorized(error, invalidateOutsideCall)) return;
      setNotice({
        kind: "error",
        message:
          error instanceof RelationshipTransferApiError
            ? error.message
            : "导入失败，当前账号的数据没有改变。",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const navigate = (next: ProductSection) => {
    setSection(next);
    setDetail({ status: "idle" });
    setEditor({ status: "closed" });
    setNotice(null);
    setEditorError("");
    if (next === "history") setHistoryConversationId(undefined);
    if (next === "memory") setMemoryLocation(undefined);
    if (next === "characters") setOverviewReload((current) => current + 1);
  };

  if (runtime) {
    return (
      <>
        <div
          inert={callOverlay ? true : undefined}
          aria-hidden={callOverlay ? true : undefined}
        >
          <CharacterCall
            runtime={runtime}
            user={user}
            initialMode={callOptions.initialMode}
            resumeConversationId={callOptions.resumeConversationId}
            onViewHistory={viewHistory}
            onViewMemories={viewMemories}
            onExit={() => {
              setRuntime(null);
              setCallOverlay(null);
              setSection("characters");
              setDetail({ status: "idle" });
              setOverviewReload((current) => current + 1);
            }}
            onUnauthorized={session.invalidateSession}
          />
        </div>
        {callOverlay && (
          <ContinuityOverlay onClose={() => setCallOverlay(null)}>
            {callOverlay.type === "history" ? (
              <HistoryPage
                currentUserId={user.id}
                initialConversationId={callOverlay.id}
                readOnly
                onCall={() => undefined}
                onResume={() => undefined}
                onFinish={() => Promise.resolve()}
                onUnauthorized={() => setCallOverlay(null)}
              />
            ) : (
              <MemoryPage
                key={`${callOverlay.location.characterId}:${callOverlay.location.sourceConversationId}:${callOverlay.location.status}`}
                initialCharacterId={callOverlay.location.characterId}
                sourceConversationId={callOverlay.location.sourceConversationId}
                initialStatus={callOverlay.location.status}
                onViewHistory={viewHistory}
                onUnauthorized={() => setCallOverlay(null)}
              />
            )}
          </ContinuityOverlay>
        )}
        <PwaNotice
          inCall
          updateAvailable={updateAvailable}
          offlineReady={offlineReady}
          onDismissUpdate={() => setUpdateAvailable(false)}
          onDismissOffline={() => setOfflineReady(false)}
          onUpdate={() => undefined}
        />
      </>
    );
  }

  return (
    <div className="product-shell">
      <ProductSidebar section={section} user={user} onNavigate={navigate} />
      <div className="product-main">
        <ProductTopbar user={user} />
        <div className="product-content">
          {section === "characters" && (
            <>
              {editor.status === "catalog" && (
                <PageLoading label="正在打开角色编辑器" />
              )}
              {editor.status === "ready" && (
                <CharacterEditor
                  key={editor.character?.id ?? "new-character"}
                  user={user}
                  character={editor.character}
                  providers={editor.realtimeModels}
                  voices={editor.voices}
                  realtimeDefaultModelProfileId={
                    editor.realtimeDefaultModelProfileId
                  }
                  saving={saving}
                  serverError={editorError}
                  onCancel={() => {
                    blurActiveControl();
                    setEditorError("");
                    setEditor({ status: "closed" });
                  }}
                  onSave={(request) => void saveCharacter(request)}
                />
              )}
              {editor.status === "closed" && detail.status === "idle" && (
                <>
                  {notice && (
                    <div
                      className={`product-notice global ${notice.kind}`}
                      role={notice.kind === "error" ? "alert" : "status"}
                    >
                      {notice.message}
                    </div>
                  )}
                  {editorError && (
                    <div className="product-notice global error" role="alert">
                      {editorError}
                    </div>
                  )}
                  <CharacterLibrary
                    user={user}
                    characters={characters}
                    loading={charactersLoading}
                    error={charactersError}
                    busyCharacterId={busyAction}
                    onRetry={() => setListReload((current) => current + 1)}
                    onOpen={openCharacter}
                    onCall={(id) => void beginCall(id)}
                    onCreate={beginCreate}
                    pending={overview.pending}
                    recent={overview.recent}
                    overviewLoading={overviewLoading}
                    overviewError={overviewError}
                    favoriteIds={favoriteIds}
                    favoriteBusyId={favoriteBusyId}
                    onToggleFavorite={(id) => void toggleFavorite(id)}
                    onResume={(status) => void resumeCall(status)}
                    onFinish={(status) => void finishInterruptedCall(status)}
                    onViewHistory={viewHistory}
                    onRefreshOverview={() =>
                      setOverviewReload((current) => current + 1)
                    }
                  />
                </>
              )}
              {editor.status === "closed" && detail.status === "loading" && (
                <PageLoading label="正在读取角色卡" />
              )}
              {editor.status === "closed" && detail.status === "error" && (
                <PageError
                  message={detail.message}
                  onBack={() => setDetail({ status: "idle" })}
                  onRetry={() =>
                    setDetail({
                      status: "loading",
                      characterId: detail.characterId,
                    })
                  }
                />
              )}
              {editor.status === "closed" && detail.status === "ready" && (
                <CharacterDetail
                  user={user}
                  character={detail.character}
                  busyAction={
                    busyAction === detail.character.id ? "call" : busyAction
                  }
                  notice={notice}
                  onBack={() => {
                    setDetail({ status: "idle" });
                    setNotice(null);
                  }}
                  onCall={() => void beginCall(detail.character.id)}
                  onEdit={() => beginEdit(detail.character)}
                  onCopy={() => void performDetailAction("copy")}
                  onToggleVisibility={() => void performDetailAction("share")}
                  onRestore={() => void performDetailAction("restore")}
                  onDelete={() => void performDetailAction("delete")}
                  onExportRelationship={() =>
                    void exportRelationship(detail.character)
                  }
                  onImportRelationship={(file) =>
                    void importRelationship(detail.character, file)
                  }
                  favorite={favoriteIds.includes(detail.character.id)}
                  favoritePending={favoriteBusyId === detail.character.id}
                  onToggleFavorite={() =>
                    void toggleFavorite(detail.character.id)
                  }
                  onViewHistory={viewHistory}
                  onViewMemories={viewMemories}
                  onUnauthorized={session.invalidateSession}
                />
              )}
            </>
          )}
          {section === "history" && (
            <>
              {notice && (
                <div
                  className={`product-notice ${notice.kind}`}
                  role={notice.kind === "error" ? "alert" : "status"}
                >
                  {notice.message}
                </div>
              )}
              <HistoryPage
                key={historyConversationId ?? "history-list"}
                currentUserId={user.id}
                initialConversationId={historyConversationId}
                onCall={(characterId, mode) =>
                  void beginCall(characterId, mode)
                }
                onResume={(status) => void resumeCall(status)}
                onFinish={finishInterruptedCall}
                onViewMemories={viewMemories}
                onUnauthorized={session.invalidateSession}
              />
            </>
          )}
          {section === "memory" && (
            <MemoryPage
              key={`${memoryLocation?.characterId}:${memoryLocation?.sourceConversationId}:${memoryLocation?.status}`}
              initialCharacterId={memoryLocation?.characterId}
              sourceConversationId={memoryLocation?.sourceConversationId}
              initialStatus={memoryLocation?.status}
              onViewHistory={viewHistory}
              onUnauthorized={session.invalidateSession}
            />
          )}
          {section === "profile" && <ProfilePage session={session} />}
        </div>
      </div>
      <ProductBottomNav section={section} onNavigate={navigate} />
      <PwaNotice
        inCall={false}
        updateAvailable={updateAvailable}
        offlineReady={offlineReady}
        onDismissUpdate={() => setUpdateAvailable(false)}
        onDismissOffline={() => setOfflineReady(false)}
        onUpdate={() => void updateServiceWorker?.(true)}
      />
    </div>
  );
}

function ContinuityOverlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="continuity-overlay"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="continuity-overlay-bar">
        <span>查看已保存内容</span>
        <button type="button" onClick={onClose}>
          返回通话收尾
        </button>
      </div>
      {children}
    </dialog>
  );
}

function ProductSidebar({
  section,
  user,
  onNavigate,
}: {
  section: ProductSection;
  user: UserAccount;
  onNavigate: (section: ProductSection) => void;
}) {
  return (
    <aside className="product-sidebar">
      <div className="product-brand">
        <span className="brand-mark">M</span>
        <span>
          <strong>Meet</strong>
          <small>家庭角色空间</small>
        </span>
      </div>
      <ProductNav section={section} onNavigate={onNavigate} />
      <button
        className="sidebar-profile"
        type="button"
        onClick={() => onNavigate("profile")}
      >
        <span className="profile-initial">{getInitial(user.displayName)}</span>
        <span>
          <strong>{user.displayName}</strong>
          <small>{accountTypeLabels[user.accountType]}</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
    </aside>
  );
}

function ProductTopbar({ user }: { user: UserAccount }) {
  return (
    <header className="product-topbar">
      <div className="mobile-brand">
        <span className="brand-mark">M</span>
        <strong>Meet</strong>
      </div>
      <div>
        <span>你好，</span>
        <strong>{user.displayName}</strong>
      </div>
    </header>
  );
}

function ProductNav({
  section,
  onNavigate,
}: {
  section: ProductSection;
  onNavigate: (section: ProductSection) => void;
}) {
  const items: { id: ProductSection; label: string; icon: string }[] = [
    { id: "characters", label: "角色", icon: "◇" },
    { id: "history", label: "历史", icon: "◷" },
    { id: "memory", label: "记忆", icon: "◎" },
    { id: "profile", label: "我的", icon: "○" },
  ];
  return (
    <nav className="product-nav" aria-label="主要导航">
      {items.map((item) => (
        <button
          key={item.id}
          className={section === item.id ? "active" : ""}
          type="button"
          aria-current={section === item.id ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function ProductBottomNav({
  section,
  onNavigate,
}: {
  section: ProductSection;
  onNavigate: (section: ProductSection) => void;
}) {
  return (
    <div className="product-bottom-nav">
      <ProductNav section={section} onNavigate={onNavigate} />
    </div>
  );
}

function ProfilePage({ session }: { session: AuthenticatedAppSession }) {
  const user = session.user;
  return (
    <div className="profile-page page-frame">
      <header>
        <p className="product-eyebrow">MY SPACE</p>
        <h1>我的</h1>
        <p>管理当前账号与家庭空间入口。</p>
      </header>
      <section className="profile-card">
        <span className="profile-large-initial">
          {getInitial(user.displayName)}
        </span>
        <div>
          <strong>{user.displayName}</strong>
          <p>@{user.username}</p>
          <span>{accountTypeLabels[user.accountType]}</span>
        </div>
      </section>
      {session.logoutError && (
        <div className="product-notice error" role="alert">
          {session.logoutError}
        </div>
      )}
      <section className="profile-actions">
        <button type="button" onClick={session.openPasswordChange}>
          <span>
            <strong>修改密码</strong>
            <small>验证当前密码后设置新密码</small>
          </span>
          <span aria-hidden="true">→</span>
        </button>
        {user.accountType === "admin" && (
          <button type="button" onClick={session.openFamilyMembers}>
            <span>
              <strong>家庭成员</strong>
              <small>创建账号、重置密码与儿童资料权限</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        )}
        {user.accountType !== "child" && (
          <button type="button" onClick={session.openTeachingPlans}>
            <span>
              <strong>学习小支线</strong>
              <small>设置角色里自然、可跳过的小挑战</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        )}
        {user.accountType === "admin" && (
          <button type="button" onClick={session.openModelSettings}>
            <span>
              <strong>模型设置</strong>
              <small>供应商连接、实时语音、文本模型与默认用途</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        )}
        <button
          type="button"
          disabled={session.logoutPending}
          onClick={session.logout}
        >
          <span>
            <strong>{session.logoutPending ? "正在退出…" : "退出登录"}</strong>
            <small>切换家庭成员需要先退出当前账号</small>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      </section>
      <p className="profile-privacy-note">
        对话、记忆和录音默认按账号隔离；管理员也不能读取成人账号的私人内容。
      </p>
    </div>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="page-frame product-state page-loading" role="status">
      <span className="product-spinner" aria-hidden="true" />
      <strong>{label}</strong>
    </div>
  );
}

function PageError({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="page-frame product-state page-loading error" role="alert">
      <span className="state-symbol" aria-hidden="true">
        !
      </span>
      <strong>没有打开角色卡</strong>
      <p>{message}</p>
      <div>
        <button type="button" onClick={onBack}>
          返回角色
        </button>
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    </div>
  );
}

function PwaNotice({
  inCall,
  updateAvailable,
  offlineReady,
  onDismissUpdate,
  onDismissOffline,
  onUpdate,
}: {
  inCall: boolean;
  updateAvailable: boolean;
  offlineReady: boolean;
  onDismissUpdate: () => void;
  onDismissOffline: () => void;
  onUpdate: () => void;
}) {
  if (!updateAvailable && !offlineReady) return null;
  return (
    <div className="pwa-toast" role="status">
      <p>
        {updateAvailable
          ? inCall
            ? "Meet 有新版本。请先结束当前通话，再返回刷新。"
            : "Meet 有新版本，可以刷新后使用。"
          : "应用外壳已缓存；实时聊天仍需要联网。"}
      </p>
      {updateAvailable && !inCall && (
        <button type="button" onClick={onUpdate}>
          刷新
        </button>
      )}
      <button
        className="toast-dismiss"
        type="button"
        onClick={updateAvailable ? onDismissUpdate : onDismissOffline}
      >
        稍后
      </button>
    </div>
  );
}

function handleUnauthorized(error: unknown, invalidate: () => void): boolean {
  if (
    (error instanceof CharacterApiError ||
      error instanceof RelationshipTransferApiError) &&
    error.status === 401
  ) {
    invalidate();
    return true;
  }
  return false;
}

function characterIdentityMatches(
  source: { name: string; systemKey: string | null },
  target: Pick<Character, "name" | "systemKey">,
): boolean {
  if (source.systemKey || target.systemKey) {
    return Boolean(
      source.systemKey &&
      target.systemKey &&
      source.systemKey === target.systemKey,
    );
  }
  return (
    source.name.trim().toLocaleLowerCase("zh-CN") ===
    target.name.trim().toLocaleLowerCase("zh-CN")
  );
}

function blurActiveControl(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function getInitial(displayName: string): string {
  return Array.from(displayName.trim())[0] ?? "M";
}

const accountTypeLabels: Record<UserAccount["accountType"], string> = {
  admin: "家庭管理员",
  adult: "成人账号",
  child: "儿童账号",
};
