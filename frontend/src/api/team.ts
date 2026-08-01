// 관리자용 활성 팀 계정 조회 API 클라이언트입니다.

import { request } from "./client";
import type { AuthUser } from "./auth";

export function listTeamMembers(): Promise<AuthUser[]> {
  return request<AuthUser[]>("/api/v1/auth/users");
}
