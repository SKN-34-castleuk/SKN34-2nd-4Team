import { useCallback, useEffect, useState } from "react";

import { getCurrentUser, type AuthUser } from "../api/auth";
import type { ApiError } from "../api/client";
import { LoginPage } from "../features/auth/LoginPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";

type AuthState =
  | { status: "checking" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error"; message: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "로그인 상태를 확인하지 못했습니다.";
}

function isUnauthorized(error: unknown): boolean {
  return (error as ApiError | undefined)?.status === 401;
}

function AuthLoading() {
  return (
    <main className="auth-state auth-state--loading" aria-busy="true">
      <div className="auth-state__card">
        <span className="auth-state__mark" aria-hidden="true" />
        <p>로그인 상태를 확인하고 있습니다.</p>
      </div>
    </main>
  );
}

function AuthError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="auth-state">
      <div className="auth-state__card">
        <span className="auth-state__mark auth-state__mark--error" aria-hidden="true" />
        <h1>서비스에 연결할 수 없습니다.</h1>
        <p>{message}</p>
        <button className="auth-state__button" type="button" onClick={onRetry}>
          다시 시도
        </button>
      </div>
    </main>
  );
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>({
    status: "checking",
  });

  useEffect(() => {
    let isActive = true;

    const checkSession = async () => {
      try {
        const user = await getCurrentUser();
        if (isActive) {
          setAuthState({ status: "authenticated", user });
        }
      } catch (error) {
        if (!isActive) {
          return;
        }

        if (isUnauthorized(error)) {
          setAuthState({ status: "unauthenticated" });
          return;
        }

        setAuthState({ status: "error", message: getErrorMessage(error) });
      }
    };

    void checkSession();
    return () => {
      isActive = false;
    };
  }, []);

  const retrySession = useCallback(() => {
    setAuthState({ status: "checking" });
    void getCurrentUser()
      .then((user) => setAuthState({ status: "authenticated", user }))
      .catch((error: unknown) => {
        if (isUnauthorized(error)) {
          setAuthState({ status: "unauthenticated" });
          return;
        }

        setAuthState({ status: "error", message: getErrorMessage(error) });
      });
  }, []);

  if (authState.status === "checking") {
    return <AuthLoading />;
  }

  if (authState.status === "error") {
    return <AuthError message={authState.message} onRetry={retrySession} />;
  }

  if (authState.status === "unauthenticated") {
    return (
      <LoginPage
        onAuthenticated={(user) =>
          setAuthState({ status: "authenticated", user })
        }
      />
    );
  }

  return (
    <DashboardPage
      user={authState.user}
      onLoggedOut={() => setAuthState({ status: "unauthenticated" })}
    />
  );
}
