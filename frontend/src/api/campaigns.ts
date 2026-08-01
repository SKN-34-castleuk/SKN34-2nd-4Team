// 캠페인 대상 조회·등록·처리 API 클라이언트입니다.

import { request } from "./client";
import type { components } from "./schema";

export type CampaignTarget = components["schemas"]["CampaignTargetResponse"];
export type CampaignTargetList =
  components["schemas"]["CampaignTargetListResponse"];
export type CampaignStatus = components["schemas"]["CampaignStatus"];

export function listCampaignTargets(query: {
  status?: CampaignStatus;
  page?: number;
  page_size?: number;
} = {}): Promise<CampaignTargetList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return request<CampaignTargetList>(
    `/api/v1/campaign-targets${encoded.length > 0 ? `?${encoded}` : ""}`,
  );
}

export function createCampaignTarget(payload: {
  customer_insight_id: number;
  campaign_name: string;
  assigned_to_user_id?: number;
}): Promise<CampaignTarget> {
  return request<CampaignTarget>("/api/v1/campaign-targets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateCampaignTarget(
  targetId: number,
  payload: {
    status?: CampaignStatus;
    assigned_to_user_id?: number;
    result?: string;
    result_notes?: string;
  },
): Promise<CampaignTarget> {
  return request<CampaignTarget>(`/api/v1/campaign-targets/${targetId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
