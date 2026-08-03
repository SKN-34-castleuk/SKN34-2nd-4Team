import { useEffect, useState } from "react";

import type { AuthUser } from "../../api/auth";
import {
  createCampaignTarget,
  getCampaignPerformance,
  listCampaignTargets,
  updateCampaignTarget,
  type CampaignStatus,
  type CampaignTarget,
  type CampaignPerformance,
} from "../../api/campaigns";
import {
  getCustomerInsight,
  getCustomerInsightHistory,
  getDemographicBreakdown,
  listCustomerInsights,
  type CustomerInsight,
  type CustomerInsightDetail,
  type CustomerInsightHistory,
  type CustomerInsightList,
  type DemographicBreakdown,
  type DemographicBucket,
  type InsightQuery,
} from "../../api/insights";

const PAGE_SIZE = 8;

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
  showCampaignFeedback?: boolean;
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

function getClusterOptions(clusterCounts: Record<string, number>): [string, number][] {
  return Object.entries(clusterCounts).sort(([clusterA], [clusterB]) =>
    clusterA.localeCompare(clusterB, "ko"),
  );
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

/** 인구통계 카드 공용 가로 막대. `tone="risk"`면 위험 강조색을 씁니다. */
function DemographicBars({
  buckets,
  valueOf,
  formatValue,
  tone = "neutral",
}: {
  buckets: DemographicBucket[];
  valueOf: (bucket: DemographicBucket) => number;
  formatValue: (bucket: DemographicBucket) => string;
  tone?: "neutral" | "risk";
}) {
  // 응답에 해당 축이 없을 수도 있으므로(스키마 변경·부분 실패) 배열 여부를 확인한다.
  const safeBuckets = Array.isArray(buckets) ? buckets : [];
  if (safeBuckets.length === 0) {
    return <p className="empty-copy">표시할 데이터가 없습니다.</p>;
  }
  const maxValue = Math.max(...safeBuckets.map(valueOf), 0);

  return (
    <div className="demographic-bars">
      {safeBuckets.map((bucket) => {
        const value = valueOf(bucket);
        // 최댓값 대비 상대 길이로 그린다(0이면 막대를 그리지 않음).
        const width = maxValue > 0 ? (value / maxValue) * 100 : 0;
        return (
          <div className="demographic-bar" key={bucket.label}>
            <span className="demographic-bar__label">{bucket.label}</span>
            <span className="demographic-bar__track">
              <i
                className={
                  tone === "risk"
                    ? "demographic-bar__fill demographic-bar__fill--risk"
                    : "demographic-bar__fill"
                }
                style={{ width: `${width}%` }}
              />
            </span>
            <strong className="demographic-bar__value">{formatValue(bucket)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function DemographicCards({ breakdown }: { breakdown: DemographicBreakdown }) {
  return (
    <>
      <article className="bento-card bento-card--demographic">
        <div className="bento-card__heading">
          <div>
            <p className="card-kicker">INCOME</p>
            <h2>소득구간별 고위험 비율</h2>
          </div>
        </div>
        {/* 실제 이탈 라벨은 저장하지 않으므로 '예측' 위험도 비율임을 명시한다. */}
        <p className="card-note">이탈 예측 모델이 고위험으로 분류한 고객 비율입니다.</p>
        <DemographicBars
          buckets={breakdown.income}
          tone="risk"
          valueOf={(bucket) => bucket.high_risk_ratio}
          formatValue={(bucket) => formatPercent(bucket.high_risk_ratio)}
        />
      </article>

      <article className="bento-card bento-card--demographic">
        <div className="bento-card__heading">
          <div>
            <p className="card-kicker">AGE</p>
            <h2>연령대 분포</h2>
          </div>
        </div>
        <DemographicBars
          buckets={breakdown.age_band}
          valueOf={(bucket) => bucket.customer_count}
          formatValue={(bucket) => `${formatNumber(bucket.customer_count)}명`}
        />
      </article>

      <article className="bento-card bento-card--demographic">
        <div className="bento-card__heading">
          <div>
            <p className="card-kicker">EDUCATION</p>
            <h2>학력별 고객 분포</h2>
          </div>
        </div>
        <DemographicBars
          buckets={breakdown.education}
          valueOf={(bucket) => bucket.customer_count}
          formatValue={(bucket) => `${formatNumber(bucket.customer_count)}명`}
        />
      </article>

      <article className="bento-card bento-card--demographic">
        <div className="bento-card__heading">
          <div>
            <p className="card-kicker">CARD GRADE</p>
            <h2>카드 등급별 평균 이용률</h2>
          </div>
        </div>
        <DemographicBars
          buckets={breakdown.card_category}
          valueOf={(bucket) => bucket.average_utilization_ratio}
          formatValue={(bucket) => formatPercent(bucket.average_utilization_ratio)}
        />
      </article>
    </>
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

function signedPercentagePoints(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)}%p`;
}

function CampaignFeedback({
  performance,
  isLoading,
  error,
}: {
  performance: CampaignPerformance | null;
  isLoading: boolean;
  error: string;
}) {
  const [showMetricHelp, setShowMetricHelp] = useState(false);
  const metrics = performance?.summary ?? null;
  const pendingCount = metrics === null
    ? 0
    : Math.max(metrics.target_count - metrics.contacted_count, 0);

  useEffect(() => {
    if (!showMetricHelp) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowMetricHelp(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [showMetricHelp]);

  return (
    <article className="bento-card bento-card--campaign campaign-feedback">
      <div className="table-card__header">
        <div>
          <p className="card-kicker">CAMPAIGN FEEDBACK</p>
          <h2>캠페인 실행 피드백</h2>
        </div>
        <div className="campaign-feedback__header-actions">
          <span className="table-count">
            {metrics === null ? "전체 캠페인" : `${formatNumber(metrics.target_count)}명 대상`}
          </span>
          <button
            className="campaign-feedback-help"
            type="button"
            aria-expanded={showMetricHelp}
            aria-controls="campaign-feedback-metric-help"
            onClick={() => setShowMetricHelp((current) => !current)}
          >
            <span aria-hidden="true">?</span>
            지표 설명
          </button>
        </div>
      </div>
      <p className="campaign-feedback__intro">
        실행 결과를 바탕으로 타기팅 품질과 운영 병목을 확인합니다. 개별 고객 처리는 운영팀이 담당합니다.
      </p>
      {showMetricHelp && (
        <div className="campaign-feedback-help-backdrop">
          <section
            className="campaign-feedback-help-dialog"
            id="campaign-feedback-metric-help"
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-feedback-metric-help-title"
          >
            <div className="campaign-feedback-help-dialog__header">
              <div>
                <p className="card-kicker">METRIC GUIDE</p>
                <h3 id="campaign-feedback-metric-help-title">캠페인 지표 설명</h3>
              </div>
              <button
                className="campaign-feedback-help-close"
                type="button"
                aria-label="지표 설명 닫기"
                onClick={() => setShowMetricHelp(false)}
              >
                ×
              </button>
            </div>
            <div className="campaign-feedback__help">
              <div>
                <strong>접촉률</strong>
                <span>전체 대상 중 실제로 전화·문자·이메일 등 연락이 완료된 고객의 비율입니다. 100명 중 70명에게 연락했다면 70%입니다.</span>
              </div>
              <div>
                <strong>미처리 대상</strong>
                <span>아직 연락이 완료되지 않은 고객 수입니다. 숫자가 많으면 분석보다 운영팀의 실행이 지연되고 있을 수 있습니다.</span>
              </div>
              <div>
                <strong>전환율</strong>
                <span>캠페인 대상 중 신청·재이용·추가 거래 등 캠페인이 목표로 한 행동을 한 고객의 비율입니다.</span>
              </div>
              <div>
                <strong>치료군 전환율</strong>
                <span>캠페인 메시지·혜택·상담을 실제로 받은 그룹의 전환율입니다. 이 수치만으로는 캠페인 효과를 확정하지 않고 대조군과 비교합니다.</span>
              </div>
              <div>
                <strong>대조군 전환율</strong>
                <span>비슷한 고객 중 일부러 캠페인을 받지 않도록 남겨둔 비교 그룹의 전환율입니다. 캠페인이 없어도 자연스럽게 전환하는 비율을 보여줍니다.</span>
              </div>
              <div>
                <strong>증분 전환 효과</strong>
                <span>치료군 전환율에서 대조군 전환율을 뺀 값입니다. 예를 들어 치료군이 30%, 대조군이 10%이면 캠페인의 추가 효과는 +20%p로 해석합니다.</span>
              </div>
              <div>
                <strong>ROI</strong>
                <span>캠페인에 쓴 비용 대비 추가로 얻은 매출입니다. 0%보다 크면 비용보다 많은 추가 매출을 만들었다는 뜻입니다.</span>
              </div>
              <div>
                <strong>유지율</strong>
                <span>전환 후 설정된 관측 기간(예: 30일)이 지나도 계속 활동하거나 거래한 고객의 비율입니다. 아직 기간이 지나지 않은 고객은 계산에서 제외합니다.</span>
              </div>
            </div>
            <p className="campaign-feedback__help-note">
              치료군과 대조군의 차이가 클수록 캠페인 자체의 효과가 높다고 볼 수 있지만, 충분한 대상 수와 관측 기간이 함께 확보되어야 신뢰할 수 있습니다.
            </p>
          </section>
        </div>
      )}
      {isLoading ? (
        <p className="queue-state">캠페인 성과를 집계하는 중입니다.</p>
      ) : error !== "" ? (
        <p className="campaign-feedback__error" role="alert">{error}</p>
      ) : metrics === null || metrics.target_count === 0 ? (
        <p className="queue-state">분석할 캠페인 실행 결과가 없습니다.</p>
      ) : (
        <>
          <div className="campaign-feedback__metrics">
            <div>
              <span>접촉률</span>
              <strong>{formatPercent(metrics.contact_rate)}</strong>
              <small>{formatNumber(metrics.contacted_count)} / {formatNumber(metrics.target_count)}명 접촉</small>
            </div>
            <div>
              <span>미처리 대상</span>
              <strong>{formatNumber(pendingCount)}명</strong>
              <small>실행 병목 확인 대상</small>
            </div>
            <div>
              <span>전환율</span>
              <strong>{formatPercent(metrics.conversion_rate)}</strong>
              <small>{formatNumber(metrics.converted_count)}명 전환</small>
            </div>
            <div>
              <span>증분 전환 효과</span>
              <strong>{signedPercentagePoints(metrics.incremental_conversion_effect)}</strong>
              <small>치료군 − 대조군</small>
            </div>
            <div>
              <span>ROI</span>
              <strong>{metrics.roi === null ? "-" : formatPercent(metrics.roi)}</strong>
              <small>증분 매출 기준</small>
            </div>
          </div>
          <div className="campaign-feedback__comparison">
            <div>
              <span>치료군 전환율</span>
              <strong>{formatPercent(metrics.treatment_conversion_rate ?? 0)}</strong>
            </div>
            <div>
              <span>대조군 전환율</span>
              <strong>{formatPercent(metrics.control_conversion_rate ?? 0)}</strong>
            </div>
            <div>
              <span>유지율</span>
              <strong>{metrics.retention_rate === null ? "관측 중" : formatPercent(metrics.retention_rate)}</strong>
            </div>
          </div>
          <p className="campaign-feedback__note">
            미처리 대상은 실행 병목, 치료군과 대조군의 차이는 타기팅의 실제 효과를 나타냅니다.
          </p>
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
            {campaignMessage !== "" && <p className="campaign-message" role="status">{campaignMessage}</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

export function DashboardPage({ user, showCampaignFeedback = false }: DashboardPageProps) {
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
  const [demographics, setDemographics] = useState<DemographicBreakdown | null>(null);
  const [campaignTargets, setCampaignTargets] = useState<CampaignTarget[]>([]);
  const [campaignDrafts, setCampaignDrafts] = useState<Record<number, CampaignDraft>>({});
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState("");
  const [campaignPerformance, setCampaignPerformance] = useState<CampaignPerformance | null>(null);
  const shouldShowCampaignFeedback = user.role === "analyst" || showCampaignFeedback;
  const [campaignPerformanceLoading, setCampaignPerformanceLoading] = useState(shouldShowCampaignFeedback);
  const [campaignPerformanceError, setCampaignPerformanceError] = useState("");
  const [campaignName, setCampaignName] = useState("이탈 위험 리텐션");
  const [campaignSubmitting, setCampaignSubmitting] = useState(false);
  const [campaignMessage, setCampaignMessage] = useState("");

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
    // 인구통계는 전체 고객 기준 집계라 목록 필터와 무관하게 한 번만 조회한다.
    const loadDemographics = async () => {
      try {
        const response = await getDemographicBreakdown();
        if (isActive) {
          setDemographics(response);
        }
      } catch {
        if (isActive) {
          setDemographics(null);
        }
      }
    };
    void loadDemographics();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldShowCampaignFeedback) {
      return;
    }

    let isActive = true;
    void getCampaignPerformance()
      .then((response) => {
        if (isActive) {
          setCampaignPerformance(response);
          setCampaignPerformanceError("");
        }
      })
      .catch((requestError) => {
        if (isActive) {
          setCampaignPerformanceError(
            requestError instanceof Error
              ? requestError.message
              : "캠페인 성과를 불러오지 못했습니다.",
          );
        }
      })
      .finally(() => {
        if (isActive) {
          setCampaignPerformanceLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [shouldShowCampaignFeedback]);

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

  const isInitialLoading = data === null && error === "";
  const dominantCluster = data === null ? null : getDominantCluster(data.stats.cluster_counts);
  const clusterOptions = data === null ? [] : getClusterOptions(data.stats.cluster_options);
  const highRiskCount = data?.stats.risk_counts.high ?? 0;

  return (
    <>
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
          {/* 숫자 3개는 한 줄 KPI로 압축한다 — 카드마다 부제·아이콘을 두면
              정작 중요한 값이 묻힌다. */}
          <section className="kpi-row" aria-label="핵심 지표">
            <article className="kpi-tile">
              <span className="kpi-tile__label">분석 대상 고객</span>
              <strong className="kpi-tile__value">{formatNumber(data.stats.total)}</strong>
            </article>
            <article className="kpi-tile">
              <span className="kpi-tile__label">평균 이탈 확률</span>
              <strong className="kpi-tile__value">
                {formatPercent(data.stats.average_churn_probability)}
              </strong>
            </article>
            <button
              className="kpi-tile kpi-tile--action"
              type="button"
              onClick={focusHighRisk}
              aria-label="높은 이탈 위험 고객만 보기"
            >
              <span className="kpi-tile__label">우선 관리 고객</span>
              <strong className="kpi-tile__value kpi-tile__value--risk">
                {formatNumber(highRiskCount)}
              </strong>
              <span className="kpi-tile__hint">클릭하면 고위험만 필터링</span>
            </button>
            <article className="kpi-tile">
              <span className="kpi-tile__label">주요 고객 군집</span>
              <strong className="kpi-tile__value kpi-tile__value--text">
                {dominantCluster === null ? "-" : dominantCluster[0]}
              </strong>
              {dominantCluster !== null && (
                <span className="kpi-tile__hint">
                  {formatNumber(dominantCluster[1])}명 · 최다
                </span>
              )}
            </article>
          </section>

          <RiskOverview data={data} />

          {demographics !== null && <DemographicCards breakdown={demographics} />}

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
                <select
                  aria-label="군집"
                  value={clusterFilter}
                  onChange={(event) => {
                    setClusterFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">전체 군집</option>
                  {clusterOptions.map(([cluster, count]) => (
                    <option key={cluster} value={cluster}>
                      {cluster} ({formatNumber(count)}명)
                    </option>
                  ))}
                </select>
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
                  <option value="expected_transaction_count">예상 거래 건수</option>
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
          {shouldShowCampaignFeedback ? (
            <CampaignFeedback
              performance={campaignPerformance}
              isLoading={campaignPerformanceLoading}
              error={campaignPerformanceError}
            />
          ) : (
            <CampaignQueue
              targets={campaignTargets}
              drafts={campaignDrafts}
              canManage={canProcessCampaignTargets}
              user={user}
              isLoading={campaignLoading}
              onDraftChange={handleCampaignDraftChange}
              onSave={(targetId) => void handleSaveCampaign(targetId)}
            />
          )}
        </section>
      )}

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
    </>
  );
}
