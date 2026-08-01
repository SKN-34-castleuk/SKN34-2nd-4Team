import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignManagementPage } from "./CampaignManagementPage";

const operationsUser = {
  id: 2,
  username: "operations_team",
  display_name: "운영팀",
  role: "operations" as const,
  created_at: "2026-08-01T00:00:00Z",
};

function successResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const campaign = {
  id: 1,
  name: "8월 고위험 고객 리텐션",
  description: "고위험 고객의 재활성화를 위한 캠페인입니다.",
  channel: "전화",
  status: "active",
  start_at: "2026-08-01T00:00:00Z",
  end_at: null,
  created_by_user_id: 2,
  created_by_display_name: "운영팀",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  stats: {
    total_targets: 1,
    unprocessed_targets: 0,
    contacted_targets: 1,
    converted_targets: 1,
  },
};

const target = {
  id: 10,
  customer_id: 1001,
  customer_insight_id: 20,
  campaign_id: 1,
  campaign_name: "8월 고위험 고객 리텐션",
  campaign_status: "active",
  assigned_to_user_id: 2,
  assigned_to_display_name: "운영팀",
  status: "completed",
  processed_at: "2026-08-01T01:00:00Z",
  result: "상담 완료",
  result_notes: null,
  result_code: "converted",
  converted: true,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T01:00:00Z",
};

function campaignFetchMock() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/campaigns/1/targets")) {
      return Promise.resolve(successResponse({
        items: [target],
        page: 1,
        page_size: 8,
        total: 1,
        total_pages: 1,
        stats: campaign.stats,
      }));
    }
    if (path.includes("/campaigns/1/events")) {
      return Promise.resolve(successResponse({
        items: [{
          id: 30,
          campaign_id: 1,
          campaign_target_id: 10,
          event_type: "status_changed",
          from_status: "contacted",
          to_status: "completed",
          actor_user_id: 2,
          actor_display_name: "운영팀",
          note: null,
          metadata_json: null,
          created_at: "2026-08-01T01:00:00Z",
        }],
        page: 1,
        page_size: 8,
        total: 1,
      }));
    }
    if (path.includes("/auth/users")) {
      return Promise.resolve(successResponse([operationsUser]));
    }
    return Promise.resolve(successResponse({
      items: [campaign],
      page: 1,
      page_size: 8,
      total: 1,
      total_pages: 1,
    }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("캠페인 관리 화면", () => {
  it("캠페인 통계·대상·이벤트 이력을 표시합니다", async () => {
    vi.stubGlobal("fetch", campaignFetchMock());

    render(
      <CampaignManagementPage
        user={operationsUser}
        onBack={vi.fn()}
        onLoggedOut={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "캠페인 관리" })).toBeInTheDocument();
    expect(screen.getAllByText("8월 고위험 고객 리텐션")).toHaveLength(2);
    expect(await screen.findByText("고객 1001")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "캠페인 이벤트 이력" })).toBeInTheDocument();
    expect(screen.getByText("상태 변경")).toBeInTheDocument();
  });
});
