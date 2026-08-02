import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const marketingUser = {
  id: 4,
  username: "marketing_team",
  display_name: "마케팅팀",
  role: "marketing" as const,
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

function departmentFetchMock(isAdmin = false, conflictOnCreate = false) {
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const query = new URL(path, "http://localhost").searchParams;
    const insightPage = Number(query.get("page") ?? "1");
    if (path.includes("/campaign-targets")) {
      if (conflictOnCreate && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ detail: "The customer already has an equal-or-higher priority active campaign." }),
        });
      }
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
      page: insightPage,
      page_size: 8,
      total: 42,
      total_pages: 6,
      stats: {
        total: 42,
        average_churn_probability: 0.82,
        risk_counts: { high: 42, medium: 0, low: 0 },
        cluster_counts: { "활성 저하군": 1 },
        cluster_options: { "활성 저하군": 1 },
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

  it("마케팅팀은 전체 우선 고객을 서버 페이지 단위로 확인합니다", async () => {
    const fetchMock = departmentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<DepartmentDashboardPage user={marketingUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "마케팅 캠페인 센터" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "캠페인 후보 고객" })).toBeInTheDocument();
    expect(screen.getByText("42명")).toBeInTheDocument();
    expect(screen.getByText("1–8 / 42명")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("campaign_candidates_only=true"))).toBe(true));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/campaign-targets?page=1&page_size=8"))).toBe(true));

    fireEvent.change(screen.getByRole("combobox", { name: "캠페인 후보 위험도" }), {
      target: { value: "high" },
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("risk_level=high"))).toBe(true));

    fireEvent.change(screen.getByRole("combobox", { name: "캠페인 후보 정렬 기준" }), {
      target: { value: "expected_transaction_count" },
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("sort_by=expected_transaction_count"))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "다음 우선 고객 페이지" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("page=2"))).toBe(true));
    expect(await screen.findByText("9–16 / 42명")).toBeInTheDocument();
  });

  it("마케팅팀 대시보드는 후보 확인용으로만 제공하고 개별 등록은 캠페인 센터에서 처리합니다", async () => {
    const fetchMock = departmentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<DepartmentDashboardPage user={marketingUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "캠페인 후보 고객" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "캠페인 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "캠페인 관리" })).not.toBeInTheDocument();
  });

  it("관리자는 팀 계정과 권한 현황을 봅니다", async () => {
    vi.stubGlobal("fetch", departmentFetchMock(true));

    render(<DepartmentDashboardPage user={adminUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "관리자 콘솔" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "활성 팀 계정" })).toBeInTheDocument();
    expect(screen.getByText("운영팀")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "관리자 역할" })).toBeDisabled();
    expect(screen.queryByText("역할별 업무 권한")).not.toBeInTheDocument();
  });
});
