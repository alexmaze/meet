import type { GuardianHistoryAccess, UserAccount } from "@meet/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  createMember,
  listMembers,
  MemberApiError,
  resetMemberPassword,
  updateChildHistoryAccess,
} from "./member-api.js";
import {
  getMemberErrorMessage,
  sortMembers,
  validateCreateMember,
  validatePasswordReset,
  type CreatableAccountType,
} from "./member-logic.js";

type FamilyMembersPanelProps = {
  currentUser: UserAccount;
  open: boolean;
  onClose: () => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type Notice = {
  kind: "success" | "error";
  message: string;
};

const emptyCreateForm = {
  username: "",
  displayName: "",
  password: "",
  passwordConfirmation: "",
  accountType: "adult" as CreatableAccountType,
  guardianHistoryAccess: "allowed" as GuardianHistoryAccess,
};

export default function FamilyMembersPanel({
  currentUser,
  open,
  onClose,
}: FamilyMembersPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<UserAccount[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [createError, setCreateError] = useState("");
  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [resetError, setResetError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      return;
    }

    setCreateForm((current) => ({
      ...current,
      password: "",
      passwordConfirmation: "",
    }));
    setResetPassword("");
    setResetConfirmation("");
    setResetTargetId(null);
    setCreateError("");
    setResetError("");
    setNotice(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    setLoadState("loading");
    setLoadError("");
    setNotice(null);

    void listMembers(controller.signal)
      .then((result) => {
        setMembers(sortMembers(result));
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadError(presentMemberError(error, "list"));
        setLoadState("error");
      });

    return () => controller.abort();
  }, [open, reload]);

  const clearPasswords = () => {
    setCreateForm((current) => ({
      ...current,
      password: "",
      passwordConfirmation: "",
    }));
    setResetPassword("");
    setResetConfirmation("");
  };

  const closePanel = () => {
    clearPasswords();
    setResetTargetId(null);
    setCreateError("");
    setResetError("");
    setNotice(null);
    onClose();
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setNotice(null);

    const validated = validateCreateMember(createForm);
    if (!validated.ok) {
      setCreateError(validated.message);
      return;
    }

    setBusyAction("create");
    try {
      const created = await createMember(validated.value);
      setMembers((current) => sortMembers([...current, created]));
      setCreateForm(emptyCreateForm);
      setNotice({
        kind: "success",
        message: `已创建 ${created.displayName} 的${accountTypeLabels[created.accountType]}。`,
      });
    } catch (error) {
      setCreateError(presentMemberError(error, "create"));
      clearPasswords();
    } finally {
      setBusyAction(null);
    }
  };

  const changeHistoryAccess = async (member: UserAccount) => {
    if (member.accountType !== "child") {
      return;
    }

    const nextAccess: GuardianHistoryAccess =
      member.guardianHistoryAccess === "allowed" ? "denied" : "allowed";
    setBusyAction(`history:${member.id}`);
    setNotice(null);
    try {
      const updated = await updateChildHistoryAccess(member.id, nextAccess);
      setMembers((current) =>
        sortMembers(
          current.map((item) => (item.id === updated.id ? updated : item)),
        ),
      );
      setNotice({
        kind: "success",
        message:
          nextAccess === "allowed"
            ? `已允许管理员查看 ${member.displayName} 的历史、记忆和已保留录音。`
            : `已禁止管理员查看 ${member.displayName} 的历史、记忆和已保留录音。`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: presentMemberError(error, "update"),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const beginPasswordReset = (memberId: string) => {
    clearPasswords();
    setResetTargetId(memberId);
    setResetError("");
    setNotice(null);
  };

  const cancelPasswordReset = () => {
    setResetTargetId(null);
    setResetPassword("");
    setResetConfirmation("");
    setResetError("");
  };

  const submitPasswordReset = async (
    event: FormEvent<HTMLFormElement>,
    member: UserAccount,
  ) => {
    event.preventDefault();
    setResetError("");
    setNotice(null);

    const validated = validatePasswordReset(resetPassword, resetConfirmation);
    if (!validated.ok) {
      setResetError(validated.message);
      return;
    }

    setBusyAction(`reset:${member.id}`);
    try {
      const revokedSessionCount = await resetMemberPassword(
        member.id,
        validated.value,
      );
      cancelPasswordReset();
      setNotice({
        kind: "success",
        message: `已重置 ${member.displayName} 的密码，并撤销 ${revokedSessionCount} 个登录会话。`,
      });
    } catch (error) {
      setResetError(presentMemberError(error, "reset"));
      setResetPassword("");
      setResetConfirmation("");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="member-dialog"
      aria-labelledby="member-panel-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        closePanel();
      }}
    >
      <div className="member-panel">
        <header className="member-panel-header">
          <div>
            <p className="eyebrow">ADMINISTRATION</p>
            <h2 id="member-panel-title">家庭成员</h2>
            <p>成员账号由管理员统一创建和维护。</p>
          </div>
          <button
            className="member-close"
            type="button"
            aria-label="关闭家庭成员管理"
            onClick={closePanel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {notice && (
          <div
            className={`member-notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.message}
          </div>
        )}

        <div className="member-panel-grid">
          <section
            className="member-list-section"
            aria-labelledby="member-list-title"
          >
            <div className="member-section-heading">
              <div>
                <h3 id="member-list-title">账号列表</h3>
                <p>
                  {loadState === "ready"
                    ? `共 ${members.length} 个家庭账号`
                    : "查看成员类型与账号状态"}
                </p>
              </div>
              {loadState === "ready" && (
                <button
                  className="member-text-button"
                  type="button"
                  onClick={() => setReload((current) => current + 1)}
                >
                  刷新
                </button>
              )}
            </div>

            {loadState === "loading" && (
              <div className="member-loading" role="status">
                <span className="auth-spinner" aria-hidden="true" />
                正在读取家庭成员…
              </div>
            )}

            {loadState === "error" && (
              <div className="member-state member-state-error" role="alert">
                <strong>暂时无法显示成员</strong>
                <p>{loadError}</p>
                <button
                  type="button"
                  onClick={() => setReload((current) => current + 1)}
                >
                  重新加载
                </button>
              </div>
            )}

            {loadState === "ready" && members.length === 0 && (
              <div className="member-state">
                <strong>还没有家庭成员</strong>
                <p>可以在创建区域添加第一个成人或儿童账号。</p>
              </div>
            )}

            {loadState === "ready" && members.length > 0 && (
              <div className="member-list">
                {members.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    isCurrentUser={member.id === currentUser.id}
                    busyAction={busyAction}
                    resetOpen={resetTargetId === member.id}
                    resetPassword={resetPassword}
                    resetConfirmation={resetConfirmation}
                    resetError={resetError}
                    onChangeHistoryAccess={() =>
                      void changeHistoryAccess(member)
                    }
                    onBeginPasswordReset={() => beginPasswordReset(member.id)}
                    onResetPasswordChange={setResetPassword}
                    onResetConfirmationChange={setResetConfirmation}
                    onCancelPasswordReset={cancelPasswordReset}
                    onSubmitPasswordReset={(event) =>
                      void submitPasswordReset(event, member)
                    }
                  />
                ))}
              </div>
            )}
          </section>

          <section
            className="member-create-section"
            aria-labelledby="member-create-title"
          >
            <div className="member-section-heading">
              <div>
                <h3 id="member-create-title">创建成员</h3>
                <p>新成员使用用户名和密码登录。</p>
              </div>
            </div>

            <form
              className="member-form"
              onSubmit={(event) => void submitCreate(event)}
              aria-busy={busyAction === "create"}
            >
              <fieldset disabled={busyAction !== null || loadState !== "ready"}>
                <legend className="member-field-label">账号类型</legend>
                <div className="member-segmented">
                  <label>
                    <input
                      type="radio"
                      name="member-account-type"
                      value="adult"
                      checked={createForm.accountType === "adult"}
                      onChange={() =>
                        setCreateForm((current) => ({
                          ...current,
                          accountType: "adult",
                        }))
                      }
                    />
                    <span>成人</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="member-account-type"
                      value="child"
                      checked={createForm.accountType === "child"}
                      onChange={() =>
                        setCreateForm((current) => ({
                          ...current,
                          accountType: "child",
                          guardianHistoryAccess: "allowed",
                        }))
                      }
                    />
                    <span>儿童</span>
                  </label>
                </div>

                <label htmlFor="member-create-username">用户名</label>
                <input
                  id="member-create-username"
                  name="username"
                  type="text"
                  maxLength={64}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={createForm.username}
                  onChange={(event) => {
                    setCreateForm((current) => ({
                      ...current,
                      username: event.target.value,
                    }));
                    setCreateError("");
                  }}
                />

                <label htmlFor="member-create-name">显示名称</label>
                <input
                  id="member-create-name"
                  name="displayName"
                  type="text"
                  maxLength={80}
                  autoComplete="off"
                  value={createForm.displayName}
                  onChange={(event) => {
                    setCreateForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }));
                    setCreateError("");
                  }}
                />

                <label htmlFor="member-create-password">初始密码</label>
                <input
                  id="member-create-password"
                  name="new-password"
                  type="password"
                  maxLength={256}
                  autoComplete="new-password"
                  value={createForm.password}
                  onChange={(event) => {
                    setCreateForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }));
                    setCreateError("");
                  }}
                />
                <small className="member-field-hint">
                  不限制密码强度，也不会自动移除首尾空格。
                </small>

                <label htmlFor="member-create-password-confirmation">
                  再次输入密码
                </label>
                <input
                  id="member-create-password-confirmation"
                  name="new-password-confirmation"
                  type="password"
                  maxLength={256}
                  autoComplete="new-password"
                  value={createForm.passwordConfirmation}
                  onChange={(event) => {
                    setCreateForm((current) => ({
                      ...current,
                      passwordConfirmation: event.target.value,
                    }));
                    setCreateError("");
                  }}
                />

                {createForm.accountType === "child" && (
                  <div className="member-history-default">
                    <span>儿童私人内容</span>
                    <label>
                      <input
                        type="checkbox"
                        checked={createForm.guardianHistoryAccess === "allowed"}
                        onChange={(event) =>
                          setCreateForm((current) => ({
                            ...current,
                            guardianHistoryAccess: event.target.checked
                              ? "allowed"
                              : "denied",
                          }))
                        }
                      />
                      <span>允许管理员查看历史、记忆和已保留录音</span>
                    </label>
                    <small>默认允许，创建后仍可单独调整。</small>
                  </div>
                )}

                {createError && (
                  <p className="member-form-error" role="alert">
                    {createError}
                  </p>
                )}

                <button className="member-primary-button" type="submit">
                  {busyAction === "create" ? "正在创建…" : "创建家庭成员"}
                </button>
              </fieldset>
            </form>
          </section>
        </div>
      </div>
    </dialog>
  );
}

type MemberCardProps = {
  member: UserAccount;
  isCurrentUser: boolean;
  busyAction: string | null;
  resetOpen: boolean;
  resetPassword: string;
  resetConfirmation: string;
  resetError: string;
  onChangeHistoryAccess: () => void;
  onBeginPasswordReset: () => void;
  onResetPasswordChange: (value: string) => void;
  onResetConfirmationChange: (value: string) => void;
  onCancelPasswordReset: () => void;
  onSubmitPasswordReset: (event: FormEvent<HTMLFormElement>) => void;
};

function MemberCard({
  member,
  isCurrentUser,
  busyAction,
  resetOpen,
  resetPassword,
  resetConfirmation,
  resetError,
  onChangeHistoryAccess,
  onBeginPasswordReset,
  onResetPasswordChange,
  onResetConfirmationChange,
  onCancelPasswordReset,
  onSubmitPasswordReset,
}: MemberCardProps) {
  const isAdmin = member.accountType === "admin";
  const historyPending = busyAction === `history:${member.id}`;
  const resetPending = busyAction === `reset:${member.id}`;

  return (
    <article className="member-card">
      <div className="member-card-summary">
        <span
          className={`member-avatar member-avatar-${member.accountType}`}
          aria-hidden="true"
        >
          {Array.from(member.displayName.trim())[0] ?? "M"}
        </span>
        <div className="member-identity">
          <div>
            <strong>{member.displayName}</strong>
            {isCurrentUser && <span className="member-you">当前账号</span>}
          </div>
          <span>@{member.username}</span>
        </div>
        <div className="member-badges">
          <span>{accountTypeLabels[member.accountType]}</span>
          <span className={`member-status member-status-${member.status}`}>
            {member.status === "active" ? "正常" : "已停用"}
          </span>
        </div>
      </div>

      {isAdmin ? (
        <p className="member-readonly-note">
          成员管理中不能重置管理员密码；忘记密码时请使用服务器命令。
        </p>
      ) : (
        <div className="member-card-actions">
          {member.accountType === "child" && (
            <div className="member-history-row">
              <div>
                <span>管理员查看历史、记忆和已保留录音</span>
                <strong>
                  {member.guardianHistoryAccess === "allowed"
                    ? "允许"
                    : "不允许"}
                </strong>
              </div>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={onChangeHistoryAccess}
                aria-label={`${member.guardianHistoryAccess === "allowed" ? "禁止" : "允许"}管理员查看 ${member.displayName} 的历史、记忆和已保留录音`}
              >
                {historyPending
                  ? "正在保存…"
                  : member.guardianHistoryAccess === "allowed"
                    ? "改为不允许"
                    : "改为允许"}
              </button>
            </div>
          )}

          {!resetOpen && (
            <button
              className="member-secondary-button"
              type="button"
              disabled={busyAction !== null}
              onClick={onBeginPasswordReset}
            >
              重置密码
            </button>
          )}
        </div>
      )}

      {resetOpen && !isAdmin && (
        <form
          className="member-reset-form"
          onSubmit={onSubmitPasswordReset}
          aria-busy={resetPending}
        >
          <fieldset disabled={resetPending}>
            <legend>重置 {member.displayName} 的密码</legend>
            <label htmlFor={`member-reset-password-${member.id}`}>新密码</label>
            <input
              id={`member-reset-password-${member.id}`}
              type="password"
              maxLength={256}
              autoComplete="new-password"
              value={resetPassword}
              onChange={(event) => onResetPasswordChange(event.target.value)}
            />
            <label htmlFor={`member-reset-confirmation-${member.id}`}>
              再次输入新密码
            </label>
            <input
              id={`member-reset-confirmation-${member.id}`}
              type="password"
              maxLength={256}
              autoComplete="new-password"
              value={resetConfirmation}
              onChange={(event) =>
                onResetConfirmationChange(event.target.value)
              }
            />
            {resetError && (
              <p className="member-form-error" role="alert">
                {resetError}
              </p>
            )}
            <div className="member-reset-actions">
              <button
                className="member-text-button"
                type="button"
                onClick={onCancelPasswordReset}
              >
                取消
              </button>
              <button className="member-primary-button" type="submit">
                {resetPending ? "正在重置…" : "确认重置"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </article>
  );
}

const accountTypeLabels: Record<UserAccount["accountType"], string> = {
  admin: "管理员",
  adult: "成人账号",
  child: "儿童账号",
};

function presentMemberError(
  error: unknown,
  operation: "list" | "create" | "update" | "reset",
): string {
  return getMemberErrorMessage(
    error instanceof MemberApiError ? error.status : null,
    operation,
  );
}
