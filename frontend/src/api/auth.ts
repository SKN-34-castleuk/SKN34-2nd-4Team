// Frontend에서 사용하는 인증 API 클라이언트입니다.

export type AuthUser = {
  id: number;
  username: string;
  display_name: string;
  created_at: string;
};

type AuthResponse = {
  user: AuthUser;
};

export type AuthApiError = Error & {
  status?: number;
};

type ErrorPayload = {
  detail?: string | Array<{ msg?: string }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = "요청을 처리하지 못했습니다.";
    try {
      const payload = (await response.json()) as ErrorPayload;
      if (typeof payload.detail === "string") {
        message = payload.detail;
      } else if (Array.isArray(payload.detail) && payload.detail.length > 0) {
        message = payload.detail[0].msg ?? message;
      }
    } catch {
      // JSON이 아닌 오류 응답은 기본 오류 문구를 사용합니다.
    }

    const error = new Error(message) as AuthApiError;
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function signup(payload: {
  username: string;
  display_name: string;
  password: string;
}): Promise<AuthResponse> {
  return request<AuthResponse>("/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function login(payload: {
  username: string;
  password: string;
  remember_me: boolean;
}): Promise<AuthResponse> {
  return request<AuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getCurrentUser(): Promise<AuthUser> {
  return request<AuthUser>("/api/v1/auth/me");
}

export function logout(): Promise<void> {
  return request<void>("/api/v1/auth/logout", { method: "POST" });
}
