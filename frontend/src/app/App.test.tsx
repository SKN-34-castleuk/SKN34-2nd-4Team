import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const user = {
  id: 1,
  username: "analysis_team",
  display_name: "분석팀",
  role: "analyst" as const,
  created_at: "2026-08-01T00:00:00Z",
};

function successResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function unauthorizedResponse() {
  return {
    ok: false,
    status: 401,
    json: async () => ({ detail: "Authentication is required." }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("인증 상태 앱 셸", () => {
  it("HttpOnly 세션이 있으면 새로고침 후 대시보드를 표시합니다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse(user));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "고객 분석 대시보드" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("미인증 상태에서 로그인하면 대시보드로 전환합니다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce(successResponse({ user }));
    vi.stubGlobal("fetch", fetchMock);
    const userEventInstance = userEvent.setup();

    render(<App />);

    await userEventInstance.type(
      await screen.findByLabelText("팀 계정 아이디"),
      "analysis_team",
    );
    await userEventInstance.type(
      screen.getByLabelText("비밀번호"),
      "temporary-password",
    );
    await userEventInstance.click(screen.getByRole("button", { name: "로그인" }));

    expect(
      await screen.findByRole("heading", { name: "고객 분석 대시보드" }),
    ).toBeInTheDocument();
  });

  it("로그아웃하면 로그인 화면으로 돌아갑니다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successResponse(user))
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const userEventInstance = userEvent.setup();

    render(<App />);

    await screen.findByRole("heading", { name: "고객 분석 대시보드" });
    await userEventInstance.click(screen.getByRole("button", { name: "로그아웃" }));

    expect(await screen.findByLabelText("팀 계정 아이디")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
