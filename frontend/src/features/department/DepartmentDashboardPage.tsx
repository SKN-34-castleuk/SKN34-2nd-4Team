import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { listTeamMembers, updateTeamMember, type TeamMember } from "../../api/team";
import type { ApiError } from "../../api/client";
import type { AuthUser } from "../../api/auth";
import {
  createCampaignTarget,
  listCampaigns,
  listCampaignTargets,
  updateCampaignTarget,
  type Campaign,
  type CampaignStatus,
  type CampaignTarget,
  type CampaignTargetList,
  type CampaignResultCode,
} from "../../api/campaigns";

import {
  getCampaignPerformance,
  getSlaSummary,
  type CampaignPerformance,
  type SlaSummary,
} from "../../api/campaigns";
import {
  listCustomerInsights,
  getHighRiskCoverage,
  getDualSignalCount,
  type CustomerInsight,
  type CustomerInsightList,
  type DualSignalSummary,
  type HighRiskCoverage,
  type InsightQuery,
} from "../../api/insights";
import { getLatestBatch, type LatestBatch } from "../../api/modelRuns";


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

const campaignStatusLabels: Record<CampaignStatus, string> = {
  pending: "대기",
  assigned: "담당 배정",
  contacted: "접촉 완료",
  completed: "처리 완료",
  cancelled: "취소",
};

