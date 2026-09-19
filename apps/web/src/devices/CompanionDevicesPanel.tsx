import type { CompanionDeviceSummary } from "@meet/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  bindCompanionDevice,
  DeviceApiError,
  listCompanionDevices,
  revokeCompanionDevice,
} from "./device-api.js";

type CompanionDevicesPanelProps = {
  open: boolean;
  onClose: () => void;
  onSessionInvalid: () => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type Notice = {
  kind: "success" | "error";
  message: string;
};

export default function CompanionDevicesPanel({
  open,
  onClose,
  onSessionInvalid,
}: CompanionDevicesPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [devices, setDevices] = useState<CompanionDeviceSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [bindError, setBindError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

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
    if (open) return;
    setPairingCode("");
    setBindError("");
    setNotice(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadState("loading");
    setLoadError("");
    setNotice(null);
    void listCompanionDevices(controller.signal)
      .then((result) => {
        setDevices(result);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DeviceApiError && error.status === 401) {
          onSessionInvalid();
          return;
        }
        setLoadError(presentDeviceError(error));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [open, reload, onSessionInvalid]);

  const closePanel = () => {
    setPairingCode("");
    setBindError("");
    setNotice(null);
    onClose();
  };

  const submitBind = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBindError("");
    setNotice(null);
    const code = pairingCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setBindError("请输入设备显示的 6 位配对码。");
      return;
    }

    setBusyAction("bind");
    try {
      const device = await bindCompanionDevice(code);
      setDevices((current) => [device, ...current.filter((item) => item.id !== device.id)]);
      setPairingCode("");
      setNotice({
        kind: "success",
        message: `已绑定「${device.displayName}」。`,
      });
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 401) {
        onSessionInvalid();
        return;
      }
      setBindError(presentDeviceError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const unbind = async (device: CompanionDeviceSummary) => {
    setBusyAction(`revoke:${device.id}`);
    setNotice(null);
    try {
      await revokeCompanionDevice(device.id);
      setDevices((current) => current.filter((item) => item.id !== device.id));
      setNotice({
        kind: "success",
        message: `已解除「${device.displayName}」的绑定。`,
      });
    } catch (error) {
      if (error instanceof DeviceApiError && error.status === 401) {
        onSessionInvalid();
        return;
      }
      setNotice({
        kind: "error",
        message: presentDeviceError(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="member-dialog"
      aria-labelledby="companion-devices-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        closePanel();
      }}
    >
      <div className="member-panel">
        <header className="member-panel-header">
          <div>
            <p className="eyebrow">COMPANION DEVICES</p>
            <h2 id="companion-devices-title">陪伴设备</h2>
            <p>输入设备上的配对码，把音箱或终端绑定到当前账号。</p>
          </div>
          <button
            className="member-close"
            type="button"
            aria-label="关闭陪伴设备"
            onClick={closePanel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {notice && (
          <div
            className={`member-notice ${notice.kind}`}
            role={notice.kind === "success" ? "status" : "alert"}
          >
            {notice.message}
          </div>
        )}

        <div className="member-panel-grid">
        <section className="member-create-section">
          <div className="member-section-heading">
            <h3>绑定新设备</h3>
            <p>在设备屏幕上查看 6 位配对码后输入。</p>
          </div>
          <form
            className="member-form"
            onSubmit={(event) => void submitBind(event)}
            aria-busy={busyAction === "bind"}
          >
            <fieldset disabled={busyAction !== null}>
              <label htmlFor="companion-pairing-code">配对码</label>
              <input
                id="companion-pairing-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6 位数字"
                value={pairingCode}
                onChange={(event) => {
                  setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                  setBindError("");
                }}
              />
              {bindError && (
                <p className="member-form-error" role="alert">
                  {bindError}
                </p>
              )}
              <button className="member-primary-button" type="submit">
                {busyAction === "bind" ? "正在绑定…" : "绑定设备"}
              </button>
            </fieldset>
          </form>
        </section>

        <section className="member-list-section">
          <div className="member-section-heading">
            <h3>已绑定设备</h3>
            <button
              className="member-text-button"
              type="button"
              disabled={busyAction !== null || loadState === "loading"}
              onClick={() => setReload((current) => current + 1)}
            >
              刷新
            </button>
          </div>
          {loadState === "loading" && (
            <div className="member-loading" role="status">
              正在加载设备列表…
            </div>
          )}
          {loadState === "error" && (
            <div className="member-state member-state-error" role="alert">
              {loadError}
            </div>
          )}
          {loadState === "ready" && devices.length === 0 && (
            <div className="member-state">还没有绑定的陪伴设备。</div>
          )}
          {loadState === "ready" && devices.length > 0 && (
            <div className="member-list">
              {devices.map((device) => (
                <article key={device.id} className="member-card">
                  <div className="member-card-summary">
                    <div className="member-identity">
                      <strong>{device.displayName}</strong>
                      <p>
                        最近在线{" "}
                        {new Date(device.lastSeenAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                  </div>
                  <div className="member-card-actions">
                    <button
                      className="member-secondary-button"
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void unbind(device)}
                    >
                      {busyAction === `revoke:${device.id}`
                        ? "正在解绑…"
                        : "解除绑定"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        </div>
      </div>
    </dialog>
  );
}

function presentDeviceError(error: unknown): string {
  if (error instanceof DeviceApiError) {
    if (error.serverMessage) return error.serverMessage;
    if (error.status === 429) return "操作过于频繁，请稍后再试。";
    if (error.status === 503) return "设备服务暂时不可用。";
  }
  return "无法完成设备操作，请稍后重试。";
}
