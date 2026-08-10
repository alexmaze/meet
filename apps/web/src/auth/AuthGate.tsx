import {
  apiErrorSchema,
  authenticatedUserResponseSchema,
  loginRequestSchema,
  type UserAccount,
} from "@meet/protocol";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import FamilyMembersPanel from "../admin/FamilyMembersPanel.js";
import PasswordChangePanel from "./PasswordChangePanel.js";
import {
  getAuthErrorPresentation,
  type AuthErrorPresentation,
  type AuthOperation,
} from "./auth-errors.js";

export type AuthenticatedAppSession = {
  user: UserAccount;
  logoutPending: boolean;
  logoutError: string;
  openFamilyMembers: () => void;
  openPasswordChange: () => void;
  logout: () => void;
  invalidateSession: () => void;
};

type AuthGateProps = {
  children: (session: AuthenticatedAppSession) => ReactNode;
};

type SessionState =
  | { status: "loading" }
  | {
      status: "signed_out";
      message: string;
      serviceUnavailable: boolean;
    }
  | { status: "signed_in"; user: UserAccount };

class AuthRequestError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export default function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [sessionCheck, setSessionCheck] = useState(0);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);

  const invalidateSession = useCallback(() => {
    setMembersOpen(false);
    setPasswordChangeOpen(false);
    setLogoutError("");
    setSession({
      status: "signed_out",
      message: "登录状态已失效，请重新登录。",
      serviceUnavailable: false,
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    setSession({ status: "loading" });
    void requestCurrentUser(controller.signal)
      .then((user) => {
        if (!ignore) {
          setSession({ status: "signed_in", user });
        }
      })
      .catch((error: unknown) => {
        if (ignore || controller.signal.aborted) {
          return;
        }

        const presentation = presentRequestError("session", error);
        setSession({
          status: "signed_out",
          message: presentation.message,
          serviceUnavailable: presentation.serviceUnavailable,
        });
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [sessionCheck]);

  const handleLogin = async (input: {
    username: string;
    password: string;
  }): Promise<AuthErrorPresentation | null> => {
    try {
      const user = await requestLogin(input);
      setLogoutError("");
      setSession({ status: "signed_in", user });
      return null;
    } catch (error) {
      return presentRequestError("login", error);
    }
  };

  const handleLogout = async (): Promise<void> => {
    setMembersOpen(false);
    setPasswordChangeOpen(false);
    setLogoutPending(true);
    setLogoutError("");

    try {
      await requestLogout();
      setSession({
        status: "signed_out",
        message: "",
        serviceUnavailable: false,
      });
    } catch (error) {
      if (error instanceof AuthRequestError && error.status === 401) {
        invalidateSession();
        return;
      }
      if (error instanceof AuthRequestError && error.status === 503) {
        const presentation = presentRequestError("logout", error);
        setSession({
          status: "signed_out",
          message: presentation.message,
          serviceUnavailable: presentation.serviceUnavailable,
        });
        return;
      }
      setLogoutError(presentRequestError("logout", error).message);
    } finally {
      setLogoutPending(false);
    }
  };

  if (session.status === "loading") {
    return <AuthLoading />;
  }

  if (session.status === "signed_out") {
    return (
      <LoginScreen
        initialMessage={session.message}
        serviceUnavailable={session.serviceUnavailable}
        onLogin={handleLogin}
        onRetry={() => setSessionCheck((current) => current + 1)}
      />
    );
  }

  return (
    <div className="authenticated-shell">
      {children({
        user: session.user,
        logoutPending,
        logoutError,
        openFamilyMembers: () => {
          setPasswordChangeOpen(false);
          setMembersOpen(true);
        },
        openPasswordChange: () => {
          setMembersOpen(false);
          setPasswordChangeOpen(true);
        },
        logout: () => void handleLogout(),
        invalidateSession,
      })}
      {session.user.accountType === "admin" && (
        <FamilyMembersPanel
          currentUser={session.user}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      )}
      <PasswordChangePanel
        open={passwordChangeOpen}
        onClose={() => setPasswordChangeOpen(false)}
        onSessionInvalid={invalidateSession}
      />
    </div>
  );
}

function AuthLoading() {
  return (
    <div className="auth-screen">
      <div className="auth-glow auth-glow-one" />
      <div className="auth-glow auth-glow-two" />
      <main className="auth-card auth-loading-card" aria-live="polite">
        <MeetIdentity />
        <div className="auth-loading" role="status">
          <span className="auth-spinner" aria-hidden="true" />
          <div>
            <strong>正在确认登录状态</strong>
            <p>马上带你回到 Meet。</p>
          </div>
        </div>
      </main>
    </div>
  );
}

type LoginScreenProps = {
  initialMessage: string;
  serviceUnavailable: boolean;
  onLogin: (input: {
    username: string;
    password: string;
  }) => Promise<AuthErrorPresentation | null>;
  onRetry: () => void;
};

function LoginScreen({
  initialMessage,
  serviceUnavailable,
  onLogin,
  onRetry,
}: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [unavailable, setUnavailable] = useState(serviceUnavailable);
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("");
    setUnavailable(false);

    const input = loginRequestSchema.safeParse({ username, password });
    if (!input.success) {
      if (!username.trim()) {
        setMessage("请输入用户名。");
      } else if (!password) {
        setMessage("请输入密码。");
      } else {
        setMessage("请输入有效的用户名和密码。");
      }
      return;
    }

    setSubmitting(true);
    const loginError = await onLogin(input.data);
    if (loginError) {
      setMessage(loginError.message);
      setUnavailable(loginError.serviceUnavailable);
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-glow auth-glow-one" />
      <div className="auth-glow auth-glow-two" />
      <main className="auth-card">
        <MeetIdentity />
        <div className="auth-heading">
          <p className="eyebrow">FAMILY SPACE</p>
          <h1>欢迎回家</h1>
          <p>使用管理员为你创建的家庭账号登录。</p>
        </div>

        {message && (
          <div
            className={`auth-message ${unavailable ? "unavailable" : ""}`}
            role={unavailable ? "status" : "alert"}
          >
            {message}
          </div>
        )}

        <form
          className="auth-form"
          onSubmit={(event) => void submitLogin(event)}
          aria-busy={submitting}
        >
          <fieldset disabled={submitting || unavailable}>
            <label htmlFor="auth-username">用户名</label>
            <input
              id="auth-username"
              name="username"
              type="text"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              onChange={(event) => {
                setUsername(event.target.value);
                setMessage("");
              }}
            />

            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              value={password}
              autoComplete="current-password"
              enterKeyHint="go"
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage("");
              }}
            />

            <button className="auth-submit" type="submit">
              {submitting ? "正在登录…" : "登录 Meet"}
            </button>
          </fieldset>
        </form>

        {unavailable && (
          <button className="auth-retry" type="button" onClick={onRetry}>
            重新检查账号服务
          </button>
        )}

        <p className="auth-footnote">
          Meet 不开放注册。需要新账号时，请联系家庭管理员创建。
        </p>
      </main>
    </div>
  );
}

function MeetIdentity() {
  return (
    <div className="auth-brand" aria-label="Meet">
      <span className="brand-mark">M</span>
      <span>
        <strong>Meet</strong>
        <small>PRIVATE FAMILY SPACE</small>
      </span>
    </div>
  );
}

async function requestCurrentUser(signal: AbortSignal): Promise<UserAccount> {
  const response = await fetch("/api/auth/me", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  return readUserResponse(response);
}

async function requestLogin(input: {
  username: string;
  password: string;
}): Promise<UserAccount> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return readUserResponse(response);
}

async function requestLogout(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await createRequestError(response);
  }
}

async function readUserResponse(response: Response): Promise<UserAccount> {
  if (!response.ok) {
    throw await createRequestError(response);
  }

  try {
    const result = authenticatedUserResponseSchema.safeParse(
      await response.json(),
    );
    if (!result.success) {
      throw new AuthRequestError(
        response.status,
        "账号服务返回的数据格式不正确。",
      );
    }
    return result.data.user;
  } catch (error) {
    if (error instanceof AuthRequestError) {
      throw error;
    }
    throw new AuthRequestError(
      response.status,
      "账号服务返回的数据格式不正确。",
    );
  }
}

async function createRequestError(response: Response) {
  let message = "";
  try {
    const result = apiErrorSchema.safeParse(await response.json());
    if (result.success) {
      message = result.data.message;
    }
  } catch {
    // 非 JSON 错误响应交给统一中文错误文案处理。
  }
  return new AuthRequestError(response.status, message);
}

function presentRequestError(operation: AuthOperation, error: unknown) {
  if (error instanceof AuthRequestError) {
    return getAuthErrorPresentation({
      operation,
      status: error.status,
      serverMessage: error.message,
    });
  }

  return getAuthErrorPresentation({ operation, status: null });
}
