import { useEffect, useState } from "react";

import { logout, type AuthUser } from "../../api/auth";
import {
  createCampaignTarget,
  listCampaignTargets,
  updateCampaignTarget,
  type CampaignStatus,
  type CampaignTarget,
} from "../../api/campaigns";
import {
  getCustomerInsight,
  getCustomerInsightHistory,
  listCustomerInsights,
  type CustomerInsight,
  type CustomerInsightDetail,
  type CustomerInsightHistory,
  type CustomerInsightList,
  type InsightQuery,
} from "../../api/insights";
import { getLatestBatch, type LatestBatch } from "../../api/modelRuns";

const PAGE_SIZE = 8;

const roleLabels: Record<AuthUser["role"], string> = {
  admin: "관리자",
  analyst: "분석 담당자",
  operations: "운영 담당자",
  marketing: "마케팅 담당자",
};

const riskLabels: Record<CustomerInsight["risk_level"], string> = {
  low: "낮음",
  medium: "주의",
  high: "높음",
};

const riskColors: Record<CustomerInsight["risk_level"], string> = {
  low: "#50b88b",
  medium: "#e8a34f",
  high: "#e66c78",
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

type RiskFilter = "" | NonNullable<InsightQuery["risk_level"]>;
type SortBy = NonNullable<InsightQuery["sort_by"]>;
type SortOrder = NonNullable<InsightQuery["sort_order"]>;

type DashboardPageProps = {
  user: AuthUser;
  onLoggedOut: () => void;
  onOpenCampaigns?: () => void;
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSignedDecimal(value: number): string {
  return `${value > 0 ? "+" : ""}${formatDecimal(value)}`;
}

function escapeCsv(value: unknown): string {
  const normalized = String(value ?? "").replaceAll('"', '""');
  return `"${normalized}"`;
}

function getCustomerIdFilter(value: string): number | undefined {
  const normalized = value.trim();
  if (normalized === "") {
    return undefined;
  }

  const customerId = Number(normalized);
  return Number.isInteger(customerId) && customerId > 0
    ? customerId
    : undefined;
}

function getDominantCluster(clusterCounts: Record<string, number>): [string, number] | null {
  const [cluster] = Object.entries(clusterCounts).sort(
    ([, countA], [, countB]) => countB - countA,
  );
  return cluster ?? null;
}

function RiskBadge({ risk }: { risk: CustomerInsight["risk_level"] }) {
  return (
    <span className={`risk-badge risk-badge--${risk}`}>
      <span aria-hidden="true" />
      {riskLabels[risk]}
    </span>
  );
}

function DashboardSkeleton() {
  return (
    <section className="bento-grid" aria-label="고객 분석 대시보드 로딩 중">
      <div className="bento-card dashboard-skeleton dashboard-skeleton--hero" />
      <div className="bento-card dashboard-skeleton" />
      <div className="bento-card dashboard-skeleton" />
      <div className="bento-card dashboard-skeleton dashboard-skeleton--table" />
    </section>
  );
}

function RiskOverview({ data }: { data: CustomerInsightList }) {
  const riskEntries = (["high", "medium", "low"] as const).map((risk) => ({
    risk,
    count: data.stats.risk_counts[risk] ?? 0,
  }));
  const maxCount = Math.max(...riskEntries.map(({ count }) => count), 1);

  return (
    <article className="bento-card bento-card--risk">
      <div className="bento-card__heading">
        <div>
          <p className="card-kicker">RISK MONITOR</p>
          <h2>위험도 분포</h2>
        </div>
        <span className="card-icon card-icon--alert" aria-hidden="true">!</span>
      </div>
      <div className="risk-bars">
        {riskEntries.map(({ risk, count }) => (
          <div className="risk-bar" key={risk}>
            <div className="risk-bar__label">
              <span>
                <i
                  className="risk-dot"
                  style={{ backgroundColor: riskColors[risk] }}
                />
                {riskLabels[risk]}
              </span>
              <strong>
                {formatNumber(count)} · {formatPercent(data.stats.total > 0 ? count / data.stats.total : 0)}
              </strong>
            </div>
            <div className="risk-bar__track">
              <span
                style={{
                  width: `${Math.max((count / maxCount) * 100, count > 0 ? 5 : 0)}%`,
                  backgroundColor: riskColors[risk],
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function InsightRow({
  insight,
  onSelect,
}: {
  insight: CustomerInsight;
  onSelect: (customerId: number) => void;
}) {
  return (
    <button
      className="insight-row"
      type="button"
      onClick={() => onSelect(insight.customer_id)}
    >
      <span className="insight-row__customer">
        <strong>{insight.customer_id}</strong>
        <small>{formatDate(insight.scored_at)}</small>
      </span>
      <span>
        <RiskBadge risk={insight.risk_level} />
      </span>
      <span className="insight-row__metric">
        <strong>{formatPercent(insight.churn_probability)}</strong>
        <small>이탈 확률</small>
      </span>
      <span className={`insight-row__gap ${insight.activity_gap < 0 ? "insight-row__gap--negative" : ""}`}>
        {formatSignedDecimal(insight.activity_gap)}
        <small>활동성 갭</small>
      </span>
      <span className="insight-row__expected">
        {formatDecimal(insight.expected_transaction_count)}건
        <small>예상 거래</small>
      </span>
      <span className="insight-row__cluster">
        {insight.cluster_name}
        <small>
          신뢰도 {insight.cluster_confidence == null ? "-" : formatPercent(insight.cluster_confidence)}
        </small>
      </span>
      <span className="insight-row__action">{insight.recommended_action}</span>
      <span className="insight-row__arrow" aria-hidden="true">↗</span>
    </button>
  );
}

function BatchOverview({ batch }: { batch: LatestBatch | null }) {
  return (
    <article className="bento-card bento-card--batch">
      <div className="bento-card__heading">
        <div>
          <p className="card-kicker">DATA FRESHNESS</p>
          <h2>최근 배치 상태</h2>
        </div>
        <span className="batch-status">{batch === null ? "확인 중" : "SYNCED"}</span>
      </div>
      {batch === null ? (
        <p className="empty-copy">배치 실행 정보를 불러오는 중입니다.</p>
      ) : (
        <>
          <strong className="batch-time">
            {formatDate(batch.completed_at ?? batch.started_at)}
          </strong>
          <p className="batch-caption">
            {batch.processed_rows === null
              ? "처리 행 수 미상"
              : `${formatNumber(batch.processed_rows)}명 분석 완료`}
          </p>
          <div className="batch-models">
            {batch.runs.map((run) => (
              <span key={run.id}>{run.task} · {run.model_version}</span>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

type CampaignDraft = {
  status: CampaignStatus;
  result: string;
  result_notes: string;
  converted: boolean;
};

function CampaignQueue({
  targets,
  drafts,
  canManage,
  user,
  isLoading,
  onDraftChange,
  onSave,
}: {
  targets: CampaignTarget[];
  drafts: Record<number, CampaignDraft>;
  canManage: boolean;
  user: AuthUser;
  isLoading: boolean;
  onDraftChange: (targetId: number, draft: CampaignDraft) => void;
  onSave: (targetId: number) => void;
}) {
  return (
    <article className="bento-card bento-card--campaign">
      <div className="table-card__header">
        <div>
          <p className="card-kicker">WORK QUEUE</p>
          <h2>캠페인 처리 현황</h2>
        </div>
        <span className="table-count">{formatNumber(targets.length)}건</span>
      </div>
      {isLoading ? (
        <p className="queue-state">처리 현황을 불러오는 중입니다.</p>
      ) : targets.length === 0 ? (
        <p className="queue-state">등록된 캠페인 대상이 없습니다.</p>
      ) : (
        <div className="campaign-list">
          {targets.map((target) => {
            const draft = drafts[target.id] ?? {
              status: target.status,
              result: target.result ?? "",
              result_notes: target.result_notes ?? "",
              converted: target.converted,
            };
            const canEditTarget = canManage
              && target.experiment_group === "treatment"
              && target.campaign_status === "active"
              && (user.role === "admin" || target.assigned_to_user_id === user.id);
            const availableStatuses = campaignStatusTransitions[target.status].filter(
              (value) => value !== "assigned" || target.assigned_to_user_id !== null,
            );
            return (
              <div className="campaign-row" key={target.id}>
                <div className="campaign-row__customer">
                  <strong>{target.customer_id}</strong>
                  <span>{target.campaign_name}</span>
                </div>
                <span className={`campaign-status campaign-status--${target.status}`}>
                  {campaignStatusLabels[target.status]}
                </span>
                <span className="campaign-assignee">
                  {target.assigned_to_display_name ?? "미배정"}
                </span>
                {canEditTarget ? (
                  <div className="campaign-row__controls">
                    <select
                      value={draft.status}
                      aria-label={`${target.customer_id} 처리 상태`}
                      onChange={(event) =>
                        onDraftChange(target.id, {
                          ...draft,
                          status: event.target.value as CampaignStatus,
                        })
                      }
                    >
                      {availableStatuses.map((value) => (
                        <option value={value} key={value}>
                          {campaignStatusLabels[value]}
                        </option>
                      ))}
                    </select>
                    <input
                      value={draft.result}
                      placeholder="처리 결과"
                      aria-label={`${target.customer_id} 처리 결과`}
                      onChange={(event) =>
                        onDraftChange(target.id, { ...draft, result: event.target.value })
                      }
                    />
                    <label className="campaign-conversion">
                      <input
                        type="checkbox"
                        checked={draft.converted}
                        disabled={draft.status !== "completed"}
                        onChange={(event) =>
                          onDraftChange(target.id, {
                            ...draft,
                            converted: event.target.checked,
                          })
                        }
                      />
                      전환
                    </label>
                    <button type="button" onClick={() => onSave(target.id)}>저장</button>
                  </div>
                ) : (
                  <span className="campaign-result">{target.result ?? "-"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function CustomerDetailPanel({
  detail,
  history,
  historyLoading,
  campaigns,
  canManageCampaigns,
  campaignName,
  campaignSubmitting,
  campaignMessage,
  onCampaignNameChange,
  onCreateCampaign,
  isLoading,
  error,
  onClose,
}: {
  detail: CustomerInsightDetail | null;
  history: CustomerInsightHistory | null;
  historyLoading: boolean;
  campaigns: CampaignTarget[];
  canManageCampaigns: boolean;
  campaignName: string;
  campaignSubmitting: boolean;
  campaignMessage: string;
  onCampaignNameChange: (value: string) => void;
  onCreateCampaign: () => void;
  isLoading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <aside className="insight-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <div className="insight-drawer__header">
        <div>
          <p className="card-kicker">CUSTOMER PROFILE</p>
          <h2 id="detail-title">
            {detail === null ? "고객 상세 정보" : `고객 ${detail.customer_id}`}
          </h2>
        </div>
        <button className="drawer-close" type="button" aria-label="고객 상세 닫기" onClick={onClose}>
          ×
        </button>
      </div>

      {isLoading && <p className="drawer-state">상세 정보를 불러오는 중입니다.</p>}
      {!isLoading && error !== "" && <p className="drawer-state drawer-state--error">{error}</p>}
      {!isLoading && error === "" && detail !== null && (
        <div className="drawer-content">
          <div className="drawer-risk-summary">
            <RiskBadge risk={detail.risk_level} />
            <strong>{formatPercent(detail.churn_probability)}</strong>
            <span>예상 이탈 확률</span>
          </div>
          <p className="drawer-recommendation">{detail.recommended_action}</p>

          <dl className="customer-facts">
            <div><dt>고객 연령</dt><dd>{detail.customer.customer_age}세</dd></div>
            <div><dt>카드 등급</dt><dd>{detail.customer.card_category}</dd></div>
            <div><dt>소득 구간</dt><dd>{detail.customer.income_category}</dd></div>
            <div><dt>최근 거래 건수</dt><dd>{formatNumber(detail.customer.total_trans_ct)}건</dd></div>
            <div><dt>거래 금액</dt><dd>{formatNumber(detail.customer.total_trans_amt)}</dd></div>
            <div><dt>비활성 개월</dt><dd>{detail.customer.months_inactive_12_mon}개월</dd></div>
            <div><dt>예상 거래 건수</dt><dd>{formatDecimal(detail.expected_transaction_count)}건</dd></div>
            <div><dt>활동성 갭</dt><dd>{formatDecimal(detail.activity_gap)}</dd></div>
            <div><dt>고객 군집</dt><dd>{detail.cluster_name}</dd></div>
            <div><dt>군집 신뢰도</dt><dd>{detail.cluster_confidence == null ? "-" : formatPercent(detail.cluster_confidence)}</dd></div>
          </dl>

          <div className="drawer-history">
            <div className="drawer-section-heading">
              <h3>분석 이력</h3>
              <span>{history?.items.length ?? 0}회</span>
            </div>
            {historyLoading ? (
              <p className="drawer-inline-state">분석 이력을 불러오는 중입니다.</p>
            ) : history === null ? (
              <p className="drawer-inline-state">분석 이력이 없습니다.</p>
            ) : (
              <div className="history-list">
                {history.items.slice(0, 6).map((item) => (
                  <div className="history-item" key={item.id}>
                    <span>{formatDate(item.scored_at)}</span>
                    <strong>{formatPercent(item.churn_probability)}</strong>
                    <em className={item.activity_gap < 0 ? "history-gap--negative" : ""}>
                      {formatSignedDecimal(item.activity_gap)}
                    </em>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="drawer-reasons">
            <h3>추천 근거</h3>
            <div className="reason-list">
              {detail.reason_codes !== null && typeof detail.reason_codes === "object"
                ? Object.entries(detail.reason_codes).map(([key, value]) => (
                    <span key={key}>{key}: {String(value)}</span>
                  ))
                : <span>분석 근거가 등록되지 않았습니다.</span>}
            </div>
          </div>

          <div className="drawer-campaigns">
            <div className="drawer-section-heading">
              <h3>캠페인 업무</h3>
              <span>{campaigns.length}건</span>
            </div>
            {campaigns.map((campaign) => (
              <div className="drawer-campaign-row" key={campaign.id}>
                <span>{campaign.campaign_name}</span>
                <strong>{campaignStatusLabels[campaign.status]}</strong>
              </div>
            ))}
            {canManageCampaigns && (
              <div className="campaign-create-form">
                <input
                  value={campaignName}
                  aria-label="캠페인 이름"
                  placeholder="캠페인 이름"
                  onChange={(event) => onCampaignNameChange(event.target.value)}
                />
                <button
                  type="button"
                  disabled={campaignSubmitting || campaignName.trim() === ""}
                  onClick={onCreateCampaign}
                >
                  {campaignSubmitting ? "등록 중..." : "대상 등록"}
                </button>
              </div>
            )}
            {!canManageCampaigns && <p className="drawer-inline-state">캠페인 등록 권한이 없습니다.</p>}
            {campaignMessage !== "" && <p className="campaign-message" role="status">{campaignMessage}</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

export function DashboardPage({ user, onLoggedOut, onOpenCampaigns }: DashboardPageProps) {
  const [data, setData] = useState<CustomerInsightList | null>(null);
  const [error, setError] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("");
  const [clusterFilter, setClusterFilter] = useState("");
  const [customerIdFilter, setCustomerIdFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("churn_probability");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<CustomerInsightDetail | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<CustomerInsightHistory | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [batch, setBatch] = useState<LatestBatch | null>(null);
  const [campaignTargets, setCampaignTargets] = useState<CampaignTarget[]>([]);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<number, CampaignDraft>>({});
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState("");
  const [campaignName, setCampaignName] = useState("이탈 위험 리텐션");
  const [campaignSubmitting, setCampaignSubmitting] = useState(false);
  const [campaignMessage, setCampaignMessage] = useState("");
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const canCreateCampaignTargets = user.role === "admin" || user.role === "marketing";
  const canProcessCampaignTargets = user.role === "admin" || user.role === "operations";

  useEffect(() => {
    let isActive = true;
    const query: InsightQuery = {
      risk_level: riskFilter || undefined,
      cluster_name: clusterFilter.trim() || undefined,
      customer_id: getCustomerIdFilter(customerIdFilter),
      sort_by: sortBy,
      sort_order: sortOrder,
      page,
      page_size: PAGE_SIZE,
    };

    const loadInsights = async () => {
      try {
        const response = await listCustomerInsights(query);
        if (isActive) {
          setData(response);
          setError("");
        }
      } catch (requestError) {
        if (isActive) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "고객 분석 결과를 불러오지 못했습니다.",
          );
        }
      }
    };

    void loadInsights();
    return () => {
      isActive = false;
    };
  }, [clusterFilter, customerIdFilter, page, riskFilter, sortBy, sortOrder]);

  useEffect(() => {
    let isActive = true;
    const loadBatch = async () => {
      try {
        const response = await getLatestBatch();
        if (isActive) {
          setBatch(response);
        }
      } catch {
        if (isActive) {
          setBatch(null);
        }
      }
    };
    void loadBatch();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const loadCampaigns = async () => {
      try {
        const response = await listCampaignTargets({ page: 1, page_size: 20 });
        if (isActive) {
          setCampaignTargets(response.items);
          setCampaignError("");
          setCampaignLoading(false);
        }
      } catch (requestError) {
        if (isActive) {
          setCampaignLoading(false);
          setCampaignError(
            requestError instanceof Error
              ? requestError.message
              : "캠페인 처리 현황을 불러오지 못했습니다.",
          );
        }
      }
    };
    void loadCampaigns();
    return () => {
      isActive = false;
    };
  }, []);

  const handleSelectCustomer = async (customerId: number) => {
    setSelectedCustomerId(customerId);
    setSelectedDetail(null);
    setSelectedHistory(null);
    setDetailError("");
    setDetailLoading(true);
    setHistoryLoading(true);
    setCampaignMessage("");
    setCampaignName("이탈 위험 리텐션");
    try {
      const [detail, history] = await Promise.all([
        getCustomerInsight(customerId),
        getCustomerInsightHistory(customerId),
      ]);
      setSelectedDetail(detail);
      setSelectedHistory(history);
    } catch (requestError) {
      setDetailError(
        requestError instanceof Error
          ? requestError.message
          : "고객 상세 정보를 불러오지 못했습니다.",
      );
    } finally {
      setDetailLoading(false);
      setHistoryLoading(false);
    }
  };

  const handleCreateCampaign = async () => {
    if (selectedDetail === null || campaignName.trim() === "") {
      return;
    }
    setCampaignSubmitting(true);
    setCampaignMessage("");
    try {
      const target = await createCampaignTarget({
        customer_insight_id: selectedDetail.id,
        campaign_name: campaignName.trim(),
      });
      setCampaignTargets((current) => [target, ...current]);
      setCampaignMessage("캠페인 대상에 등록했습니다.");
      setCampaignName("이탈 위험 리텐션");
    } catch (requestError) {
      setCampaignMessage(
        requestError instanceof Error ? requestError.message : "캠페인 등록에 실패했습니다.",
      );
    } finally {
      setCampaignSubmitting(false);
    }
  };

  const handleCampaignDraftChange = (targetId: number, draft: CampaignDraft) => {
    setCampaignDrafts((current) => ({ ...current, [targetId]: draft }));
  };

  const handleSaveCampaign = async (targetId: number) => {
    const target = campaignTargets.find((item) => item.id === targetId);
    if (target === undefined) {
      return;
    }
    const draft = campaignDrafts[targetId] ?? {
      status: target.status,
      result: target.result ?? "",
      result_notes: target.result_notes ?? "",
      converted: target.converted,
    };
    try {
      const updated = await updateCampaignTarget(targetId, {
        status: draft.status,
        result: draft.result || undefined,
        result_notes: draft.result_notes || undefined,
        result_code: draft.status === "completed"
          ? (draft.converted ? "converted" : "not_converted")
          : draft.status === "contacted" ? "contacted" : undefined,
        converted: draft.converted,
      });
      setCampaignTargets((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setCampaignMessage("캠페인 처리 결과를 저장했습니다.");
    } catch (requestError) {
      setCampaignError(
        requestError instanceof Error ? requestError.message : "캠페인 처리 결과 저장에 실패했습니다.",
      );
    }
  };

  const downloadCsv = () => {
    if (data === null) {
      return;
    }
    const header = ["customer_id", "risk_level", "churn_probability", "expected_transaction_count", "activity_gap", "cluster_name", "cluster_confidence", "recommended_action", "scored_at"];
    const rows = data.items.map((item) => [
      item.customer_id,
      item.risk_level,
      item.churn_probability,
      item.expected_transaction_count,
      item.activity_gap,
      item.cluster_name,
      item.cluster_confidence ?? "",
      item.recommended_action,
      item.scored_at,
    ]);
    const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "customer-insights.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const focusHighRisk = () => {
    setRiskFilter("high");
    setPage(1);
  };

  const resetFilters = () => {
    setRiskFilter("");
    setClusterFilter("");
    setCustomerIdFilter("");
    setSortBy("churn_probability");
    setSortOrder("desc");
    setPage(1);
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      onLoggedOut();
    } catch (requestError) {
      setLogoutError(
        requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.",
      );
    } finally {
      setIsLoggingOut(false);
    }
  };

  const isInitialLoading = data === null && error === "";
  const dominantCluster = data === null ? null : getDominantCluster(data.stats.cluster_counts);
  const highRiskCount = data?.stats.risk_counts.high ?? 0;

  return (
    <main className="dashboard-layout">
      <header className="dashboard-header">
        <div className="dashboard-brand-block">
          <p className="dashboard-eyebrow">CARDOPS CONSOLE / INSIGHTS</p>
          <h1>고객 분석 대시보드</h1>
          <p className="dashboard-subtitle">고객 행동 데이터를 기반으로 이탈 위험과 실행 우선순위를 확인합니다.</p>
        </div>
        <div className="dashboard-account">
          <div>
            <strong>{user.display_name}</strong>
            <span>{roleLabels[user.role]}</span>
          </div>
          {onOpenCampaigns && (
            <button className="dashboard-nav-button" type="button" onClick={onOpenCampaigns}>
              캠페인 조회
            </button>
          )}
          <button
            className="dashboard-logout"
            type="button"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "처리 중..." : "로그아웃"}
          </button>
        </div>
      </header>

      {isInitialLoading && <DashboardSkeleton />}

      {error !== "" && (
        <section className="dashboard-error" role="alert">
          <strong>분석 결과를 불러오지 못했습니다.</strong>
          <span>{error}</span>
          <button type="button" onClick={() => window.location.reload()}>새로고침</button>
        </section>
      )}

      {data !== null && error === "" && (
        <section className="bento-grid" aria-label="고객 분석 대시보드">
          <article className="bento-card bento-card--hero">
            <div className="bento-card__heading">
              <div>
                <p className="card-kicker">CUSTOMER HEALTH</p>
                <h2>분석 대상 고객</h2>
              </div>
              <span className="card-icon card-icon--spark" aria-hidden="true">✦</span>
            </div>
            <strong className="hero-number">{formatNumber(data.stats.total)}</strong>
            <p className="hero-caption">현재 필터 조건에 해당하는 최신 분석 스냅샷</p>
            <div className="hero-meta">
              <span><i className="status-pulse" /> 데이터 연결됨</span>
              <span>페이지 {data.page} / {data.total_pages}</span>
            </div>
          </article>

          <article className="bento-card bento-card--average">
            <p className="card-kicker">CHURN PROBABILITY</p>
            <span className="metric-label">평균 이탈 확률</span>
            <strong className="metric-number">{formatPercent(data.stats.average_churn_probability)}</strong>
            <div className="metric-footnote"><span className="metric-trend">●</span> 최신 분석 기준</div>
          </article>

          <button
            className="bento-card bento-card--priority"
            type="button"
            onClick={focusHighRisk}
            aria-label="높은 이탈 위험 고객만 보기"
          >
            <div className="priority-visual"><span>{formatNumber(highRiskCount)}</span><small>HIGH</small></div>
            <div>
              <p className="card-kicker">ACTION PRIORITY</p>
              <h2>우선 관리 고객</h2>
              <p>높은 이탈 위험으로 분류된 고객입니다. 클릭해서 바로 확인하세요.</p>
            </div>
          </button>

          <RiskOverview data={data} />

          <article className="bento-card bento-card--cluster">
            <div className="bento-card__heading">
              <div>
                <p className="card-kicker">SEGMENTATION</p>
                <h2>주요 고객 군집</h2>
              </div>
              <span className="card-icon card-icon--cluster" aria-hidden="true">◌</span>
            </div>
            {dominantCluster === null ? (
              <p className="empty-copy">군집 데이터가 없습니다.</p>
            ) : (
              <>
                <strong className="cluster-name">{dominantCluster[0]}</strong>
                <p className="cluster-count">{formatNumber(dominantCluster[1])}명 · 전체 군집 중 최다</p>
              </>
            )}
          </article>

          <BatchOverview batch={batch} />

          <article className="bento-card bento-card--table">
            <div className="table-card__header">
              <div>
                <p className="card-kicker">CUSTOMER INSIGHTS</p>
                <h2>고객별 분석 결과</h2>
              </div>
              <div className="table-card__actions">
                <button className="export-button" type="button" onClick={downloadCsv}>
                  CSV 다운로드
                </button>
                <span className="table-count">총 {formatNumber(data.total)}명</span>
              </div>
            </div>

            <div className="insight-filters" aria-label="고객 분석 결과 필터">
              <label className="filter-field filter-field--search">
                <span>고객 ID</span>
                <input
                  type="search"
                  inputMode="numeric"
                  value={customerIdFilter}
                  placeholder="ID 검색"
                  onChange={(event) => {
                    setCustomerIdFilter(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label className="filter-field">
                <span>위험도</span>
                <select
                  value={riskFilter}
                  onChange={(event) => {
                    setRiskFilter(event.target.value as RiskFilter);
                    setPage(1);
                  }}
                >
                  <option value="">전체</option>
                  <option value="high">높음</option>
                  <option value="medium">주의</option>
                  <option value="low">낮음</option>
                </select>
              </label>
              <label className="filter-field filter-field--cluster">
                <span>군집</span>
                <input
                  type="search"
                  value={clusterFilter}
                  placeholder="군집명"
                  onChange={(event) => {
                    setClusterFilter(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label className="filter-field">
                <span>정렬</span>
                <select
                  value={sortBy}
                  onChange={(event) => {
                    setSortBy(event.target.value as SortBy);
                    setPage(1);
                  }}
                >
                  <option value="churn_probability">이탈 확률</option>
                  <option value="activity_gap">활동성 갭</option>
                  <option value="scored_at">분석 시각</option>
                </select>
              </label>
              <button
                className="sort-order-button"
                type="button"
                aria-label={sortOrder === "desc" ? "내림차순 정렬" : "오름차순 정렬"}
                onClick={() => setSortOrder((current) => current === "desc" ? "asc" : "desc")}
              >
                {sortOrder === "desc" ? "↓" : "↑"}
              </button>
              <button className="reset-filter-button" type="button" onClick={resetFilters}>초기화</button>
            </div>

            {data.items.length === 0 ? (
              <div className="empty-state">
                <span aria-hidden="true">⌁</span>
                <strong>조건에 맞는 고객이 없습니다.</strong>
                <p>필터를 초기화하거나 다른 조건으로 검색해 보세요.</p>
              </div>
            ) : (
              <div className="insight-list" role="list" aria-label="고객 분석 결과 목록">
                <div className="insight-list__header" aria-hidden="true">
                  <span>고객</span><span>위험도</span><span>이탈 확률</span><span>활동성 갭</span><span>예상 거래</span><span>군집</span><span>추천 액션</span><span />
                </div>
                {data.items.map((insight) => (
                  <InsightRow key={insight.id} insight={insight} onSelect={(id) => void handleSelectCustomer(id)} />
                ))}
              </div>
            )}

            <div className="pagination">
              <span>{data.total === 0 ? "0" : `${(data.page - 1) * data.page_size + 1}–${Math.min(data.page * data.page_size, data.total)}`} / {formatNumber(data.total)}명</span>
              <div>
                <button type="button" disabled={data.page <= 1} onClick={() => setPage((current) => current - 1)} aria-label="이전 페이지">←</button>
                <strong>{data.page}</strong>
                <button type="button" disabled={data.page >= data.total_pages} onClick={() => setPage((current) => current + 1)} aria-label="다음 페이지">→</button>
              </div>
            </div>
          </article>

          {campaignError !== "" && <p className="campaign-error" role="alert">{campaignError}</p>}
          <CampaignQueue
            targets={campaignTargets}
            drafts={campaignDrafts}
            canManage={canProcessCampaignTargets}
            user={user}
            isLoading={campaignLoading}
            onDraftChange={handleCampaignDraftChange}
            onSave={(targetId) => void handleSaveCampaign(targetId)}
          />
        </section>
      )}

      {logoutError !== "" && <p className="dashboard-notice" role="alert">{logoutError}</p>}
      {selectedCustomerId !== null && (
        <>
          <button className="drawer-backdrop" type="button" aria-label="상세 패널 닫기" onClick={() => setSelectedCustomerId(null)} />
          <CustomerDetailPanel
            detail={selectedDetail}
            history={selectedHistory}
            historyLoading={historyLoading}
            campaigns={campaignTargets.filter((target) => target.customer_id === selectedCustomerId)}
            canManageCampaigns={canCreateCampaignTargets}
            campaignName={campaignName}
            campaignSubmitting={campaignSubmitting}
            campaignMessage={campaignMessage}
            onCampaignNameChange={setCampaignName}
            onCreateCampaign={() => void handleCreateCampaign()}
            isLoading={detailLoading}
            error={detailError}
            onClose={() => setSelectedCustomerId(null)}
          />
        </>
      )}
    </main>
  );
}
