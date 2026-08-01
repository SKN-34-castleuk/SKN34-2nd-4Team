import { useState } from "react";

import { logout, type AuthUser } from "../../api/auth";

const roleLabels: Record<AuthUser["role"], string> = {
  admin: "관리자",
  analyst: "분석 담당자",
  operations: "운영 담당자",
  marketing: "마케팅 담당자",
};

type DashboardPageProps = {
  user: AuthUser;
  onLoggedOut: () => void;
};

export function DashboardPage({ user, onLoggedOut }: DashboardPageProps) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      onLoggedOut();
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "로그아웃하지 못했습니다.",
      );
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <main className="dashboard-layout">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">CARDOPS CONSOLE</p>
          <h1>고객 분석 대시보드</h1>
        </div>
        <div className="dashboard-account">
          <div>
            <strong>{user.display_name}</strong>
            <span>{roleLabels[user.role]}</span>
          </div>
          <button
            className="dashboard-logout"
            type="button"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "처리 중..." : "로그아웃"}
          </button>
        </div>
      </header>

      <section className="dashboard-placeholder" aria-labelledby="dashboard-placeholder-title">
        <span className="dashboard-placeholder__badge">NEXT</span>
        <h2 id="dashboard-placeholder-title">고객 인사이트 화면을 준비 중입니다.</h2>
        <p>
          로그인 상태가 확인되었습니다. 다음 단계에서 customer_insights 조회 API를
          연결해 위험도 요약 카드와 고객 목록을 표시합니다.
        </p>
      </section>

      {logoutError !== "" && (
        <p className="dashboard-notice" role="alert">
          {logoutError}
        </p>
      )}
    </main>
  );
}
