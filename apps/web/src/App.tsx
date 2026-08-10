import type {
  Character,
  CharacterRuntimeResponse,
  CharacterSummary,
  CreateCharacterRequest,
  ProviderProfile,
  UserAccount,
  VoiceProfile,
} from "@meet/protocol";
import { useEffect, useState } from "react";
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
import HistoryPage from "./history/HistoryPage.js";
import CharacterCall from "./realtime/CharacterCall.js";

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
      providers: ProviderProfile[];
      voices: VoiceProfile[];
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
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateServiceWorker, setUpdateServiceWorker] = useState<
    ((reloadPage?: boolean) => Promise<void>) | null
  >(null);

  useEffect(() => {
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
        if (handleUnauthorized(error, session.invalidateSession)) return;
        setCharactersError(presentCharacterError(error, "list"));
        setCharactersLoading(false);
      });
    return () => controller.abort();
  }, [listReload, session.invalidateSession]);

  useEffect(() => {
    if (detail.status !== "loading") return;
    const controller = new AbortController();
    const characterId = detail.characterId;
    void getCharacter(characterId, controller.signal)
      .then((character) => setDetail({ status: "ready", character }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, session.invalidateSession)) return;
        setDetail({
          status: "error",
          characterId,
          message: presentCharacterError(error, "detail"),
        });
      });
    return () => controller.abort();
  }, [detail, session.invalidateSession]);

  useEffect(() => {
    if (editor.status !== "catalog") return;
    const controller = new AbortController();
    const character = editor.character;
    setEditorError("");
    void getCharacterCatalog(controller.signal)
      .then((catalog) => {
        setEditor({ status: "ready", character, ...catalog });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, session.invalidateSession)) return;
        setEditorError(presentCharacterError(error, "detail"));
        setEditor({ status: "closed" });
      });
    return () => controller.abort();
  }, [editor, session.invalidateSession]);

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

  const beginCall = async (characterId: string) => {
    if (busyAction) return;
    setBusyAction(characterId);
    setNotice(null);
    try {
      const value = await getCharacterRuntime(characterId);
      setRuntime(value);
    } catch (error) {
      if (handleUnauthorized(error, session.invalidateSession)) return;
      const message = presentCharacterError(error, "runtime");
      setNotice({ kind: "error", message });
    } finally {
      setBusyAction(null);
    }
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
      if (handleUnauthorized(error, session.invalidateSession)) return;
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
      if (handleUnauthorized(error, session.invalidateSession)) return;
      setNotice({
        kind: "error",
        message: presentCharacterError(error, action),
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
  };

  if (runtime) {
    return (
      <>
        <CharacterCall
          runtime={runtime}
          onExit={() => setRuntime(null)}
          onUnauthorized={session.invalidateSession}
        />
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
                  providers={editor.providers}
                  voices={editor.voices}
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
                />
              )}
            </>
          )}
          {section === "history" && (
            <HistoryPage
              onCall={(characterId) => void beginCall(characterId)}
              onUnauthorized={session.invalidateSession}
            />
          )}
          {section === "memory" && <ComingSoon section="memory" />}
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
          {item.id === "memory" && <small>下一阶段</small>}
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

function ComingSoon({ section: _section }: { section: "memory" }) {
  return (
    <div className="coming-soon page-frame">
      <span aria-hidden="true">◎</span>
      <p className="product-eyebrow">NEXT STAGE</p>
      <h1>长期记忆</h1>
      <p>
        下一阶段会在这里管理明确事实与待确认建议；不同账号的私人记忆始终隔离。
      </p>
      <strong>通话历史稳定后继续建设</strong>
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
        {user.accountType === "admin" && (
          <button type="button" onClick={session.openFamilyMembers}>
            <span>
              <strong>家庭成员</strong>
              <small>创建账号、重置密码与儿童资料权限</small>
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
  if (error instanceof CharacterApiError && error.status === 401) {
    invalidate();
    return true;
  }
  return false;
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