const campaignStatusTransitions: Record<CampaignStatus, CampaignStatus[]> = {
  pending: ["pending", "assigned", "cancelled"],
  assigned: ["pending", "assigned", "contacted", "cancelled"],
  contacted: ["contacted", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

const campaignResultLabels: Record<CampaignResultCode, string> = {
  contacted: "접촉",
  converted: "전환",
  not_converted: "미전환",
  no_response: "응답 없음",
  declined: "거절",
  opted_out: "수신 거부",
  invalid_contact: "연락처 오류",
};

const finalCampaignResultCodes: CampaignResultCode[] = [
  "converted",
  "not_converted",
  "no_response",
  "declined",
  "opted_out",
  "invalid_contact",
];

const roleDescriptions: Record<AuthUser["role"], string> = {
  admin: "팀 계정과 업무 권한을 관리합니다.",
  analyst: "고객 분석 결과와 모델 배치 상태를 확인합니다.",
  operations: "고위험 고객의 상담과 후속 처리를 관리합니다.",
  marketing: "고객 세그먼트와 캠페인 실행 결과를 관리합니다.",
};

type GuideEntry = { desc: string };

const GUIDE_CONTENT: Record<string, GuideEntry> = {
  "위험도별 SLA": {
    desc: "목표 응대시간 대비 준수율을 위험 등급별로 보여줍니다. 고위험일수록 더 짧은 목표 시간이 적용됩니다.",
  },
  "이중 신호 고객": {
    desc: "분류모델 고위험(risk_level=high)과 회귀모델 활동성 갭 하위 20%에 동시 해당하는 고객입니다. 한쪽 모델만 볼 때보다 놓치는 고객이 줄어들어 최우선 상담 대상이 됩니다.",
  },
  "미처리 대기열": {
    desc: "전체 백로그 크기와 처리 상태별 건수입니다.",
  },
  "접촉률 / 전환율": {
    desc: "접촉률은 개입군(캠페인을 받은 고객) 기준으로만 집계합니다. 비개입군을 포함하면 수치가 왜곡됩니다. 전환율은 담당자가 화면에서 직접 입력한 값입니다.",
  },
  "담당자별 처리 현황": {
    desc: "팀원별 배정·접촉률·전환율을 비교합니다.",
  },
  "방어한 매출": {
    desc: "비개입군의 자연 전환을 제외하고, 캠페인 덕분에 순수하게 늘어난 매출입니다. 개입군과 대조군의 전환·유지 차이를 매출로 환산해 계산합니다.",
  },
  "ROI": {
    desc: "캠페인에 쓴 비용 대비 추가로 얻은 매출(방어한 매출)의 비율입니다. 100%보다 크면 비용보다 많은 추가 매출을 만들었다는 뜻입니다.",
  },
  "군집별 증분 유지효과": {
    desc: "군집별로 캠페인 개입군과 대조군의 유지율 차이를 비교합니다. 어떤 고객 유형에 캠페인이 더 잘 먹히는지 확인해 다음 캠페인의 타겟팅 예산을 배분하는 근거로 씁니다.",
  },
  "캠페인 상태 퍼널": {
    desc: "등록된 캠페인 대상이 대기 → 담당 배정 → 접촉 완료 → 처리 완료 단계 중 어디에 몰려 있는지 보여줍니다.",
  },
  "고위험 커버리지": {
    desc: "고위험(risk_level=high) 고객 중 캠페인에 등록된 비율입니다. 목표 수준(80%) 미달 시 신규 캠페인 등록 대상 확대가 필요합니다.",
  },
  "위험도별 방어매출 · ROI": {
    desc: "고객의 위험도(risk_level: 높음/주의/낮음)별로 방어매출과 ROI를 비교합니다. 어느 위험군에 캠페인 예산을 더 쓸지 판단하는 근거입니다.",
  },
  "한 줄 해석": {
    desc: "숫자를 안 읽고도 판단 가능하게 하기 위한 요약 해석입니다.",
  },
};

const GuideContext = createContext<(key: string | null) => void>(() => {});

function InfoBtn({ guideKey }: { guideKey: string }) {
  const open = useContext(GuideContext);
  if (!GUIDE_CONTENT[guideKey]) {
    return null;
  }
  return (
    <button
      type="button"
      className="department-guide-btn"
      aria-label={`${guideKey} 설명 보기`}
      onClick={(event) => {
        event.stopPropagation();
        open(guideKey);
      }}
    >
      ?
    </button>
  );
}

function GuideDialog({ guideKey, onClose }: { guideKey: string | null; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  if (guideKey === null) {
    return null;
  }
  const entry = GUIDE_CONTENT[guideKey];
  if (!entry) {
    return null;
  }
  return (
    <div className="campaign-feedback-help-backdrop">
      <section
        className="campaign-feedback-help-dialog campaign-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-dialog-title"
      >
        <div className="campaign-feedback-help-dialog__header">
          <div>
            <p className="card-kicker">구현 가이드</p>
            <h3 id="guide-dialog-title">{guideKey}</h3>
          </div>
          <button
            className="campaign-feedback-help-close"
            type="button"
            aria-label="설명 닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="campaign-conflict-dialog__message">{entry.desc}</p>
        <button className="department-action-button campaign-conflict-dialog__confirm" type="button" onClick={onClose}>
          확인
        </button>
      </section>
    </div>
  );
}

const MARKETING_INSIGHT_PAGE_SIZE = 8;
const OPERATIONS_INSIGHT_PAGE_SIZE = 8;
const CAMPAIGN_QUEUE_PAGE_SIZE = 8;
// 캠페인 필터 선택지 상한입니다. 서버가 허용하는 page_size 최대값이기도 합니다.
const CAMPAIGN_FILTER_PAGE_SIZE = 100;
const PAGE_GROUP_SIZE = 10;

type DepartmentDashboardPageProps = {
  user: AuthUser;
};

type CampaignDraft = {
  status: CampaignStatus;
  result: string;
  result_code: CampaignResultCode | "";
  assigned_to_user_id: number | null;
  converted: boolean;
  retained: boolean | null;
  retainedDirty: boolean;
  outcome_revenue: string;
};

type MarketingRiskFilter = "" | NonNullable<InsightQuery["risk_level"]>;
type MarketingSortBy = NonNullable<InsightQuery["sort_by"]>;
type MarketingSortOrder = NonNullable<InsightQuery["sort_order"]>;
type CampaignTargetStats = NonNullable<CampaignTargetList["stats"]>;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSignedPercent(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${Math.round(value * 100)}%`;
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

const taskLabels: Record<string, string> = {
  classification: "분류모델",
  clustering: "군집모델",
  regression: "회귀모델",
};

function getTaskLabel(task: string): string {
  return taskLabels[task] ?? task;
}

function isHashLike(value: string): boolean {
  return /^[a-f0-9]{32,}$/i.test(value);
}

function isTimestampLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function isRawVersionValue(value: string): boolean {
  return isHashLike(value) || isTimestampLike(value);
}

function campaignQueueErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const translations: Record<string, string> = {
    "Retention cannot be recorded before retention_window_days has elapsed.": "처리 완료와 전환은 저장할 수 있지만, 유지 결과는 유지 관측 기간(기본 30일)이 지난 후에 입력할 수 있습니다. 유지 여부를 '유지 미관측'으로 두고 먼저 저장한 뒤, 30일이 지나면 유지 또는 미유지를 입력해 주세요.",
    "A treatment target must be completed before retention is recorded.": "유지 결과를 입력하려면 먼저 대상을 처리 완료 상태로 저장해야 합니다.",
    "Retention cannot be recorded before the observation period starts.": "유지 관측 시작일이 아직 도래하지 않아 유지 결과를 입력할 수 없습니다.",
    "A treatment result code requires a completed target.": "전환·미전환과 같은 최종 결과 코드는 대상을 처리 완료 상태로 저장한 후 입력할 수 있습니다.",
    "A completed treatment target requires a final structured result code.": "처리 완료로 저장하려면 전환, 미전환, 응답 없음, 거절, 수신 거부 또는 연락처 오류 중 하나를 선택해야 합니다.",
    "Outcome revenue can only be recorded for a converted target.": "성과 매출은 전환으로 처리된 고객에게만 입력할 수 있습니다.",
  };
  return translations[message] ?? (message || "캠페인 처리 결과를 저장하지 못했습니다. 입력값을 확인한 후 다시 시도해 주세요.");
}

function DepartmentRiskBadge({ risk }: { risk: CustomerInsight["risk_level"] }) {
  return (
    <span className={`risk-badge risk-badge--${risk}`}>
      <span aria-hidden="true" />
      {riskLabels[risk]}
    </span>
  );
}

function StatCard({ label, value, caption, tone = "purple", guideKey }: {
  label: string;
  value: string;
  caption: string;
  tone?: "purple" | "orange" | "green" | "pink" | "gold";
  guideKey?: string;
}) {
  return (
    <article className={`department-stat department-stat--${tone}`}>
      <span>{label}{guideKey && <InfoBtn guideKey={guideKey} />}</span>
      <strong>{value}</strong>
      <small>{caption}</small>
    </article>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="department-section-header">
      <span className="department-section-header__bar" aria-hidden="true" />
      <span className="department-section-header__label">{children}</span>
      <span className="department-section-header__line" aria-hidden="true" />
    </div>
  );
}

type ModelName = "분류" | "회귀" | "군집";

const MODEL_BADGE_TONE: Record<ModelName, string> = {
  "분류": "department-model-badge--classification",
  "회귀": "department-model-badge--regression",
  "군집": "department-model-badge--cluster",
};

function ModelBadge({ model }: { model: ModelName }) {
  return (
    <span className={`department-model-badge ${MODEL_BADGE_TONE[model]}`}>{model}</span>
  );
}

function CampaignRevenueHero({ performance }: { performance: CampaignPerformance | null }) {
  if (performance === null) {
    return null;
  }
  const metrics = performance.summary;
  const netResult = metrics.incremental_revenue - metrics.total_cost;
  const isLoss = netResult < 0;
  return (
    <section className="department-hero-metric" aria-label="캠페인 방어 매출 요약">
      <div className="department-panel__heading-with-guide">
        <p className="card-kicker">REVENUE DEFENDED</p>
        <InfoBtn guideKey="방어한 매출" />
      </div>
      <strong>{formatCurrency(metrics.incremental_revenue)}</strong>
      <small>비개입군의 자연 전환을 제외하고, 캠페인 덕분에 순수하게 늘어난 매출입니다.</small>
      <div className="department-hero-metric__roi">
        <span>ROI <strong>{formatSignedPercent(metrics.roi)}</strong></span>
        <span>증분 전환효과 <strong>{formatSignedPercent(metrics.incremental_conversion_effect)}</strong></span>
        <span>증분 유지효과 <strong>{formatSignedPercent(metrics.incremental_retention_effect)}</strong></span>
        <span>
          {isLoss ? "손실비용" : "순이익"}{" "}
          <strong className={isLoss ? "department-hero-metric__loss" : undefined}>
            {formatCurrency(Math.abs(netResult))}
          </strong>
        </span>
      </div>
    </section>
  );
}

function interpretCoverage(rate: number | null): string {
  if (rate === null) {
    return "고위험 고객이 없어 커버리지를 계산할 수 없습니다.";
  }
  const percent = Math.round(rate * 100);
  if (rate >= 0.8) {
    return `고위험 커버리지 ${percent}% — 목표 수준 충족. 현재 운영 체계를 유지하면 됩니다.`;
  }
  if (rate >= 0.5) {
    return `고위험 커버리지 ${percent}% — 보통 수준입니다. 미등록 고위험 고객을 우선 확인해 보세요.`;
  }
  return `고위험 커버리지 ${percent}% — 목표 대비 낮습니다. 신규 캠페인 등록 대상 확대가 필요합니다.`;
}

function interpretWeakestRiskLevel(performance: CampaignPerformance | null): string {
  if (performance === null || performance.by_risk_level.length === 0) {
    return "위험도별 데이터가 없어 ROI를 비교할 수 없습니다.";
  }
  const weakest = performance.by_risk_level.reduce((min, item) =>
    (item.roi ?? Infinity) < (min.roi ?? Infinity) ? item : min
  );
  if (weakest.roi === null) {
    return `${weakest.label} 위험군은 아직 비용 집행이 없어 ROI를 계산할 수 없습니다.`;
  }
  return `${weakest.label} 위험군 ROI ${formatSignedPercent(weakest.roi)} — 위험도군 중 가장 낮습니다. 예산·전략 재검토가 필요합니다.`;
}

function AdminInsightCallout({
  coverage,
  performance,
}: {
  coverage: HighRiskCoverage | null;
  performance: CampaignPerformance | null;
}) {
  return (
    <section className="department-insight-callout" aria-label="한 줄 해석">
      <div className="department-insight-callout__header">
        <span className="department-insight-callout__title">핵심(문구) — 한 줄 해석</span>
        <InfoBtn guideKey="한 줄 해석" />
      </div>
      <div className="department-insight-callout__grid">
        <div>
          <p className="department-insight-callout__label">커버리지 해석</p>
          <p>{interpretCoverage(coverage === null ? null : coverage.coverage_rate)}</p>
        </div>
        <div>
          <p className="department-insight-callout__label">ROI 해석</p>
          <p>{interpretWeakestRiskLevel(performance)}</p>
        </div>
      </div>
    </section>
  );
}

function CoverageGauge({ rate }: { rate: number | null }) {
  const percent = rate === null ? 0 : Math.round(rate * 100);
  const arcLength = 131.9;
  const color = rate === null ? "#9CA3AF" : rate >= 0.8 ? "#059669" : rate >= 0.5 ? "#d97706" : "#dc2626";
  return (
    <div className="department-coverage-gauge">
      <svg width="100" height="58" viewBox="0 0 100 58">
        <path d="M 8 52 A 42 42 0 0 1 92 52" fill="none" stroke="#e5e8eb" strokeWidth="10" strokeLinecap="round" />
        {rate !== null && (
          <path
            d="M 8 52 A 42 42 0 0 1 92 52"
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * arcLength} ${arcLength}`}
          />
        )}
      </svg>
      <span className="department-coverage-gauge__value">{rate === null ? "—" : `${percent}%`}</span>
    </div>
  );
}

const RISK_LEVEL_ORDER = ["high", "medium", "low"] as const;
const RISK_LEVEL_COLOR: Record<string, string> = {
  high: "#dc2626",
  medium: "#d97706",
  low: "#059669",
};

