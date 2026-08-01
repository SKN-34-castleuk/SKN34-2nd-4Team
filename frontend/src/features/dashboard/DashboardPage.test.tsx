import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "./DashboardPage";

const authUser = {
  id: 1,
  username: "analysis_team",
  display_name: "분석팀",
  role: "analyst" as const,
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
  activity_gap: 0.4,
  cluster_name: "활성 저하군",
  cluster_confidence: 0.91,
  recommended_action: "개인화 혜택을 제안하세요.",
  reason_codes: { inactivity: "높음" },
  scored_at: "2026-08-01T00:00:00Z",
};

const insightDetail = {
  ...insight,
  customer: {
    customer_id: 1001,
    customer_age: 42,
    gender: "M",
    dependent_count: 2,
    education_level: "Graduate",
    marital_status: "Married",
    income_category: "$80K - $120K",
    card_category: "Blue",
    months_on_book: 36,
    total_relationship_count: 4,
    months_inactive_12_mon: 2,
    contacts_count_12_mon: 1,
    credit_limit: 10000,
    total_revolving_bal: 3000,
    avg_open_to_buy: 7000,
    total_amt_chng_q4_q1: 0.8,
    total_trans_amt: 5000,
    total_trans_ct: 45,
    total_ct_chng_q4_q1: 0.9,
    avg_utilization_ratio: 0.3,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  },
};

function successResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

const insightList = {
  items: [insight],
  page: 1,
  page_size: 8,
  total: 1,
  total_pages: 1,
  stats: {
    total: 1,
    average_churn_probability: 0.82,
    risk_counts: { high: 1, medium: 0, low: 0 },
    cluster_counts: { "활성 저하군": 1 },
  },
};

const insightHistory = {
  customer_id: 1001,
  items: [insight],
};

const latestBatch = {
  status: "succeeded",
  started_at: "2026-08-01T00:00:00Z",
  completed_at: "2026-08-01T00:05:00Z",
  processed_rows: 1,
  dataset_sha256: null,
  runs: [
    {
      id: 1,
      task: "classification",
      model_name: "xgboost",
      model_version: "v1",
      artifact_sha256: null,
      dataset_sha256: null,
      status: "succeeded",
      processed_rows: 1,
      started_at: "2026-08-01T00:00:00Z",
      completed_at: "2026-08-01T00:05:00Z",
    },
  ],
};

function dashboardFetchMock() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/history/")) {
      return Promise.resolve(successResponse(insightHistory));
    }
    if (path.includes("/model-runs/latest")) {
      return Promise.resolve(successResponse(latestBatch));
    }
    if (path.includes("/campaign-targets")) {
      return Promise.resolve(successResponse({ items: [], page: 1, page_size: 20, total: 0, total_pages: 0 }));
    }
    if (path.endsWith("/1001")) {
      return Promise.resolve(successResponse(insightDetail));
    }
    return Promise.resolve(successResponse(insightList));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("고객 분석 대시보드", () => {
  it("요약 통계와 고객 분석 목록을 표시합니다", async () => {
    const fetchMock = dashboardFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<DashboardPage user={authUser} onLoggedOut={vi.fn()} />);

    expect(await screen.findByText("분석 대상 고객")).toBeInTheDocument();
    expect(screen.getByText("고객별 분석 결과")).toBeInTheDocument();
    expect(screen.getByText("1001")).toBeInTheDocument();
    expect(screen.getByText("개인화 혜택을 제안하세요.")).toBeInTheDocument();
    expect(screen.getAllByText("82%")).toHaveLength(2);
  });

  it("고객을 선택하면 상세 패널을 표시합니다", async () => {
    const fetchMock = dashboardFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DashboardPage user={authUser} onLoggedOut={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /1001/ }));

    expect(
      await screen.findByRole("heading", { name: "고객 1001" }),
    ).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("개인화 혜택을 제안하세요.")).toBeInTheDocument();
    expect(within(dialog).getByText("42세")).toBeInTheDocument();
  });
});
