// 최신 모델 배치 상태 조회 API 클라이언트입니다.

import { request } from "./client";
import type { components } from "./schema";

export type LatestBatch = components["schemas"]["LatestBatchResponse"];

export function getLatestBatch(): Promise<LatestBatch> {
  return request<LatestBatch>("/api/v1/model-runs/latest");
}
