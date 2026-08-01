import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DepartmentDashboardPage } from "./DepartmentDashboardPage";

const operationsUser = {
  id: 2,
  username: "operations_team",
  display_name: "운영팀",
  role: "operations" as const,
  is_active: true,
  created_at: "2026-08-01T00:00:00Z",
};

const adminUser = {
  id: 1,
  username: "admin_team",
  display_name: "관리자",
  role: "admin" as const,
  is_active: true,
  created_at: "2026-08-01T00:00:00Z",
};

const insight = {
  id: 10,
  customer_id: 1001,
  classification_run_id: 1,
  regression_run_id: 2,
  clustering_run_id: 3,
  churn_probability: 0.82,
  risk_level: "high",
  expected_transaction_count: 12.5,
  activity_gap: -4.2,
  cluster_name: "활성 저하군",
  cluster_confidence: 0.91,
  recommended_action: "개인화 혜택을 제안하세요.",
  reason_codes: { inactivity: "높음" },
  scored_at: "2026-08-01T00:00:00Z",
};

function successResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function departmentFetchMock(isAdmin = false) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/campaign-targets")) {
      return Promise.resolve(successResponse({ items: [], page: 1, page_size: 100, total: 0, total_pages: 0 }));
    }
    if (path.includes("/model-runs/latest")) {
      return Promise.resolve(successResponse({
        status: "succeeded",
        started_at: "2026-08-01T00:00:00Z",
        completed_at: "2026-08-01T00:05:00Z",
        processed_rows: 1,
        dataset_sha256: null,
        runs: [],
      }));
    }
    if (path.includes("/auth/users")) {
      return Promise.resolve(successResponse(isAdmin ? [adminUser, operationsUser] : []));
    }
    return Promise.resolve(successResponse({
      items: [insight],
      page: 1,
      page_size: 100,
      total: 1,
      total_pages: 1,
      stats: {
        total: 1,
        average_churn_probability: 0.82,
        risk_counts: { high: 1, medium: 0, low: 0 },
        cluster_counts: { "활성 저하군": 1 },
      },
    }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("부서별 대시보드", () => {
  it("운영팀은 고위험 고객 처리 화면을 봅니다", async () => {
    vi.stubGlobal("fetch", departmentFetchMock());

    render(<DepartmentDashboardPage user={operationsUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "운영 업무 센터" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "우선 관리 고객" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "리텐션 등록" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "캠페인 처리 현황" })).toBeInTheDocument();
  });

  it("관리자는 팀 계정과 권한 현황을 봅니다", async () => {
    vi.stubGlobal("fetch", departmentFetchMock(true));

    render(<DepartmentDashboardPage user={adminUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "관리자 콘솔" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "활성 팀 계정" })).toBeInTheDocument();
    expect(screen.getByText("운영팀")).toBeInTheDocument();
    expect(screen.getByText("역할별 업무 권한")).toBeInTheDocument();
  });
});
