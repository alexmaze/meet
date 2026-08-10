import { useEffect, useRef, useState, type FormEvent } from "react";

import { changePassword } from "./password-change-api.js";
import { PasswordChangeApiError } from "./password-change-api.js";
import {
  getPasswordChangeErrorMessage,
  validatePasswordChange,
} from "./password-change-logic.js";

type PasswordChangePanelProps = {
  open: boolean;
  onClose: () => void;
  onSessionInvalid: () => void;
};

export default function PasswordChangePanel({
  open,
  onClose,
  onSessionInvalid,
}: PasswordChangePanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) clearForm();
  }, [open]);

  const closePanel = () => {
    clearForm();
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("");
    setSuccess(false);
    const validated = validatePasswordChange(
      currentPassword,
      newPassword,
      confirmation,
    );
    if (!validated.ok) {
      setMessage(validated.message);
      return;
    }

    setSubmitting(true);
    try {
      const revokedSessionCount = await changePassword(validated.value);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSuccess(true);
      setMessage(
        revokedSessionCount > 0
          ? `密码已修改，其他 ${revokedSessionCount} 个登录会话已退出。当前设备保持登录。`
          : "密码已修改，当前设备保持登录。",
      );
    } catch (error) {
      if (error instanceof PasswordChangeApiError && error.status === 401) {
        onSessionInvalid();
        return;
      }
      setCurrentPassword("");
      setMessage(
        error instanceof PasswordChangeApiError
          ? getPasswordChangeErrorMessage(error.status, error.serverMessage)
          : getPasswordChangeErrorMessage(null),
      );
    } finally {
      setSubmitting(false);
    }
  };

  function clearForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setMessage("");
    setSuccess(false);
    setSubmitting(false);
  }

  return (
    <dialog
      ref={dialogRef}
      className="password-dialog"
      aria-labelledby="password-panel-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        closePanel();
      }}
    >
      <div className="password-panel">
        <header className="password-panel-header">
          <div>
            <p className="eyebrow">ACCOUNT SECURITY</p>
            <h2 id="password-panel-title">修改密码</h2>
            <p>输入当前密码后设置新密码。</p>
          </div>
          <button
            className="member-close"
            type="button"
            aria-label="关闭修改密码"
            onClick={closePanel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {message && (
          <div
            className={`member-notice ${success ? "success" : "error"}`}
            role={success ? "status" : "alert"}
          >
            {message}
          </div>
        )}

        <form
          className="password-form"
          onSubmit={(event) => void submit(event)}
          aria-busy={submitting}
        >
          <fieldset disabled={submitting}>
            <label htmlFor="password-current">当前密码</label>
            <input
              id="password-current"
              type="password"
              maxLength={256}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setMessage("");
                setSuccess(false);
              }}
            />

            <label htmlFor="password-new">新密码</label>
            <input
              id="password-new"
              type="password"
              maxLength={256}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setMessage("");
                setSuccess(false);
              }}
            />

            <label htmlFor="password-confirmation">再次输入新密码</label>
            <input
              id="password-confirmation"
              type="password"
              maxLength={256}
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setMessage("");
                setSuccess(false);
              }}
            />
            <small>不限制密码强度；新密码不会自动移除首尾空格。</small>

            <div className="password-form-actions">
              <button
                className="member-text-button"
                type="button"
                onClick={closePanel}
              >
                取消
              </button>
              <button className="member-primary-button" type="submit">
                {submitting ? "正在修改…" : "确认修改"}
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </dialog>
  );
}
