export type AuthOperation = "session" | "login" | "logout";

export type AuthErrorPresentation = {
  message: string;
  serviceUnavailable: boolean;
};

type AuthErrorInput = {
  operation: AuthOperation;
  status: number | null;
  serverMessage?: string;
};

const databaseUnavailableMessage =
  "账号服务尚未就绪。请先在服务端配置 DATABASE_URL，并运行管理员初始化命令，再刷新此页面。";

export function getAuthErrorPresentation({
  operation,
  status,
  serverMessage,
}: AuthErrorInput): AuthErrorPresentation {
  if (status === 503) {
    return {
      message: databaseUnavailableMessage,
      serviceUnavailable: true,
    };
  }

  if (status === null) {
    return {
      message: "无法连接账号服务，请检查网络和 API 服务后重试。",
      serviceUnavailable: false,
    };
  }

  if (operation === "login" && status === 401) {
    return {
      message: "用户名或密码不正确。",
      serviceUnavailable: false,
    };
  }

  if (operation === "session" && status === 401) {
    return {
      message: "",
      serviceUnavailable: false,
    };
  }

  const trimmedServerMessage = serverMessage?.trim();
  if (trimmedServerMessage) {
    return {
      message: trimmedServerMessage,
      serviceUnavailable: false,
    };
  }

  if (operation === "logout") {
    return {
      message: "退出登录失败，请重试。",
      serviceUnavailable: false,
    };
  }

  return {
    message: "账号服务暂时不可用，请稍后重试。",
    serviceUnavailable: false,
  };
}