function RiskLevelRoiChart({ items }: { items: CampaignPerformance["by_risk_level"] }) {
  if (items.length === 0) {
    return <p className="department-empty">위험도별 데이터가 없습니다.</p>;
  }
  const sorted = [...items].sort(
    (a, b) => RISK_LEVEL_ORDER.indexOf(a.key as typeof RISK_LEVEL_ORDER[number]) - RISK_LEVEL_ORDER.indexOf(b.key as typeof RISK_LEVEL_ORDER[number]),
  );
  const W = 320;
  const H = 210;
  const PAD = { top: 34, right: 16, bottom: 34, left: 16 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // 막대(방어매출)와 선(ROI)이 같은 높이대를 쓰면 숫자 라벨이 겹치므로,
  // 아래쪽 65%는 막대 전용, 위쪽 35%는 ROI 선 전용으로 밴드를 분리한다.
  const barBandHeight = plotH * 0.65;
  const roiBandHeight = plotH * 0.35;
  const n = sorted.length;
  const slot = plotW / n;
  const barWidth = Math.min(52, slot * 0.4);
  const maxRevenue = Math.max(...sorted.map((item) => item.incremental_revenue), 1);
  const maxRoi = Math.max(...sorted.map((item) => item.roi ?? 0), 0.1);
  const baselineY = PAD.top + plotH;
  const xOf = (index: number) => PAD.left + slot * index + slot / 2;
  const barTopY = (revenue: number) => baselineY - (revenue / maxRevenue) * barBandHeight;
  const roiY = (roi: number) => (PAD.top + roiBandHeight) - (Math.max(roi, 0) / maxRoi) * roiBandHeight;
  const linePoints = sorted.map((item, index) => `${xOf(index)},${roiY(item.roi ?? 0)}`).join(" ");

  return (
    <div className="department-combo-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="위험도별 방어매출·ROI 콤보차트">
        <line x1={PAD.left} x2={W - PAD.right} y1={baselineY} y2={baselineY} stroke="var(--line)" strokeWidth={1} />
        {sorted.map((item, index) => {
          const color = RISK_LEVEL_COLOR[item.key] ?? "#9CA3AF";
          const x = xOf(index);
          const topY = barTopY(item.incremental_revenue);
          const barHeight = baselineY - topY;
          return (
            <g key={item.key}>
              <rect x={x - barWidth / 2} y={topY} width={barWidth} height={barHeight} fill={color} rx={4} />
              <text x={x} y={topY - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--navy)">
                {formatCurrency(item.incremental_revenue)}
              </text>
              <text x={x} y={baselineY + 15} textAnchor="middle" fontSize={9.5} fill="var(--muted)">{item.label}</text>
              <text x={x} y={baselineY + 27} textAnchor="middle" fontSize={9} fill="var(--muted)">{formatNumber(item.target_count)}명</text>
            </g>
          );
        })}
        <polyline points={linePoints} fill="none" stroke="var(--primary-dark)" strokeWidth={2} strokeLinejoin="round" />
        {sorted.map((item, index) => (
          <g key={`roi-${item.key}`}>
            <circle cx={xOf(index)} cy={roiY(item.roi ?? 0)} r={3.5} fill="var(--primary-dark)" />
            <text x={xOf(index)} y={roiY(item.roi ?? 0) - 8} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--primary-dark)">
              {item.roi === null ? "—" : formatSignedPercent(item.roi)}
            </text>
          </g>
        ))}
      </svg>
      <div className="department-combo-chart__legend">
        <span><i className="department-combo-chart__swatch" />방어매출</span>
        <span><i className="department-combo-chart__swatch department-combo-chart__swatch--line" />ROI</span>
      </div>
    </div>
  );
}

function AdminDecisionPanel({
  coverage,
  performance,
}: {
  coverage: HighRiskCoverage | null;
  performance: CampaignPerformance | null;
}) {
  return (
    <div className="department-hero-grid" aria-label="경영 판단 지표">
      <div className="department-hero-metric">
        <div className="department-panel__heading-with-guide">
          <p className="card-kicker">고위험 커버리지</p>
          <ModelBadge model="분류" />
          <InfoBtn guideKey="고위험 커버리지" />
        </div>
        <div className="department-coverage-row">
          <CoverageGauge rate={coverage === null ? null : coverage.coverage_rate} />
          <div className="department-coverage-row__stats">
            <strong>{coverage === null ? "—" : formatSignedPercent(coverage.coverage_rate)}</strong>
            <small>
              {coverage === null
                ? "데이터를 불러오는 중입니다."
                : `고위험 ${formatNumber(coverage.total_high_risk)}명 중 ${formatNumber(coverage.enrolled_high_risk)}명 캠페인 등록`}
            </small>
          </div>
        </div>
        <p className="department-panel__caption">
          {interpretCoverage(coverage === null ? null : coverage.coverage_rate)}
        </p>
      </div>
      <div className="department-panel">
        <div className="department-panel__heading-with-guide">
          <p className="card-kicker">위험도별 방어매출 · ROI</p>
          <InfoBtn guideKey="위험도별 방어매출 · ROI" />
        </div>
        <RiskLevelRoiChart items={performance === null ? [] : performance.by_risk_level} />
      </div>
    </div>
  );
}

