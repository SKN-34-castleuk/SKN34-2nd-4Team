import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { LoginPage } from "./LoginPage";

describe("로그인 페이지", () => {
  it("CardOps 로고와 팀 계정 로그인 화면을 표시합니다", () => {
    render(<LoginPage />);

    expect(screen.getByText("CardOps")).toBeInTheDocument();
    expect(screen.getByLabelText("팀 계정 아이디")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "회원가입" }),
    ).toBeInTheDocument();
  });

  it("필수 입력값이 없으면 각 필드의 오류를 표시합니다", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "로그인" }));

    expect(
      screen.getByText("팀 계정 아이디를 입력해 주세요."),
    ).toBeInTheDocument();
    expect(screen.getByText("비밀번호를 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByLabelText("팀 계정 아이디")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("비밀번호 표시 상태를 전환합니다", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    const password = screen.getByLabelText("비밀번호");

    expect(password).toHaveAttribute("type", "password");
    await user.click(
      screen.getByRole("button", { name: "비밀번호 표시하기" }),
    );
    expect(password).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "비밀번호 숨기기" }),
    ).toBeInTheDocument();
  });

  it("유효한 입력이면 인증 API 연결 안내를 표시합니다", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("팀 계정 아이디"), "analysis_team");
    await user.type(screen.getByLabelText("비밀번호"), "temporary-password");
    await user.click(screen.getByRole("button", { name: "로그인" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "인증 API 연결 후 부서별 콘솔로 이동합니다.",
    );
  });
});
