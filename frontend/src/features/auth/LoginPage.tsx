import { useId, useState } from "react";
import type { FormEvent } from "react";

type LoginErrors = {
  accountId?: string;
  password?: string;
};

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-mark__card brand-mark__card--back" />
      <span className="brand-mark__card brand-mark__card--front" />
    </span>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  if (hidden) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m3 3 18 18M10.7 10.8a2 2 0 0 0 2.5 2.5M9.9 5.2A10.8 10.8 0 0 1 12 5c5.1 0 8.6 4.2 9.5 6-.4.8-1.3 2.2-2.7 3.5M6.6 6.7C4.5 8 3.1 10 2.5 11.9 3.4 13.7 6.9 18 12 18c1.1 0 2.1-.2 3-.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}

export function LoginPage() {
  const accountId = useId();
  const passwordId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [notice, setNotice] = useState("");

  const clearFieldError = (field: keyof LoginErrors) => {
    setErrors((current) => {
      if (current[field] === undefined) {
        return current;
      }

      return { ...current, [field]: undefined };
    });
    setNotice("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextErrors: LoginErrors = {};

    if (String(form.get("accountId") ?? "").trim() === "") {
      nextErrors.accountId = "팀 계정 아이디를 입력해 주세요.";
    }

    if (String(form.get("password") ?? "").trim() === "") {
      nextErrors.password = "비밀번호를 입력해 주세요.";
    }

    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setNotice("");
      return;
    }

    setNotice(
      "로그인 화면 UI가 준비되었습니다. 인증 API 연결 후 부서별 콘솔로 이동합니다.",
    );
  };

  return (
    <main className="login-layout">
      <section className="login-panel" aria-label="팀 계정 로그인">
        <div className="login-shell">
          <header className="brand login-brand">
            <BrandMark />
            <span className="brand__copy">
              <strong>CardOps</strong>
              <small>Credit Card Operations Console</small>
            </span>
          </header>

          <div className="login-card">
            <form className="login-form" noValidate onSubmit={handleSubmit}>
              <div className="form-field">
                <label htmlFor={accountId}>팀 계정 아이디</label>
                <input
                  id={accountId}
                  name="accountId"
                  type="text"
                  autoComplete="username"
                  placeholder="예: analysis_team"
                  aria-invalid={errors.accountId !== undefined}
                  aria-describedby={
                    errors.accountId === undefined
                      ? undefined
                      : `${accountId}-error`
                  }
                  onInput={() => clearFieldError("accountId")}
                />
                {errors.accountId !== undefined && (
                  <span className="field-error" id={`${accountId}-error`}>
                    {errors.accountId}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor={passwordId}>비밀번호</label>
                <div
                  className={`password-input ${
                    errors.password === undefined
                      ? ""
                      : "password-input--error"
                  }`}
                >
                  <input
                    id={passwordId}
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="비밀번호를 입력하세요"
                    aria-invalid={errors.password !== undefined}
                    aria-describedby={
                      errors.password === undefined
                        ? undefined
                        : `${passwordId}-error`
                    }
                    onInput={() => clearFieldError("password")}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    aria-label={
                      showPassword ? "비밀번호 숨기기" : "비밀번호 표시하기"
                    }
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    <EyeIcon hidden={showPassword} />
                  </button>
                </div>
                {errors.password !== undefined && (
                  <span className="field-error" id={`${passwordId}-error`}>
                    {errors.password}
                  </span>
                )}
              </div>

              <div className="login-form__options">
                <label className="checkbox">
                  <input type="checkbox" name="rememberAccount" />
                  <span aria-hidden="true" />
                  아이디 기억하기
                </label>
                <span className="account-help">계정 문의 · 관리자</span>
              </div>

              <button className="submit-button" type="submit">
                로그인
                <ArrowIcon />
              </button>

              <button className="signup-button" type="button">
                회원가입
              </button>

              {notice !== "" && (
                <p className="login-notice" role="status">
                  {notice}
                </p>
              )}
            </form>

          </div>

          <footer className="login-panel__footer">
            <span>© 2026 CardOps Console</span>
            <span>v0.1.0</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