function ClusterUpliftPanel({ performance }: { performance: CampaignPerformance | null }) {
  if (performance === null || performance.by_cluster.length === 0) {
    return null;
  }
  return (
    <section className="department-panel department-panel--wide" aria-label="군집별 증분 유지효과">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">CLUSTER UPLIFT</p>
          <h2>군집별 증분 유지·전환 효과 <InfoBtn guideKey="군집별 증분 유지효과" /></h2>
        </div>
        <span className="table-count">{formatNumber(performance.by_cluster.length)}개 군집</span>
      </div>
      <div className="campaign-performance-table-wrap">
        <table className="campaign-performance-table">
          <thead>
            <tr>
              <th scope="col">군집</th>
              <th scope="col">대상군 유지율</th>
              <th scope="col">대조군 유지율</th>
              <th scope="col">증분 유지효과</th>
              <th scope="col">방어매출</th>
              <th scope="col">ROI</th>
            </tr>
          </thead>
          <tbody>
            {performance.by_cluster.map((item) => (
              <tr key={item.key}>
                <th scope="row">{item.label}</th>
                <td>{formatSignedPercent(item.treatment_retention_rate)}</td>
                <td>{formatSignedPercent(item.control_retention_rate)}</td>
                <td>{formatSignedPercent(item.incremental_retention_effect)}</td>
                <td>{formatCurrency(item.incremental_revenue)}</td>
                <td>{formatSignedPercent(item.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="department-panel__caption">
        어떤 고객 유형에 캠페인이 더 잘 먹히는지 확인해, 다음 캠페인 타겟팅 예산을 배분하는 근거로 활용합니다.
      </p>
    </section>
  );
}

function SlaGaugeCard({ sla }: { sla: SlaSummary | null }) {
  return (
    <section className="department-panel department-sla-card" aria-label="위험도별 SLA">
      <div className="department-panel__heading-with-guide">
        <p className="card-kicker">위험도별 SLA</p>
        <InfoBtn guideKey="위험도별 SLA" />
      </div>
      {sla === null ? (
        <p className="department-empty">SLA 데이터를 불러오는 중입니다.</p>
      ) : (
        <div className="department-sla-rows">
          {sla.tiers.map((tier) => (
            <div className="department-sla-row" key={tier.risk_level}>
              <span className="department-sla-row__label">{riskLabels[tier.risk_level]}</span>
              <div className="department-sla-row__bar">
                <i style={{ width: `${Math.round((tier.met_rate ?? 0) * 100)}%` }} />
              </div>
              <span className="department-sla-row__value">
                {tier.met_rate === null
                  ? "접촉 이력 없음"
                  : `${Math.round(tier.met_rate * 100)}% · 목표 ${tier.target_hours}시간`}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="department-panel__caption">판단: 목표 응대시간(위험도별 상이) 대비 준수율 · 소스: created_at → contacted_at</p>
    </section>
  );
}

function DualSignalHero({ dualSignal }: { dualSignal: DualSignalSummary | null }) {
  return (
    <section className="department-hero-metric department-hero-metric--danger" aria-label="조기경보 이중 신호 고객">
      <div className="department-panel__heading-with-guide">
        <p className="card-kicker">조기경보 겹침 고객 (이중 신호)</p>
        <InfoBtn guideKey="이중 신호 고객" />
      </div>
      <strong>{dualSignal === null ? "—" : `${formatNumber(dualSignal.count)}명`}</strong>
      <small>고위험(risk_level) + 활동성 갭 하위 20% 동시 해당</small>
    </section>
  );
}

function DetailAccordionRow({
  title, source, guideKey, isOpen, onToggle, children,
}: {
  title: string; source: string; guideKey?: string; isOpen: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="department-accordion-row">
      <button type="button" className="department-accordion-row__header" onClick={onToggle}>
        <span className="department-accordion-row__title">
          <i className={`department-accordion-row__chevron${isOpen ? " is-open" : ""}`} aria-hidden="true" />
          {title}
          {guideKey && <InfoBtn guideKey={guideKey} />}
        </span>
        <span className="department-accordion-row__source">{source}</span>
      </button>
      {isOpen && <div className="department-accordion-row__panel">{children}</div>}
    </div>
  );
}

function BatchCard({ batch }: { batch: LatestBatch | null }) {
  return (
    <article className="eda-chart-card eda-chart-card--wide batch-overview--wide">
      <div className="table-card__header eda-chart-card__header">
        <div>
          <h3>최근 배치</h3>
        </div>
        <span className="batch-status">{batch === null ? "확인 중" : "동기화 완료"}</span>
      </div>
      {batch === null ? (
        <p className="empty-copy">배치 실행 정보를 불러오는 중입니다.</p>
      ) : (
        <div className="batch-overview__body">
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
              <span key={run.id}>
                {getTaskLabel(run.task)}
                {run.model_version !== null && run.model_version !== "" && !isRawVersionValue(run.model_version)
                  ? ` · ${run.model_version}`
                  : null}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function MarketingCandidateFilters({
  riskLevel,
  clusterName,
  sortBy,
  sortOrder,
  clusterOptions,
  onRiskLevelChange,
  onClusterNameChange,
  onSortByChange,
  onSortOrderChange,
  onReset,
}: {
  riskLevel: MarketingRiskFilter;
  clusterName: string;
  sortBy: MarketingSortBy;
  sortOrder: MarketingSortOrder;
  clusterOptions: Record<string, number>;
  onRiskLevelChange: (value: MarketingRiskFilter) => void;
  onClusterNameChange: (value: string) => void;
  onSortByChange: (value: MarketingSortBy) => void;
  onSortOrderChange: (value: MarketingSortOrder) => void;
  onReset: () => void;
}) {
  const sortedClusterOptions = Object.entries(clusterOptions).sort(
    ([firstName, firstCount], [secondName, secondCount]) => secondCount - firstCount
      || firstName.localeCompare(secondName),
  );

  return (
    <>
      <div className="filter-bar">
        <label className="filter-bar__field">
          <span>위험도</span>
          <select
            aria-label="캠페인 후보 위험도"
            value={riskLevel}
            onChange={(event) => onRiskLevelChange(event.target.value as MarketingRiskFilter)}
          >
            <option value="">전체 위험도</option>
            <option value="high">높음</option>
            <option value="medium">주의</option>
            <option value="low">낮음</option>
          </select>
        </label>
        <label className="filter-bar__field filter-bar__field--cluster">
          <span>군집</span>
          <select
            aria-label="캠페인 후보 군집"
            value={clusterName}
            onChange={(event) => onClusterNameChange(event.target.value)}
          >
            <option value="">전체 군집</option>
            {sortedClusterOptions.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({formatNumber(count)}명)
              </option>
            ))}
          </select>
        </label>
        <label className="filter-bar__field">
          <span>정렬 기준</span>
          <select
            aria-label="캠페인 후보 정렬 기준"
            value={sortBy}
            onChange={(event) => onSortByChange(event.target.value as MarketingSortBy)}
          >
            <option value="churn_probability">이탈 확률</option>
            <option value="activity_gap">활동성 갭</option>
            <option value="expected_transaction_count">예상 거래 건수</option>
            <option value="scored_at">최근 분석 시각</option>
          </select>
        </label>
        <label className="filter-bar__field">
          <span>정렬 순서</span>
          <select
            aria-label="캠페인 후보 정렬 순서"
            value={sortOrder}
            onChange={(event) => onSortOrderChange(event.target.value as MarketingSortOrder)}
          >
            <option value="desc">높은 값부터</option>
            <option value="asc">낮은 값부터</option>
          </select>
        </label>
        <span className="filter-bar__spacer" aria-hidden="true" />
        <button className="filter-bar__reset" type="button" onClick={onReset}>초기화</button>
      </div>
      <p className="department-panel__caption">
        분석 결과를 기준으로 후보를 좁힌 뒤, 정렬된 고객부터 캠페인에 등록할 수 있습니다.
      </p>
    </>
  );
}

function CampaignConflictDialog({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="campaign-feedback-help-backdrop">
      <section
        className="campaign-feedback-help-dialog campaign-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-conflict-title"
      >
        <div className="campaign-feedback-help-dialog__header">
          <div>
            <p className="card-kicker">CAMPAIGN GUARD</p>
            <h3 id="campaign-conflict-title">캠페인 등록 불가</h3>
          </div>
          <button
            className="campaign-feedback-help-close"
            type="button"
            aria-label="캠페인 등록 안내 닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="campaign-conflict-dialog__message">{message}</p>
        <p className="campaign-conflict-dialog__message">
          중복 접촉을 막기 위해 이미 처리 중인 캠페인, 최근 접촉 고객, 수신 거부 고객은 후보 목록에서 자동으로 제외됩니다.
        </p>
        <button
          className="department-action-button campaign-conflict-dialog__confirm"
          type="button"
          onClick={onClose}
        >
          확인
        </button>
      </section>
    </div>
  );
}

function CampaignQueueFeedbackDialog({
  message,
  onClose,
  variant,
}: {
  message: string;
  onClose: () => void;
  variant: "error" | "success";
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const title = variant === "success" ? "저장 완료" : "캠페인 처리 저장 안내";

  return (
    <div className="campaign-feedback-help-backdrop">
      <section
        className={`campaign-feedback-help-dialog campaign-conflict-dialog campaign-action-dialog campaign-action-dialog--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-queue-feedback-title"
      >
        <div className="campaign-feedback-help-dialog__header">
          <div>
            <p className="card-kicker">{variant === "success" ? "CAMPAIGN SAVED" : "CAMPAIGN UPDATE"}</p>
            <h3 id="campaign-queue-feedback-title">{title}</h3>
          </div>
          <button
            className="campaign-feedback-help-close"
            type="button"
            aria-label={`${title} 닫기`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="campaign-conflict-dialog__message">{message}</p>
        <button className="department-action-button campaign-conflict-dialog__confirm" type="button" onClick={onClose}>
          확인
        </button>
      </section>
    </div>
  );
}

function DepartmentPagination({
  label,
  currentStart,
  currentEnd,
  total,
  page,
  totalPages,
  onPageChange,
}: {
  label: string;
  currentStart: number;
  currentEnd: number;
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return null;
  }
  const groupStart = Math.floor((page - 1) / PAGE_GROUP_SIZE) * PAGE_GROUP_SIZE + 1;
  const groupEnd = Math.min(groupStart + PAGE_GROUP_SIZE - 1, totalPages);
  const pages = Array.from({ length: groupEnd - groupStart + 1 }, (_, index) => groupStart + index);
  return (
    <div className="department-insight-pagination">
      <span>{formatNumber(currentStart)}–{formatNumber(currentEnd)} / {formatNumber(total)}명</span>
      <div className="department-insight-pagination__pages">
        <button
          type="button"
          aria-label={`이전 ${label} 페이지 묶음`}
          disabled={groupStart === 1}
          onClick={() => onPageChange(groupStart - 1)}
        >
          ‹
        </button>
        {pages.map((pageNumber) => (
          <button
            type="button"
            key={pageNumber}
            className={pageNumber === page ? "department-insight-pagination__page department-insight-pagination__page--active" : "department-insight-pagination__page"}
            aria-label={`${label} ${pageNumber}페이지`}
            aria-current={pageNumber === page ? "page" : undefined}
            onClick={() => onPageChange(pageNumber)}
          >
            {pageNumber}
          </button>
        ))}
        <button
          type="button"
          aria-label={`다음 ${label} 페이지 묶음`}
          disabled={groupEnd === totalPages}
          onClick={() => onPageChange(groupEnd + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

function InsightPriorityTable({
  kicker,
  heading,
  toolbar,
  insights,
  targets,
  campaignName,
  onCreate,
  isCreating,
  total,
  page,
  pageSize,
  totalPages,
  onPageChange,
}: {
  kicker: string;
  heading: string;
  toolbar?: ReactNode;
  insights: CustomerInsight[];
  targets: CampaignTarget[];
  campaignName: string;
  onCreate?: (insight: CustomerInsight) => void;
  isCreating: number | null;
  total: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}) {
  const targetInsightIds = new Set(targets.map((target) => target.customer_insight_id));
  const currentPage = page ?? 1;
  const currentPageSize = pageSize ?? insights.length;
  const currentStart = total === 0 ? 0 : (currentPage - 1) * currentPageSize + 1;
  const currentEnd = total === 0 ? 0 : Math.min(currentPage * currentPageSize, total);
  const hasPagination = onPageChange !== undefined && totalPages !== undefined && totalPages > 1;
  return (
    <section className="department-panel department-panel--wide">
      <div className="department-panel__heading">
        <div>
          <p className="card-kicker">{kicker}</p>
          <h2>{heading}</h2>
        </div>
        <span className="table-count">{formatNumber(total)}명</span>
      </div>
      {toolbar}
      {insights.length === 0 ? (
        <p className="department-empty">현재 조건에 맞는 고객이 없습니다.</p>
      ) : (
        <div className="department-insight-list" role="list" aria-label={`${heading} 목록`}>
          <div className="department-insight-list__header" aria-hidden="true">
            <span>고객</span>
            <span>위험도</span>
            <span>이탈 확률</span>
            <span>활동성 갭</span>
            <span>예상 거래</span>
            <span>군집</span>
            <span>추천 액션</span>
            <span>캠페인</span>
          </div>
          {insights.map((insight) => {
            const isRegistered = targetInsightIds.has(insight.id);
            return (
              <div className="department-insight-row" key={insight.id} role="listitem">
                <span className="department-insight-row__customer">
                  <strong>{insight.customer_id}</strong>
                  <small>{formatDate(insight.scored_at)}</small>
                </span>
                <span className="department-insight-row__risk">
                  <DepartmentRiskBadge risk={insight.risk_level} />
                </span>
                <span className="department-insight-row__metric">
                  <strong>{formatPercent(insight.churn_probability)}</strong>
                  <small>이탈 확률</small>
                </span>
                <span className={`department-insight-row__gap ${insight.activity_gap < 0 ? "department-gap--negative" : ""}`}>
                  {insight.activity_gap > 0 ? "+" : ""}{formatDecimal(insight.activity_gap)}
                  <small>활동성 갭</small>
                </span>
                <span className="department-insight-row__expected">
                  {formatDecimal(insight.expected_transaction_count)}건
                  <small>예상 거래</small>
                </span>
                <span className="department-insight-row__cluster">
                  {insight.cluster_name}
                  <small>
                    신뢰도 {insight.cluster_confidence == null ? "-" : formatPercent(insight.cluster_confidence)}
                  </small>
                </span>
                <span className="department-insight-row__action">{insight.recommended_action}</span>
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
                  <span className="department-campaign-result">마케팅팀 등록</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {hasPagination && (
        <DepartmentPagination
          label="우선 고객"
          currentStart={currentStart}
          currentEnd={currentEnd}
          total={total}
          page={currentPage}
          totalPages={totalPages ?? 0}
          onPageChange={onPageChange!}
        />
      )}
    </section>
  );
}

function CampaignQueue({
  targets,
  total,
  page,
  pageSize,
  totalPages,
  onPageChange,
  canManage,
  assignees,
  user,
  onUpdated,
  campaignFilter,
  campaignOptions,
  onCampaignFilterChange,
}: {
  targets: CampaignTarget[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  canManage: boolean;
  assignees: TeamMember[];
  user: AuthUser;
  onUpdated: (target: CampaignTarget) => void;
  campaignFilter: number | "";
  campaignOptions: Campaign[];
  onCampaignFilterChange: (value: number | "") => void;
}) {
  const [drafts, setDrafts] = useState<Record<number, CampaignDraft>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const currentStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const currentEnd = total === 0 ? 0 : Math.min(page * pageSize, total);
  const hasPagination = totalPages > 1;

  const save = async (target: CampaignTarget) => {
    const draft = drafts[target.id] ?? {
      status: target.status,
      result: target.result ?? "",
      result_code: target.result_code ?? "",
      assigned_to_user_id: target.assigned_to_user_id,
      converted: target.converted,
      retained: target.retained ?? null,
      retainedDirty: false,
      outcome_revenue: target.outcome_revenue == null ? "" : String(target.outcome_revenue),
    };
    setSavingId(target.id);
    setError("");
    setSuccess("");
    try {
      const updated = await updateCampaignTarget(target.id, {
        status: draft.status,
        ...(draft.assigned_to_user_id !== target.assigned_to_user_id
          ? { assigned_to_user_id: draft.assigned_to_user_id }
          : {}),
        result: draft.result || undefined,
        result_code: draft.result_code || undefined,
        converted: draft.converted,
        ...(draft.retainedDirty ? { retained: draft.retained } : {}),
        outcome_revenue: draft.outcome_revenue === "" ? null : Number(draft.outcome_revenue),
      });
      onUpdated(updated);
      setSuccess("캠페인 처리 결과를 저장했습니다.");
    } catch (requestError) {
      setError(campaignQueueErrorMessage(requestError));
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
        <span className="table-count">{formatNumber(total)}건</span>
      </div>
      <div className="insight-filters department-insight-filters">
        <label className="filter-field filter-field--cluster">
          <span>캠페인</span>
          <select
            aria-label="캠페인 처리 현황 캠페인"
            value={campaignFilter === "" ? "" : String(campaignFilter)}
            onChange={(event) => onCampaignFilterChange(
              event.target.value === "" ? "" : Number(event.target.value),
            )}
          >
            <option value="">전체 캠페인</option>
            {campaignOptions.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        {campaignFilter !== "" && (
          <button className="reset-filter-button" type="button" onClick={() => onCampaignFilterChange("")}>
            초기화
          </button>
        )}
      </div>
      {error !== "" && <CampaignQueueFeedbackDialog message={error} variant="error" onClose={() => setError("")} />}
      {success !== "" && <CampaignQueueFeedbackDialog message={success} variant="success" onClose={() => setSuccess("")} />}
      {targets.length === 0 ? (
        <p className="department-empty">
          {campaignFilter === ""
            ? "등록된 캠페인 대상이 없습니다."
            : "선택한 캠페인에 등록된 대상이 없습니다."}
        </p>
      ) : (
        <div className="department-campaign-list">
          {targets.map((target) => {
            const draft = drafts[target.id] ?? {
              status: target.status,
              result: target.result ?? "",
              result_code: target.result_code ?? "",
              assigned_to_user_id: target.assigned_to_user_id,
              converted: target.converted,
              retained: target.retained ?? null,
              retainedDirty: false,
              outcome_revenue: target.outcome_revenue == null ? "" : String(target.outcome_revenue),
            };
            const canEditTarget = canManage && (
              user.role === "admin"
              || (
                target.experiment_group === "treatment"
                && (target.assigned_to_user_id === null || target.assigned_to_user_id === user.id)
              )
            );
            const availableStatuses = campaignStatusTransitions[target.status].filter((status) => {
              if (target.experiment_group === "control") {
                return status === "pending" || status === "cancelled";
              }
              if (target.campaign_status !== "active") {
                return !["contacted", "completed"].includes(status);
              }
              return true;
            });
            const finalCodeRequired = draft.status === "completed"
              && !finalCampaignResultCodes.includes(draft.result_code as CampaignResultCode);
            const availableResultCodes = Object.entries(campaignResultLabels).filter(([code]) => {
              if (target.experiment_group === "control") {
                return code !== "contacted";
              }
              if (code === "contacted") {
                return draft.status === "contacted" || draft.status === "completed";
              }
              return draft.status === "completed";
            });
            const retentionDisabled = target.experiment_group === "treatment" && draft.status !== "completed";
            return (
              <div className="department-campaign-row" key={target.id}>
                <div>
                  <strong>{target.customer_id}</strong>
                  <small>{target.campaign_name} · {target.assigned_to_display_name ?? "미배정"}</small>
                </div>
                <span className={`campaign-status campaign-status--${target.status}`}>
                  {campaignStatusLabels[target.status]}
                </span>
                {canEditTarget ? (
                  <div className="department-campaign-controls">
                    <select
                      aria-label={`${target.customer_id} 처리 상태`}
                      value={draft.status}
                      onChange={(event) => setDrafts((current) => {
                        const status = event.target.value as CampaignStatus;
                        const isCompleted = status === "completed";
                        const isFinalCode = finalCampaignResultCodes.includes(draft.result_code as CampaignResultCode);
                        return {
                          ...current,
                          [target.id]: {
                            ...draft,
                            status,
                            result_code: !isCompleted && isFinalCode ? "" : draft.result_code,
                            converted: isCompleted ? draft.converted : false,
                            retained: retentionDisabled || !isCompleted ? null : draft.retained,
                            outcome_revenue: isCompleted && draft.converted ? draft.outcome_revenue : "",
                          },
                        };
                      })}
                    >
                      {availableStatuses.map((value) => (
                        <option value={value} key={value}>
                          {campaignStatusLabels[value]}
                        </option>
                      ))}
                    </select>
                    <div className="department-campaign-performance">
                      <select
                        aria-label={`${target.customer_id} 유지 여부`}
                        value={draft.retained === null ? "" : String(draft.retained)}
                        disabled={retentionDisabled}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [target.id]: {
                          ...draft,
                            retained: event.target.value === "" ? null : event.target.value === "true",
                            retainedDirty: true,
                          },
                        }))}
                      >
                        <option value="">유지 미관측</option>
                        <option value="true">유지</option>
                        <option value="false">미유지</option>
                      </select>
                      <input
                        type="number"
                        min={0}
                        step={1000}
                        aria-label={`${target.customer_id} 성과 매출`}
                        value={draft.outcome_revenue}
                        placeholder="성과 매출"
                        disabled={!draft.converted}
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [target.id]: { ...draft, outcome_revenue: event.target.value },
                        }))}
                      />
                    </div>
                    <select
                      aria-label={`${target.customer_id} 결과 코드`}
                      value={draft.result_code}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [target.id]: {
                          ...draft,
                          result_code: event.target.value as CampaignResultCode | "",
                          converted: event.target.value === "converted",
                          outcome_revenue: event.target.value === "converted" ? draft.outcome_revenue : "",
                        },
                      }))}
                    >
                      <option value="">결과 코드</option>
                      {availableResultCodes.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
                    </select>
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
                    <button type="button" disabled={savingId === target.id || finalCodeRequired} onClick={() => void save(target)}>
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
      {hasPagination && (
        <DepartmentPagination
          label="캠페인 처리"
          currentStart={currentStart}
          currentEnd={currentEnd}
          total={total}
          page={page}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
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
    <>
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
                className={member.role === "admin" ? "department-team-select department-team-select--locked" : "department-team-select"}
                value={draft.role}
                disabled={member.role === "admin"}
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
                className="department-team-select"
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
    </>
  );
}

export function DepartmentDashboardPage({ user }: DepartmentDashboardPageProps) {
  const [insights, setInsights] = useState<CustomerInsightList | null>(null);
  const [targets, setTargets] = useState<CampaignTarget[]>([]);
  const [campaignTargetTotal, setCampaignTargetTotal] = useState(0);
  const [campaignQueuePage, setCampaignQueuePage] = useState(1);
  const [campaignQueueTotalPages, setCampaignQueueTotalPages] = useState(0);
  const [campaignQueueStats, setCampaignQueueStats] = useState<CampaignTargetStats | null>(null);
  const [campaignQueueFilter, setCampaignQueueFilter] = useState<number | "">("");
  const [campaignQueueOptions, setCampaignQueueOptions] = useState<Campaign[]>([]);
  const [batch, setBatch] = useState<LatestBatch | null>(null);
  const [performance, setPerformance] = useState<CampaignPerformance | null>(null);
  const [coverage, setCoverage] = useState<HighRiskCoverage | null>(null);
  const [slaSummary, setSlaSummary] = useState<SlaSummary | null>(null);
  const [dualSignal, setDualSignal] = useState<DualSignalSummary | null>(null);
  const [activeCampaignCount, setActiveCampaignCount] = useState<number | null>(null);
  const [adminDetailOpen, setAdminDetailOpen] = useState(false);
  const [activeGuideKey, setActiveGuideKey] = useState<string | null>(null);
  const [operationsDetail, setOperationsDetail] = useState<
    "접촉률 / 전환율" | "담당자별 처리 현황" | "미처리 대기열" | null
  >(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState<number | null>(null);
  const [operationsInsightPage, setOperationsInsightPage] = useState(1);
  const [insightPage, setInsightPage] = useState(1);
  const [marketingRiskFilter, setMarketingRiskFilter] = useState<MarketingRiskFilter>("");
  const [marketingClusterFilter, setMarketingClusterFilter] = useState("");
  const [marketingSortBy, setMarketingSortBy] = useState<MarketingSortBy>("churn_probability");
  const [marketingSortOrder, setMarketingSortOrder] = useState<MarketingSortOrder>("desc");
  const [createMessage, setCreateMessage] = useState("");
  const [campaignConflictMessage, setCampaignConflictMessage] = useState("");
  const [insightRefreshKey, setInsightRefreshKey] = useState(0);

  const canProcessTargets = user.role === "admin" || user.role === "operations";
  const showsCampaignQueue = user.role === "operations" || user.role === "marketing";
  const canCreateCampaignTargets = user.role === "admin" || user.role === "marketing";
  const insightQuery = useMemo(() => {
    if (user.role === "operations") {
      return {
        risk_level: "high" as const,
        sort_by: "churn_probability" as const,
        sort_order: "desc" as const,
        page: operationsInsightPage,
        page_size: OPERATIONS_INSIGHT_PAGE_SIZE,
      };
    }
    if (user.role === "marketing") {
      return {
        risk_level: marketingRiskFilter || undefined,
        cluster_name: marketingClusterFilter || undefined,
        sort_by: marketingSortBy,
        sort_order: marketingSortOrder,
        campaign_candidates_only: true,
        page: insightPage,
        page_size: MARKETING_INSIGHT_PAGE_SIZE,
      };
    }
    return {
      sort_by: "churn_probability" as const,
      sort_order: "desc" as const,
      page: 1,
      page_size: 100,
    };
  }, [insightPage, marketingClusterFilter, marketingRiskFilter, marketingSortBy, marketingSortOrder, operationsInsightPage, user.role]);

  useEffect(() => {
    let isActive = true;
    const load = async () => {
    const [
      insightResult, campaignResult, batchResult, performanceResult, coverageResult,
      slaResult, dualSignalResult, activeCampaignResult,
    ] = await Promise.allSettled([
        listCustomerInsights(insightQuery),
        listCampaignTargets({
    page: campaignQueuePage,
    page_size: CAMPAIGN_QUEUE_PAGE_SIZE,
    ...(user.role === "operations" ? { sort_by_priority: true } : {}),
    ...(campaignQueueFilter === "" ? {} : { campaign_id: campaignQueueFilter }),
  }),
  getLatestBatch(),
  user.role === "marketing" || user.role === "admin" || user.role === "operations" ? getCampaignPerformance() : Promise.resolve(null),
  user.role === "admin" ? getHighRiskCoverage() : Promise.resolve(null),
  user.role === "operations" ? getSlaSummary() : Promise.resolve(null),
  user.role === "operations" ? getDualSignalCount() : Promise.resolve(null),
  user.role === "admin" ? listCampaigns({ status: "active", page_size: 1 }) : Promise.resolve(null),
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
        setCampaignTargetTotal(campaignResult.value.total);
        setCampaignQueueTotalPages(campaignResult.value.total_pages);
        setCampaignQueueStats(campaignResult.value.stats ?? null);
      }
      if (batchResult.status === "fulfilled") {
        setBatch(batchResult.value);
      }
      if (performanceResult.status === "fulfilled" && performanceResult.value !== null) {
        setPerformance(performanceResult.value);
      }
      if (coverageResult.status === "fulfilled" && coverageResult.value !== null) {
        setCoverage(coverageResult.value);
      }
      if (slaResult.status === "fulfilled" && slaResult.value !== null) {
        setSlaSummary(slaResult.value);
      }
      if (dualSignalResult.status === "fulfilled" && dualSignalResult.value !== null) {
        setDualSignal(dualSignalResult.value);
      }
      if (activeCampaignResult.status === "fulfilled" && activeCampaignResult.value !== null) {
        setActiveCampaignCount(activeCampaignResult.value.total);
      }
      setIsLoading(false);
    };
    void load();
    return () => {
      isActive = false;
    };
  }, [campaignQueueFilter, campaignQueuePage, insightQuery, insightRefreshKey, user.role]);

  // 처리 현황 필터의 선택지입니다. 대상 목록은 페이지 단위로 잘려 오므로,
  // 목록에 보이는 캠페인만 모아 만들면 다른 페이지의 캠페인이 빠집니다.
  useEffect(() => {
    if (!showsCampaignQueue) {
      return;
    }
    let isActive = true;
    void listCampaigns({ page: 1, page_size: CAMPAIGN_FILTER_PAGE_SIZE })
      .then((response) => {
        if (isActive) {
          setCampaignQueueOptions(response.items);
        }
      })
      .catch(() => {
        if (isActive) {
          setCampaignQueueOptions([]);
        }
      });
    return () => {
      isActive = false;
    };
  }, [showsCampaignQueue]);

  const updateCampaignQueueFilter = (value: number | "") => {
    setCampaignQueueFilter(value);
    setCampaignQueuePage(1);
  };

  useEffect(() => {
    let isActive = true;
    void listTeamMembers(user.role === "admin")
      .then((response) => {
        if (isActive) {
          const operationsMembers = response.filter(
            (member) => member.role === "operations" && member.is_active,
          );
          setMembers(
            user.role === "admin"
              ? response
              : user.role === "operations"
              ? operationsMembers.filter((member) => member.id === user.id)
              : operationsMembers,
          );
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
  }, [user.id, user.role]);

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
      });
      setTargets((current) => [target, ...current]);
      setCampaignTargetTotal((current) => current + 1);
      setCreateMessage("캠페인 대상에 미배정 상태로 등록했습니다.");
      setCampaignQueuePage(1);
      setInsightPage(1);
      setInsightRefreshKey((current) => current + 1);
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 409) {
        setCreateMessage("");
        setCampaignConflictMessage(
          "다른 사용자가 먼저 등록했거나 이 고객이 최근 접촉·수신 거부 상태로 변경되어 등록할 수 없습니다.",
        );
        setCampaignQueuePage(1);
        setInsightPage(1);
        setInsightRefreshKey((current) => current + 1);
      } else {
        setCreateMessage(requestError instanceof Error ? requestError.message : "캠페인 등록에 실패했습니다.");
      }
    } finally {
      setIsCreating(null);
    }
  };

  const updateMarketingRiskFilter = (value: MarketingRiskFilter) => {
    setMarketingRiskFilter(value);
    setInsightPage(1);
  };

  const handleCampaignQueueUpdated = (updated: CampaignTarget) => {
    setTargets((current) => current.map((target) => target.id === updated.id ? updated : target));
    setInsightRefreshKey((current) => current + 1);
  };

  const updateMarketingClusterFilter = (value: string) => {
    setMarketingClusterFilter(value);
    setInsightPage(1);
  };

  const updateMarketingSortBy = (value: MarketingSortBy) => {
    setMarketingSortBy(value);
    setMarketingSortOrder(value === "activity_gap" ? "asc" : "desc");
    setInsightPage(1);
  };

  const updateMarketingSortOrder = (value: MarketingSortOrder) => {
    setMarketingSortOrder(value);
    setInsightPage(1);
  };

  const resetMarketingFilters = () => {
    setMarketingRiskFilter("");
    setMarketingClusterFilter("");
    setMarketingSortBy("churn_probability");
    setMarketingSortOrder("desc");
    setInsightPage(1);
  };

  const highRiskCount = insights?.stats.risk_counts.high ?? 0;
  const pendingCount = campaignQueueStats?.unprocessed_targets ?? 0;
  const completedCount = campaignQueueStats?.status_counts.completed ?? 0;
  const campaignStatusCounts = useMemo(() => Object.fromEntries(
    Object.keys(campaignStatusLabels).map((status) => [
      status,
      campaignQueueStats?.status_counts[status] ?? 0,
    ]),
  ) as Record<CampaignStatus, number>, [campaignQueueStats]);
  const campaignStatusTotal = Math.max(
    campaignQueueStats?.total_targets ?? campaignTargetTotal,
    1,
  );

  const operationsContactRate = performance?.summary.treatment_contact_rate ?? null;
  const operationsConversionRate = performance?.summary.conversion_rate ?? null;
  const operationsCompletedRate = campaignStatusTotal > 0
    ? campaignStatusCounts.completed / campaignStatusTotal
    : null;

  const roleContent = user.role === "operations" ? (
    <>
      <div className="department-hero-grid">
        <SlaGaugeCard sla={slaSummary} />
        <DualSignalHero dualSignal={dualSignal} />
      </div>
      <section className="department-stats">
        <StatCard label="HIGH RISK" value={formatNumber(highRiskCount)} caption="우선 상담 대상" tone="pink" />
        <StatCard label="OPEN QUEUE" value={formatNumber(pendingCount)} caption="처리 대기 캠페인" tone="orange" />
        <StatCard label="AVERAGE CHURN" value={formatPercent(insights?.stats.average_churn_probability ?? 0)} caption="고위험 고객 기준" tone="purple" />
        <BatchCard batch={batch} />
      </section>
      <section className="department-panel department-panel--wide">
        <div className="department-panel__heading">
          <div>
            <p className="card-kicker">상세</p>
            <h2>운영 세부 지표</h2>
          </div>
        </div>
        <div className="department-accordion">
          <DetailAccordionRow
            title="접촉률 / 전환율"
            source="treatment_contact_rate · conversion_rate"
            guideKey="접촉률 / 전환율"
            isOpen={operationsDetail === "접촉률 / 전환율"}
            onToggle={() => setOperationsDetail((current) => (current === "접촉률 / 전환율" ? null : "접촉률 / 전환율"))}
          >
            <div className="department-accordion-metrics">
              <div>
                <p>접촉률 (개입군)</p>
                <strong>{operationsContactRate === null ? "—" : formatPercent(operationsContactRate)}</strong>
              </div>
              <div>
                <p>전환율 †</p>
                <strong>{operationsConversionRate === null ? "—" : formatPercent(operationsConversionRate)}</strong>
              </div>
              <div>
                <p>완료율</p>
                <strong>{operationsCompletedRate === null ? "—" : formatPercent(operationsCompletedRate)}</strong>
              </div>
            </div>
            <p className="department-panel__caption">† 전환율·완료율은 담당자가 화면에서 직접 입력한 값입니다.</p>
          </DetailAccordionRow>
          <DetailAccordionRow
            title="담당자별 처리 현황"
            source="by_assignee breakdown"
            guideKey="담당자별 처리 현황"
            isOpen={operationsDetail === "담당자별 처리 현황"}
            onToggle={() => setOperationsDetail((current) => (current === "담당자별 처리 현황" ? null : "담당자별 처리 현황"))}
          >
            {performance === null || performance.by_assignee.length === 0 ? (
              <p className="department-empty">담당자별 데이터가 없습니다.</p>
            ) : (
              <table className="campaign-performance-table">
                <thead>
                  <tr>
                    <th scope="col">담당자</th>
                    <th scope="col">배정</th>
                    <th scope="col">접촉률</th>
                    <th scope="col">전환율</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.by_assignee.map((item) => (
                    <tr key={item.key}>
                      <th scope="row">{item.label}</th>
                      <td>{formatNumber(item.target_count)}</td>
                      <td>{item.treatment_contact_rate === null ? "—" : formatPercent(item.treatment_contact_rate)}</td>
                      <td>{item.treatment_conversion_rate === null ? "—" : formatPercent(item.treatment_conversion_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DetailAccordionRow>
          <DetailAccordionRow
            title="미처리 대기열"
            source="CampaignStats.unprocessed_targets"
            guideKey="미처리 대기열"
            isOpen={operationsDetail === "미처리 대기열"}
            onToggle={() => setOperationsDetail((current) => (current === "미처리 대기열" ? null : "미처리 대기열"))}
          >
            <div className="department-accordion-metrics">
              <div>
                <p>전체 백로그</p>
                <strong>{formatNumber(pendingCount)}건</strong>
              </div>
              <div>
                <p>대기</p>
                <strong>{formatNumber(campaignStatusCounts.pending)}건</strong>
              </div>
              <div>
                <p>담당 배정</p>
                <strong>{formatNumber(campaignStatusCounts.assigned)}건</strong>
              </div>
              <div>
                <p>처리 완료</p>
                <strong>{formatNumber(campaignStatusCounts.completed)}건</strong>
              </div>
            </div>
          </DetailAccordionRow>
        </div>
      </section>
      <InsightPriorityTable
        kicker="PRIORITY INSIGHTS"  
        heading="우선 관리 고객"
        insights={insights?.items ?? []}
        targets={targets}
        campaignName="리텐션 등록"
        onCreate={canCreateCampaignTargets ? (item) => void createCampaign(item) : undefined}
        isCreating={isCreating}
        total={insights?.total ?? 0}
        page={operationsInsightPage}
        pageSize={OPERATIONS_INSIGHT_PAGE_SIZE}
        totalPages={insights?.total_pages ?? 0}
        onPageChange={setOperationsInsightPage}
      />
      <CampaignQueue
        targets={targets}
        total={campaignTargetTotal}
        page={campaignQueuePage}
        pageSize={CAMPAIGN_QUEUE_PAGE_SIZE}
        totalPages={campaignQueueTotalPages}
        onPageChange={setCampaignQueuePage}
        canManage={canProcessTargets}
        assignees={members.filter((member) => member.role === "operations" && member.is_active)}
        user={user}
        onUpdated={handleCampaignQueueUpdated}
        campaignFilter={campaignQueueFilter}
        campaignOptions={campaignQueueOptions}
        onCampaignFilterChange={updateCampaignQueueFilter}
      />
    </>
  ) : user.role === "marketing" ? (
    <>
      <CampaignRevenueHero performance={performance} />
      <section className="department-stats">
        <StatCard label="TARGETS" value={formatNumber(campaignTargetTotal)} caption="등록된 캠페인 대상" tone="purple" />
        <StatCard label="OPEN QUEUE" value={formatNumber(pendingCount)} caption="실행 대기 대상" tone="orange" />
        <StatCard label="COMPLETED" value={formatNumber(completedCount)} caption="처리 완료 캠페인" tone="green" />
        <StatCard
          label="ROI"
          value={performance === null ? "—" : formatSignedPercent(performance.summary.roi)}
          caption="증분매출 대비 캠페인 비용 회수율"
          tone="gold"
          guideKey="ROI"
        />
      </section>
      <ClusterUpliftPanel performance={performance} />
      <section className="department-panel department-panel--wide">
        <div className="department-panel__heading">
          <div>
            <p className="card-kicker">CAMPAIGN FUNNEL</p>
            <h2>캠페인 상태 분포 <InfoBtn guideKey="캠페인 상태 퍼널" /></h2>
          </div>
        </div>
        <div className="department-funnel">
          {Object.entries(campaignStatusLabels).map(([status, label]) => (
            <div key={status}>
              <span>{label}</span>
              <strong>{campaignStatusCounts[status as CampaignStatus]}</strong>
              <i
                style={{
                  width: `${Math.min(
                    Math.max(
                      (campaignStatusCounts[status as CampaignStatus] / campaignStatusTotal) * 100,
                      campaignStatusCounts[status as CampaignStatus] > 0 ? 8 : 0,
                    ),
                    100,
                  )}%`,
                }}
              />
            </div>
          ))}
        </div>
      </section>
      <InsightPriorityTable
        kicker="CAMPAIGN CANDIDATES"
        heading="캠페인 후보 고객"
        toolbar={(
          <MarketingCandidateFilters
            riskLevel={marketingRiskFilter}
            clusterName={marketingClusterFilter}
            sortBy={marketingSortBy}
            sortOrder={marketingSortOrder}
            clusterOptions={insights?.stats.cluster_options ?? {}}
            onRiskLevelChange={updateMarketingRiskFilter}
            onClusterNameChange={updateMarketingClusterFilter}
            onSortByChange={updateMarketingSortBy}
            onSortOrderChange={updateMarketingSortOrder}
            onReset={resetMarketingFilters}
          />
        )}
        insights={insights?.items ?? []}
        targets={targets}
        campaignName="캠페인 등록"
        onCreate={undefined}
        isCreating={isCreating}
        total={insights?.total ?? 0}
        page={insightPage}
        pageSize={MARKETING_INSIGHT_PAGE_SIZE}
        totalPages={insights?.total_pages ?? 0}
        onPageChange={setInsightPage}
      />
      <CampaignQueue
        targets={targets}
        total={campaignTargetTotal}
        page={campaignQueuePage}
        pageSize={CAMPAIGN_QUEUE_PAGE_SIZE}
        totalPages={campaignQueueTotalPages}
        onPageChange={setCampaignQueuePage}
        canManage={canProcessTargets}
        assignees={members.filter((member) => member.role === "operations" && member.is_active)}
        user={user}
        onUpdated={handleCampaignQueueUpdated}
        campaignFilter={campaignQueueFilter}
        campaignOptions={campaignQueueOptions}
        onCampaignFilterChange={updateCampaignQueueFilter}
      />
    </>
  ) : (
    <>
      <SectionHeader>핵심 — 의사결정 지표</SectionHeader>
      <AdminDecisionPanel coverage={coverage} performance={performance} />
      <AdminInsightCallout coverage={coverage} performance={performance} />
      <section className="department-stats">
        <StatCard label="CUSTOMERS" value={formatNumber(insights?.stats.total ?? 0)} caption="분석 대상 고객" tone="purple" />
        <StatCard
          label="REVENUE DEFENDED"
          value={performance === null ? "—" : formatCurrency(performance.summary.incremental_revenue)}
          caption="전체 방어매출"
          tone="gold"
        />
        <StatCard
          label="AVERAGE ROI"
          value={performance === null ? "—" : formatSignedPercent(performance.summary.roi)}
          caption="증분매출 대비 비용 회수율"
          tone="green"
        />
        <StatCard
          label="ACTIVE CAMPAIGNS"
          value={activeCampaignCount === null ? "—" : formatNumber(activeCampaignCount)}
          caption="현재 진행중인 캠페인"
          tone="orange"
        />
      </section>
      <SectionHeader>상세 — 실행</SectionHeader>
      <div className="department-accordion">
        <DetailAccordionRow
          title="팀 계정 관리 · 권한 설정 · 담당자 배정"
          source={`TeamRoster · ${formatNumber(members.length)}명`}
          isOpen={adminDetailOpen}
          onToggle={() => setAdminDetailOpen((current) => !current)}
        >
          <TeamRoster
            members={members}
            onUpdated={(updated) => setMembers((current) => current.map((member) => member.id === updated.id ? updated : member))}
          />
        </DetailAccordionRow>
      </div>
    </>
  );

  return (
    <GuideContext.Provider value={setActiveGuideKey}>
      <div className={`department-layout--${user.role}`}>
        {isLoading && <section className="department-loading">부서별 업무 데이터를 불러오는 중입니다.</section>}
        {!isLoading && error !== "" && <section className="department-error" role="alert">{error}</section>}
        {!isLoading && error === "" && (
          <div className="department-content">
            <RoleSummary user={user} />
            {createMessage !== "" && <p className="department-message" role="status">{createMessage}</p>}
            {roleContent}
          </div>
        )}
        {campaignConflictMessage !== "" && (
          <CampaignConflictDialog
            message={campaignConflictMessage}
            onClose={() => setCampaignConflictMessage("")}
          />
        )}
        <GuideDialog guideKey={activeGuideKey} onClose={() => setActiveGuideKey(null)} />
      </div>
    </GuideContext.Provider>
  );
}