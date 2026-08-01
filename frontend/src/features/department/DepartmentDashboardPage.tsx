import { useEffect, useMemo, useState, type ReactNode } from "react";

import { listTeamMembers, updateTeamMember, type TeamMember } from "../../api/team";
import { logout, type AuthUser } from "../../api/auth";
import {
  createCampaignTarget,
  listCampaignTargets,
  updateCampaignTarget,
  type CampaignStatus,
  type CampaignTarget,
} from "../../api/campaigns";
import { listCustomerInsights, type CustomerInsight, type CustomerInsightList } from "../../api/insights";
import { getLatestBatch, type LatestBatch } from "../../api/modelRuns";

const roleLabels: Record<AuthUser["role"], string> = {
  admin: "관리자",
  analyst: "분석 담당자",
  operations: "운영 담당자",
  marketing: "마케팅 담당자",
};

const campaignStatusLabels: Record<CampaignStatus, string> = {
  pending: "대기",
  assigned: "담당 배정",
  contacted: "접촉 완료",
  completed: "처리 완료",
  cancelled: "취소",
};

const campaignStatusTransitions: Record<CampaignStatus, CampaignStatus[]> = {
  pending: ["pending", "assigned", "cancelled"],
  assigned: ["assigned", "contacted", "cancelled"],
  contacted: ["contacted", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

const roleDescriptions: Record<AuthUser["role"], string> = {
  admin: "팀 계정과 업무 권한을 관리합니다.",
  analyst: "고객 분석 결과와 모델 배치 상태를 확인합니다.",
  operations: "고위험 고객의 상담과 후속 처리를 관리합니다.",
  marketing: "고객 세그먼트와 캠페인 실행 결과를 관리합니다.",
};

type DepartmentDashboardPageProps = {
  user: AuthUser;
  onLoggedOut: () => void;
  onOpenCampaigns?: () => void;
};

type CampaignDraft = {
  status: CampaignStatus;
  result: string;
  assigned_to_user_id: number | null;
  converted: boolean;
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function WorkspaceShell({
  user,
  section,
  title,
  subtitle,
  onLogout,
  isLoggingOut,
  logoutError,
  onOpenCampaigns,
  children,
}: {
  user: AuthUser;
  section: string;
  title: string;
  subtitle: string;
  onLogout: () => void;
  isLoggingOut: boolean;
  logoutError: string;
  onOpenCampaigns?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="department-layout">
      <header className="department-header">
        <div>
          <p className="dashboard-eyebrow">CARDOPS CONSOLE / {section}</p>
          <h1>{title}</h1>
          <p className="dashboard-subtitle">{subtitle}</p>
        </div>
        <div className="department-account">
          <div>
            <strong>{user.display_name}</strong>
            <span>{roleLabels[user.role]}</span>
          </div>
          {onOpenCampaigns && (
            <button className="dashboard-nav-button" type="button" onClick={onOpenCampaigns}>
              캠페인 관리
            </button>
          )}
          <button
            className="dashboard-logout"
            type="button"
            onClick={onLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "처리 중..." : "로그아웃"}
          </button>
        </div>
      </header>
      {logoutError !== "" && <p className="dashboard-notice" role="alert">{logoutError}</p>}
      {children}
    </main>
  );
}

function StatCard({ label, value, caption, tone = "purple" }: {
  label: string;
  value: string;
  caption: string;
  tone?: "purple" | "orange" | "green" | "pink";
}) {
  return (
    <article className={`department-stat department-stat--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{caption}</small>
    </article>
  );
}

function BatchCard({ batch }: { batch: LatestBatch | null }) {
  return (
    <article className="department-panel department-panel--batch">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">DATA FRESHNESS</p>
          <h2>최근 분석 배치</h2>
        </div>
        <span className="batch-status">{batch === null ? "확인 중" : "SYNCED"}</span>
      </div>
      <strong className="department-batch-time">
        {formatDate(batch?.completed_at ?? batch?.started_at ?? null)}
      </strong>
      <p className="department-panel__caption">
        {batch?.processed_rows === null || batch === null
          ? "배치 실행 정보를 불러오는 중입니다."
          : `${formatNumber(batch.processed_rows)}명 분석 완료`}
      </p>
      <div className="department-batch-models">
        {batch?.runs.map((run) => (
          <span key={run.id}>{run.task} · {run.model_version}</span>
        ))}
      </div>
    </article>
  );
}

function InsightPriorityTable({
  insights,
  targets,
  campaignName,
  onCreate,
  isCreating,
}: {
  insights: CustomerInsight[];
  targets: CampaignTarget[];
  campaignName: string;
  onCreate?: (insight: CustomerInsight) => void;
  isCreating: number | null;
}) {
  const targetInsightIds = new Set(targets.map((target) => target.customer_insight_id));
  return (
    <section className="department-panel department-panel--wide">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">CUSTOMER PRIORITY</p>
          <h2>우선 관리 고객</h2>
        </div>
        <span className="table-count">{formatNumber(insights.length)}명</span>
      </div>
      {insights.length === 0 ? (
        <p className="department-empty">현재 조건에 맞는 고객이 없습니다.</p>
      ) : (
        <div className="department-insight-list">
          {insights.slice(0, 8).map((insight) => {
            const isRegistered = targetInsightIds.has(insight.id);
            return (
              <div className="department-insight-row" key={insight.id}>
                <div>
                  <strong>{insight.customer_id}</strong>
                  <small>{insight.recommended_action}</small>
                </div>
                <span className="department-risk">{formatPercent(insight.churn_probability)}</span>
                <span className={insight.activity_gap < 0 ? "department-gap department-gap--negative" : "department-gap"}>
                  {insight.activity_gap > 0 ? "+" : ""}{formatDecimal(insight.activity_gap)}
                </span>
                {onCreate ? (
                  <button
                    type="button"
                    className="department-action-button"
                    disabled={isRegistered || isCreating === insight.id}
                    onClick={() => onCreate(insight)}
                  >
                    {isRegistered ? "등록됨" : isCreating === insight.id ? "등록 중..." : campaignName}
                  </button>
                ) : (
                  <span className="department-campaign-result">타깃 등록은 마케팅팀이 담당합니다.</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CampaignQueue({
  targets,
  canManage,
  assignees,
  onUpdated,
}: {
  targets: CampaignTarget[];
  canManage: boolean;
  assignees: TeamMember[];
  onUpdated: (target: CampaignTarget) => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, CampaignDraft>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const save = async (target: CampaignTarget) => {
    const draft = drafts[target.id] ?? {
      status: target.status,
      result: target.result ?? "",
      assigned_to_user_id: target.assigned_to_user_id,
      converted: target.converted,
    };
    setSavingId(target.id);
    setError("");
    try {
      const updated = await updateCampaignTarget(target.id, {
        status: draft.status,
        assigned_to_user_id: draft.assigned_to_user_id ?? undefined,
        result: draft.result || undefined,
        converted: draft.converted,
      });
      onUpdated(updated);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "처리 결과 저장에 실패했습니다.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="department-panel department-panel--wide">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">WORK QUEUE</p>
          <h2>캠페인 처리 현황</h2>
        </div>
        <span className="table-count">{formatNumber(targets.length)}건</span>
      </div>
      {error !== "" && <p className="department-inline-error" role="alert">{error}</p>}
      {targets.length === 0 ? (
        <p className="department-empty">등록된 캠페인 대상이 없습니다.</p>
      ) : (
        <div className="department-campaign-list">
          {targets.slice(0, 12).map((target) => {
            const draft = drafts[target.id] ?? {
              status: target.status,
              result: target.result ?? "",
              assigned_to_user_id: target.assigned_to_user_id,
              converted: target.converted,
            };
            return (
              <div className="department-campaign-row" key={target.id}>
                <div>
                  <strong>{target.customer_id}</strong>
                  <small>{target.campaign_name} · {target.assigned_to_display_name ?? "미배정"}</small>
                </div>
                <span className={`campaign-status campaign-status--${target.status}`}>
                  {campaignStatusLabels[target.status]}
                </span>
                {canManage ? (
                  <div className="department-campaign-controls">
                    <select
                      aria-label={`${target.customer_id} 처리 상태`}
                      value={draft.status}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [target.id]: { ...draft, status: event.target.value as CampaignStatus },
                      }))}
                    >
                      {campaignStatusTransitions[target.status].map((value) => (
                        <option value={value} key={value}>
                          {campaignStatusLabels[value]}
                        </option>
                      ))}
                    </select>
                    <label className="campaign-conversion">
                      <input
                        type="checkbox"
                        checked={draft.converted}
                        disabled={draft.status !== "completed"}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [target.id]: { ...draft, converted: event.target.checked },
                        }))}
                      />
                      전환
                    </label>
                    <select
                      aria-label={`${target.customer_id} 담당자`}
                      value={draft.assigned_to_user_id === null ? "" : String(draft.assigned_to_user_id)}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [target.id]: {
                          ...draft,
                          assigned_to_user_id: event.target.value === "" ? null : Number(event.target.value),
                        },
                      }))}
                    >
                      <option value="">담당자 선택</option>
                      {assignees.map((assignee) => (
                        <option value={assignee.id} key={assignee.id}>
                          {assignee.display_name} · {roleLabels[assignee.role]}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`${target.customer_id} 처리 결과`}
                      value={draft.result}
                      placeholder="처리 결과"
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [target.id]: { ...draft, result: event.target.value },
                      }))}
                    />
                    <button type="button" disabled={savingId === target.id} onClick={() => void save(target)}>
                      {savingId === target.id ? "저장 중..." : "저장"}
                    </button>
                  </div>
                ) : (
                  <span className="department-campaign-result">{target.result ?? "결과 대기"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RoleSummary({ user }: { user: AuthUser }) {
  return (
    <aside className="department-panel department-panel--role">
      <p className="card-kicker">YOUR WORKSPACE</p>
      <h2>{roleLabels[user.role]}</h2>
      <p>{roleDescriptions[user.role]}</p>
      <div className="department-role-pill">{user.username}</div>
    </aside>
  );
}

function TeamRoster({
  members,
  onUpdated,
}: {
  members: TeamMember[];
  onUpdated: (member: TeamMember) => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, { role: TeamMember["role"]; is_active: boolean }>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const save = async (member: TeamMember) => {
    const draft = drafts[member.id] ?? { role: member.role, is_active: member.is_active };
    setSavingId(member.id);
    setError("");
    try {
      const updated = await updateTeamMember(member.id, draft);
      onUpdated(updated);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "팀 계정 변경에 실패했습니다.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="department-panel department-panel--wide">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">TEAM ACCESS</p>
          <h2>활성 팀 계정</h2>
        </div>
        <span className="table-count">{formatNumber(members.length)}명</span>
      </div>
      {error !== "" && <p className="department-inline-error" role="alert">{error}</p>}
      <div className="department-team-list">
        {members.map((member) => {
          const draft = drafts[member.id] ?? { role: member.role, is_active: member.is_active };
          return (
            <div className="department-team-row" key={member.id}>
              <div>
                <strong>{member.display_name}</strong>
                <small>{member.username} · {member.is_active ? "활성" : "비활성"}</small>
              </div>
              <select
                aria-label={`${member.display_name} 역할`}
                value={draft.role}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [member.id]: { ...draft, role: event.target.value as TeamMember["role"] },
                }))}
              >
                <option value="admin">관리자</option>
                <option value="analyst">분석 담당자</option>
                <option value="operations">운영 담당자</option>
                <option value="marketing">마케팅 담당자</option>
              </select>
              <select
                aria-label={`${member.display_name} 계정 상태`}
                value={draft.is_active ? "active" : "inactive"}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [member.id]: { ...draft, is_active: event.target.value === "active" },
                }))}
              >
                <option value="active">활성</option>
                <option value="inactive">비활성</option>
              </select>
              <button type="button" disabled={savingId === member.id} onClick={() => void save(member)}>
                {savingId === member.id ? "저장 중..." : "저장"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DepartmentDashboardPage({ user, onLoggedOut, onOpenCampaigns }: DepartmentDashboardPageProps) {
  const [insights, setInsights] = useState<CustomerInsightList | null>(null);
  const [targets, setTargets] = useState<CampaignTarget[]>([]);
  const [batch, setBatch] = useState<LatestBatch | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState<number | null>(null);
  const [createMessage, setCreateMessage] = useState("");
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const canProcessTargets = user.role === "admin" || user.role === "operations";
  const canCreateCampaignTargets = user.role === "admin" || user.role === "marketing";
  const insightQuery = useMemo(() => user.role === "operations"
    ? { risk_level: "high" as const, sort_by: "churn_probability" as const, sort_order: "desc" as const, page: 1, page_size: 100 }
    : { sort_by: "churn_probability" as const, sort_order: "desc" as const, page: 1, page_size: 100 }, [user.role]);

  useEffect(() => {
    let isActive = true;
    const load = async () => {
      const [insightResult, campaignResult, batchResult] = await Promise.allSettled([
        listCustomerInsights(insightQuery),
        listCampaignTargets({ page: 1, page_size: 100 }),
        getLatestBatch(),
      ]);
      if (!isActive) {
        return;
      }
      if (insightResult.status === "fulfilled") {
        setInsights(insightResult.value);
      } else {
        setError(insightResult.reason instanceof Error ? insightResult.reason.message : "분석 결과를 불러오지 못했습니다.");
      }
      if (campaignResult.status === "fulfilled") {
        setTargets(campaignResult.value.items);
      }
      if (batchResult.status === "fulfilled") {
        setBatch(batchResult.value);
      }
      setIsLoading(false);
    };
    void load();
    return () => {
      isActive = false;
    };
  }, [insightQuery]);

  useEffect(() => {
    let isActive = true;
    void listTeamMembers(user.role === "admin")
      .then((response) => {
        if (isActive) {
          setMembers(response);
        }
      })
      .catch(() => {
        if (isActive) {
          setMembers([]);
        }
      });
    return () => {
      isActive = false;
    };
  }, [user.role]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      onLoggedOut();
    } catch (requestError) {
      setLogoutError(requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.");
    } finally {
      setIsLoggingOut(false);
    }
  };

  const createCampaign = async (insight: CustomerInsight) => {
    if (!canCreateCampaignTargets) {
      return;
    }
    setIsCreating(insight.id);
    setCreateMessage("");
    try {
      const target = await createCampaignTarget({
        customer_insight_id: insight.id,
        campaign_name: user.role === "marketing" ? "세그먼트 리텐션 캠페인" : "고위험 고객 리텐션",
        assigned_to_user_id: user.id,
      });
      setTargets((current) => [target, ...current]);
      setCreateMessage("캠페인 대상에 등록하고 현재 담당자에게 배정했습니다.");
    } catch (requestError) {
      setCreateMessage(requestError instanceof Error ? requestError.message : "캠페인 등록에 실패했습니다.");
    } finally {
      setIsCreating(null);
    }
  };

  const highRiskCount = insights?.stats.risk_counts.high ?? 0;
  const pendingCount = targets.filter((target) => ["pending", "assigned"].includes(target.status)).length;
  const completedCount = targets.filter((target) => target.status === "completed").length;
  const campaignStatusCounts = useMemo(() => Object.fromEntries(
    Object.keys(campaignStatusLabels).map((status) => [
      status,
      targets.filter((target) => target.status === status).length,
    ]),
  ) as Record<CampaignStatus, number>, [targets]);

  const roleContent = user.role === "operations" ? (
    <>
      <section className="department-stats">
        <StatCard label="HIGH RISK" value={formatNumber(highRiskCount)} caption="우선 상담 대상" tone="pink" />
        <StatCard label="OPEN QUEUE" value={formatNumber(pendingCount)} caption="처리 대기 캠페인" tone="orange" />
        <StatCard label="AVERAGE CHURN" value={formatPercent(insights?.stats.average_churn_probability ?? 0)} caption="고위험 고객 기준" tone="purple" />
        <BatchCard batch={batch} />
      </section>
      <InsightPriorityTable insights={insights?.items ?? []} targets={targets} campaignName="리텐션 등록" onCreate={canCreateCampaignTargets ? (item) => void createCampaign(item) : undefined} isCreating={isCreating} />
      <CampaignQueue targets={targets} canManage={canProcessTargets} assignees={members} onUpdated={(updated) => setTargets((current) => current.map((target) => target.id === updated.id ? updated : target))} />
    </>
  ) : user.role === "marketing" ? (
    <>
      <section className="department-stats">
        <StatCard label="TARGETS" value={formatNumber(targets.length)} caption="등록된 캠페인 대상" tone="purple" />
        <StatCard label="OPEN QUEUE" value={formatNumber(pendingCount)} caption="실행 대기 대상" tone="orange" />
        <StatCard label="COMPLETED" value={formatNumber(completedCount)} caption="처리 완료 캠페인" tone="green" />
        <BatchCard batch={batch} />
      </section>
      <section className="department-panel department-panel--wide">
        <div className="department-panel__heading">
          <div>
            <p className="card-kicker">CAMPAIGN FUNNEL</p>
            <h2>캠페인 상태 분포</h2>
          </div>
        </div>
        <div className="department-funnel">
          {Object.entries(campaignStatusLabels).map(([status, label]) => (
            <div key={status}>
              <span>{label}</span>
              <strong>{campaignStatusCounts[status as CampaignStatus]}</strong>
              <i style={{ width: `${Math.max((campaignStatusCounts[status as CampaignStatus] / Math.max(targets.length, 1)) * 100, campaignStatusCounts[status as CampaignStatus] > 0 ? 8 : 0)}%` }} />
            </div>
          ))}
        </div>
      </section>
      <InsightPriorityTable insights={insights?.items ?? []} targets={targets} campaignName="캠페인 등록" onCreate={canCreateCampaignTargets ? (item) => void createCampaign(item) : undefined} isCreating={isCreating} />
      <CampaignQueue targets={targets} canManage={canProcessTargets} assignees={members} onUpdated={(updated) => setTargets((current) => current.map((target) => target.id === updated.id ? updated : target))} />
    </>
  ) : (
    <>
      <section className="department-stats">
        <StatCard label="CUSTOMERS" value={formatNumber(insights?.stats.total ?? 0)} caption="분석 대상 고객" tone="purple" />
        <StatCard label="CAMPAIGN QUEUE" value={formatNumber(targets.length)} caption="전체 업무 대상" tone="orange" />
        <StatCard label="HIGH RISK" value={formatNumber(highRiskCount)} caption="고위험 고객" tone="pink" />
        <BatchCard batch={batch} />
      </section>
      <section className="department-panel department-panel--wide">
        <div className="department-panel__heading">
          <div>
            <p className="card-kicker">ACCESS CONTROL</p>
            <h2>역할별 업무 권한</h2>
          </div>
        </div>
        <div className="department-permission-grid">
          {(Object.keys(roleLabels) as AuthUser["role"][]).map((role) => (
            <div key={role} className={role === user.role ? "department-permission department-permission--active" : "department-permission"}>
              <strong>{roleLabels[role]}</strong>
              <span>{roleDescriptions[role]}</span>
            </div>
          ))}
        </div>
      </section>
      <TeamRoster members={members} onUpdated={(updated) => setMembers((current) => current.map((member) => member.id === updated.id ? updated : member))} />
    </>
  );

  return (
    <WorkspaceShell
      user={user}
      section={roleLabels[user.role].toUpperCase()}
      title={user.role === "operations" ? "운영 업무 센터" : user.role === "marketing" ? "마케팅 캠페인 센터" : "관리자 콘솔"}
      subtitle={roleDescriptions[user.role]}
      onLogout={() => void handleLogout()}
      isLoggingOut={isLoggingOut}
      logoutError={logoutError}
      onOpenCampaigns={onOpenCampaigns}
    >
      {isLoading && <section className="department-loading">부서별 업무 데이터를 불러오는 중입니다.</section>}
      {!isLoading && error !== "" && <section className="department-error" role="alert">{error}</section>}
      {!isLoading && error === "" && (
        <div className="department-content">
          <RoleSummary user={user} />
          {createMessage !== "" && <p className="department-message" role="status">{createMessage}</p>}
          {roleContent}
        </div>
      )}
    </WorkspaceShell>
  );
}
