import { useEffect, useMemo, useState } from "react";

import { logout, type AuthUser } from "../../api/auth";
import {
  createCampaign,
  listCampaignEvents,
  listCampaignTargetsByCampaign,
  listCampaigns,
  updateCampaign,
  updateCampaignTarget,
  type Campaign,
  type CampaignEventList,
  type CampaignLifecycleStatus,
  type CampaignList,
  type CampaignResultCode,
  type CampaignStatus,
  type CampaignTarget,
  type CampaignTargetList,
} from "../../api/campaigns";
import { listTeamMembers, type TeamMember } from "../../api/team";
import { BulkTargetingPanel } from "./BulkTargetingPanel";

const PAGE_SIZE = 8;

const lifecycleLabels: Record<CampaignLifecycleStatus, string> = {
  draft: "초안",
  scheduled: "예약",
  active: "진행 중",
  paused: "일시 중지",
  completed: "완료",
  cancelled: "취소",
};

const lifecycleTransitions: Record<CampaignLifecycleStatus, CampaignLifecycleStatus[]> = {
  draft: ["draft", "scheduled", "active", "cancelled"],
  scheduled: ["scheduled", "active", "paused", "cancelled"],
  active: ["active", "paused", "completed", "cancelled"],
  paused: ["paused", "active", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

const targetStatusLabels: Record<CampaignStatus, string> = {
  pending: "대기",
  assigned: "담당 배정",
  contacted: "접촉 완료",
  completed: "처리 완료",
  cancelled: "취소",
};

const targetStatusTransitions: Record<CampaignStatus, CampaignStatus[]> = {
  pending: ["pending", "assigned", "cancelled"],
  assigned: ["assigned", "contacted", "cancelled"],
  contacted: ["contacted", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

const resultCodeLabels: Record<CampaignResultCode, string> = {
  converted: "전환",
  not_converted: "미전환",
  no_response: "응답 없음",
  declined: "거절",
  invalid_contact: "연락처 오류",
};

const eventLabels: Record<string, string> = {
  created: "캠페인 생성",
  status_changed: "상태 변경",
  assigned: "담당자 배정",
  result_updated: "처리 결과 변경",
  conversion_updated: "전환 여부 변경",
};

const roleLabels: Record<AuthUser["role"], string> = {
  admin: "관리자",
  analyst: "분석 담당자",
  operations: "운영 담당자",
  marketing: "마케팅 담당자",
};

type CampaignManagementPageProps = {
  user: AuthUser;
  onBack: () => void;
  onLoggedOut: () => void;
};

type CampaignForm = {
  name: string;
  description: string;
  channel: string;
  status: CampaignLifecycleStatus;
  start_at: string;
  end_at: string;
};

type TargetDraft = {
  status: CampaignStatus;
  assigned_to_user_id: number | null;
  result: string;
  result_code: CampaignResultCode | "";
  converted: boolean;
};

function emptyCampaignForm(): CampaignForm {
  return {
    name: "",
    description: "",
    channel: "",
    status: "draft",
    start_at: "",
    end_at: "",
  };
}

function campaignToForm(campaign: Campaign): CampaignForm {
  return {
    name: campaign.name,
    description: campaign.description ?? "",
    channel: campaign.channel ?? "",
    status: campaign.status,
    start_at: toDateTimeInput(campaign.start_at),
    end_at: toDateTimeInput(campaign.end_at),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDate(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toDateTimeInput(value: string | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoDate(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}

function getCustomerId(value: string): number | undefined {
  const customerId = Number(value.trim());
  return Number.isInteger(customerId) && customerId > 0 ? customerId : undefined;
}

function getTargetDraft(target: CampaignTarget): TargetDraft {
  return {
    status: target.status,
    assigned_to_user_id: target.assigned_to_user_id,
    result: target.result ?? "",
    result_code: target.result_code ?? "",
    converted: target.converted,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function CampaignStats({ campaign }: { campaign: Campaign }) {
  const stats = campaign.stats;
  return (
    <section className="campaign-management-stats" aria-label="캠페인 통계">
      <article className="campaign-stat campaign-stat--purple">
        <span>ALL TARGETS</span>
        <strong>{formatNumber(stats.total_targets)}</strong>
        <small>전체 대상 고객</small>
      </article>
      <article className="campaign-stat campaign-stat--orange">
        <span>OPEN QUEUE</span>
        <strong>{formatNumber(stats.unprocessed_targets)}</strong>
        <small>미처리 대상</small>
      </article>
      <article className="campaign-stat campaign-stat--blue">
        <span>CONTACTED</span>
        <strong>{formatNumber(stats.contacted_targets)}</strong>
        <small>접촉 시작 대상</small>
      </article>
      <article className="campaign-stat campaign-stat--green">
        <span>CONVERTED</span>
        <strong>{formatNumber(stats.converted_targets)}</strong>
        <small>전환 완료 대상</small>
      </article>
    </section>
  );
}

function CampaignEditor({
  title,
  form,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
  isSubmitting,
  isCreate,
  statusOptions,
}: {
  title: string;
  form: CampaignForm;
  submitLabel: string;
  onChange: (form: CampaignForm) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  isSubmitting: boolean;
  isCreate?: boolean;
  statusOptions?: CampaignLifecycleStatus[];
}) {
  const availableStatuses = statusOptions ?? (Object.keys(lifecycleLabels) as CampaignLifecycleStatus[]);
  return (
    <form
      className="campaign-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="campaign-editor__heading">
        <div>
          <p className="card-kicker">{isCreate ? "NEW CAMPAIGN" : "CAMPAIGN SETTINGS"}</p>
          <h3>{title}</h3>
        </div>
        {onCancel && (
          <button className="campaign-link-button" type="button" onClick={onCancel}>
            닫기
          </button>
        )}
      </div>
      <label>
        <span>캠페인 이름</span>
        <input
          required
          maxLength={150}
          value={form.name}
          placeholder="예: 8월 고위험 고객 리텐션"
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </label>
      <div className="campaign-editor__row">
        <label>
          <span>채널</span>
          <input
            value={form.channel}
            maxLength={80}
            placeholder="전화, 앱 푸시, 이메일"
            onChange={(event) => onChange({ ...form, channel: event.target.value })}
          />
        </label>
        <label>
          <span>상태</span>
          <select
            value={form.status}
            onChange={(event) => onChange({ ...form, status: event.target.value as CampaignLifecycleStatus })}
          >
            {availableStatuses.map((status) => (
              <option value={status} key={status}>{lifecycleLabels[status]}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="campaign-editor__row">
        <label>
          <span>시작 일시</span>
          <input
            type="datetime-local"
            value={form.start_at}
            onChange={(event) => onChange({ ...form, start_at: event.target.value })}
          />
        </label>
        <label>
          <span>종료 일시</span>
          <input
            type="datetime-local"
            value={form.end_at}
            onChange={(event) => onChange({ ...form, end_at: event.target.value })}
          />
        </label>
      </div>
      <label>
        <span>설명</span>
        <textarea
          maxLength={500}
          value={form.description}
          placeholder="캠페인 목적과 실행 기준을 입력하세요."
          onChange={(event) => onChange({ ...form, description: event.target.value })}
        />
      </label>
      <div className="campaign-editor__actions">
        {onCancel && (
          <button className="campaign-secondary-button" type="button" onClick={onCancel}>
            취소
          </button>
        )}
        <button className="campaign-primary-button" type="submit" disabled={isSubmitting || form.name.trim() === ""}>
          {isSubmitting ? "저장 중..." : submitLabel}
        </button>
      </div>
    </form>
  );
}

function TargetTable({
  data,
  drafts,
  assignees,
  canProcessTargets,
  onDraftChange,
  onSave,
  isSaving,
}: {
  data: CampaignTargetList;
  drafts: Record<number, TargetDraft>;
  assignees: TeamMember[];
  canProcessTargets: boolean;
  onDraftChange: (targetId: number, draft: TargetDraft) => void;
  onSave: (targetId: number) => void;
  isSaving: number | null;
}) {
  return (
    <div className="campaign-target-table-wrap">
      <div className="campaign-target-table" role="table" aria-label="캠페인 대상 목록">
        <div className="campaign-target-table__head" role="row">
          <span>고객</span>
          <span>처리 상태</span>
          <span>담당자</span>
          <span>결과</span>
          <span>전환</span>
          {canProcessTargets && <span>작업</span>}
        </div>
        {data.items.map((target) => {
          const draft = drafts[target.id] ?? getTargetDraft(target);
          return (
            <div className="campaign-target-table__row" role="row" key={target.id}>
              <div className="campaign-target-customer">
                <strong>고객 {target.customer_id}</strong>
                <small>대상 #{target.id} · {formatDate(target.updated_at)}</small>
              </div>
              {canProcessTargets ? (
                <select
                  value={draft.status}
                  aria-label={`고객 ${target.customer_id} 처리 상태`}
                  onChange={(event) => onDraftChange(target.id, { ...draft, status: event.target.value as CampaignStatus })}
                >
                  {targetStatusTransitions[target.status].map((status) => (
                    <option value={status} key={status}>{targetStatusLabels[status]}</option>
                  ))}
                </select>
              ) : (
                <span className={`campaign-status campaign-status--${target.status}`}>{targetStatusLabels[target.status]}</span>
              )}
              {canProcessTargets ? (
                <select
                  value={draft.assigned_to_user_id ?? ""}
                  aria-label={`고객 ${target.customer_id} 담당자`}
                  onChange={(event) => onDraftChange(target.id, {
                    ...draft,
                    assigned_to_user_id: event.target.value === "" ? null : Number(event.target.value),
                  })}
                >
                  <option value="">미배정</option>
                  {assignees.map((assignee) => (
                    <option value={assignee.id} key={assignee.id}>{assignee.display_name}</option>
                  ))}
                </select>
              ) : (
                <span className="campaign-target-muted">{target.assigned_to_display_name ?? "미배정"}</span>
              )}
              {canProcessTargets ? (
                <div className="campaign-target-result">
                  <input
                    value={draft.result}
                    placeholder="처리 결과"
                    aria-label={`고객 ${target.customer_id} 처리 결과`}
                    onChange={(event) => onDraftChange(target.id, { ...draft, result: event.target.value })}
                  />
                  <select
                    value={draft.result_code}
                    aria-label={`고객 ${target.customer_id} 결과 코드`}
                    onChange={(event) => onDraftChange(target.id, {
                      ...draft,
                      result_code: event.target.value as CampaignResultCode | "",
                    })}
                  >
                    <option value="">코드 없음</option>
                    {Object.entries(resultCodeLabels).map(([code, label]) => (
                      <option value={code} key={code}>{label}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <span className="campaign-target-muted">{target.result ?? "결과 대기"}</span>
              )}
              {canProcessTargets ? (
                <label className="campaign-conversion campaign-conversion--management">
                  <input
                    type="checkbox"
                    checked={draft.converted}
                    disabled={draft.status !== "completed"}
                    onChange={(event) => onDraftChange(target.id, { ...draft, converted: event.target.checked })}
                  />
                  전환
                </label>
              ) : (
                <span className={target.converted ? "campaign-converted" : "campaign-target-muted"}>
                  {target.converted ? "전환" : "-"}
                </span>
              )}
              {canProcessTargets && (
                <button
                  className="campaign-save-button"
                  type="button"
                  disabled={isSaving === target.id}
                  onClick={() => onSave(target.id)}
                >
                  {isSaving === target.id ? "저장 중" : "저장"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventTimeline({ data, page, onPageChange }: {
  data: CampaignEventList | null;
  page: number;
  onPageChange: (page: number) => void;
}) {
  if (data === null || data.items.length === 0) {
    return <p className="campaign-empty-copy">아직 기록된 이벤트가 없습니다.</p>;
  }
  const totalPages = Math.max(Math.ceil(data.total / data.page_size), 1);
  return (
    <>
      <div className="campaign-event-list">
        {data.items.map((event) => (
          <article className="campaign-event" key={event.id}>
            <span className="campaign-event__dot" aria-hidden="true" />
            <div>
              <strong>{eventLabels[event.event_type] ?? event.event_type}</strong>
              <p>
                {event.campaign_target_id === null ? "캠페인 전체" : `대상 #${event.campaign_target_id}`}
                {event.from_status !== null || event.to_status !== null
                  ? ` · ${event.from_status ?? "신규"} → ${event.to_status ?? "-"}`
                  : ""}
              </p>
              <small>{event.actor_display_name ?? "시스템"} · {formatDate(event.created_at)}</small>
            </div>
          </article>
        ))}
      </div>
      <div className="campaign-inline-pagination">
        <span>{formatNumber(data.total)}개 이벤트</span>
        <div>
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="이전 이벤트 페이지">←</button>
          <strong>{page}</strong>
          <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="다음 이벤트 페이지">→</button>
        </div>
      </div>
    </>
  );
}

export function CampaignManagementPage({ user, onBack, onLoggedOut }: CampaignManagementPageProps) {
  const canManageCampaigns = user.role === "admin" || user.role === "marketing";
  const canProcessTargets = user.role === "admin" || user.role === "operations";
  const isReadOnly = user.role === "analyst";
  const [campaignData, setCampaignData] = useState<CampaignList | null>(null);
  const [campaignStatusFilter, setCampaignStatusFilter] = useState<CampaignLifecycleStatus | "">("");
  const [campaignNameFilter, setCampaignNameFilter] = useState("");
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignRefreshKey, setCampaignRefreshKey] = useState(0);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(false);
  const [createForm, setCreateForm] = useState<CampaignForm>(emptyCampaignForm);
  const [editForm, setEditForm] = useState<CampaignForm>(emptyCampaignForm);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [campaignMessage, setCampaignMessage] = useState("");
  const [targetData, setTargetData] = useState<CampaignTargetList | null>(null);
  const [targetStatusFilter, setTargetStatusFilter] = useState<CampaignStatus | "">("");
  const [targetAssigneeFilter, setTargetAssigneeFilter] = useState("");
  const [targetCustomerFilter, setTargetCustomerFilter] = useState("");
  const [targetConvertedFilter, setTargetConvertedFilter] = useState<"" | "true" | "false">("");
  const [targetPage, setTargetPage] = useState(1);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [targetDrafts, setTargetDrafts] = useState<Record<number, TargetDraft>>({});
  const [savingTargetId, setSavingTargetId] = useState<number | null>(null);
  const [targetRefreshKey, setTargetRefreshKey] = useState(0);
  const [eventData, setEventData] = useState<CampaignEventList | null>(null);
  const [eventPage, setEventPage] = useState(1);
  const [eventLoading, setEventLoading] = useState(false);
  const [eventError, setEventError] = useState("");
  const [assignees, setAssignees] = useState<TeamMember[]>([]);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const selectedCampaign = useMemo(
    () => campaignData?.items.find((campaign) => campaign.id === selectedCampaignId) ?? null,
    [campaignData, selectedCampaignId],
  );

  const selectCampaign = (campaign: Campaign) => {
    setSelectedCampaignId(campaign.id);
    setEditForm(campaignToForm(campaign));
    setEditingCampaign(false);
    setTargetPage(1);
    setEventPage(1);
    setTargetStatusFilter("");
    setTargetAssigneeFilter("");
    setTargetCustomerFilter("");
    setTargetConvertedFilter("");
    setTargetDrafts({});
    setCampaignMessage("");
  };

  useEffect(() => {
    let isActive = true;
    const loadCampaigns = async () => {
      setCampaignLoading(true);
      try {
        const response = await listCampaigns({
          status: campaignStatusFilter || undefined,
          name: campaignNameFilter.trim() || undefined,
          page: campaignPage,
          page_size: PAGE_SIZE,
        });
        if (!isActive) {
          return;
        }
        setCampaignData(response);
        setCampaignError("");
        const nextCampaign = response.items.find((campaign) => campaign.id === selectedCampaignId)
          ?? response.items[0];
        if (nextCampaign !== undefined && nextCampaign.id !== selectedCampaignId) {
          selectCampaign(nextCampaign);
        } else if (nextCampaign === undefined) {
          setSelectedCampaignId(null);
        }
      } catch (error: unknown) {
        if (isActive) {
          setCampaignError(errorMessage(error, "캠페인 목록을 불러오지 못했습니다."));
        }
      } finally {
        if (isActive) {
          setCampaignLoading(false);
        }
      }
    };
    void loadCampaigns();
    return () => {
      isActive = false;
    };
  }, [campaignNameFilter, campaignPage, campaignRefreshKey, campaignStatusFilter, selectedCampaignId]);

  useEffect(() => {
    if (selectedCampaignId === null) {
      return;
    }
    let isActive = true;
    const loadTargets = async () => {
      setTargetLoading(true);
      try {
        const response = await listCampaignTargetsByCampaign(selectedCampaignId, {
          status: targetStatusFilter || undefined,
          assigned_to_user_id: targetAssigneeFilter === "" ? undefined : Number(targetAssigneeFilter),
          customer_id: getCustomerId(targetCustomerFilter),
          converted: targetConvertedFilter === "" ? undefined : targetConvertedFilter === "true",
          page: targetPage,
          page_size: PAGE_SIZE,
        });
        if (isActive) {
          setTargetData(response);
          setTargetError("");
        }
      } catch (error: unknown) {
        if (isActive) {
          setTargetError(errorMessage(error, "캠페인 대상 목록을 불러오지 못했습니다."));
        }
      } finally {
        if (isActive) {
          setTargetLoading(false);
        }
      }
    };
    void loadTargets();
    return () => {
      isActive = false;
    };
  }, [selectedCampaignId, targetAssigneeFilter, targetConvertedFilter, targetCustomerFilter, targetPage, targetRefreshKey, targetStatusFilter]);

  useEffect(() => {
    if (selectedCampaignId === null) {
      return;
    }
    let isActive = true;
    const loadEvents = async () => {
      setEventLoading(true);
      try {
        const response = await listCampaignEvents(selectedCampaignId, { page: eventPage, page_size: PAGE_SIZE });
        if (isActive) {
          setEventData(response);
          setEventError("");
        }
      } catch (error: unknown) {
        if (isActive) {
          setEventError(errorMessage(error, "캠페인 이력을 불러오지 못했습니다."));
        }
      } finally {
        if (isActive) {
          setEventLoading(false);
        }
      }
    };
    void loadEvents();
    return () => {
      isActive = false;
    };
  }, [eventPage, selectedCampaignId, targetRefreshKey]);

  useEffect(() => {
    let isActive = true;
    void listTeamMembers()
      .then((members) => {
        if (isActive) {
          setAssignees(members.filter((member) => member.role === "operations" || member.role === "marketing"));
        }
      })
      .catch(() => {
        if (isActive) {
          setAssignees([]);
        }
      });
    return () => {
      isActive = false;
    };
  }, []);

  const updateCampaignInList = (updated: Campaign) => {
    setCampaignData((current) => current === null ? current : {
      ...current,
      items: current.items.map((campaign) => campaign.id === updated.id ? updated : campaign),
    });
  };

  const handleCreateCampaign = async () => {
    setIsSavingCampaign(true);
    setCampaignMessage("");
    try {
      const created = await createCampaign({
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        channel: createForm.channel.trim() || null,
        status: createForm.status,
        start_at: toIsoDate(createForm.start_at),
        end_at: toIsoDate(createForm.end_at),
      });
      setCampaignData((current) => current === null ? {
        items: [created],
        page: 1,
        page_size: PAGE_SIZE,
        total: 1,
        total_pages: 1,
      } : {
        ...current,
        items: [created, ...current.items.filter((campaign) => campaign.id !== created.id)].slice(0, PAGE_SIZE),
        total: current.total + 1,
      });
      selectCampaign(created);
      setCampaignPage(1);
      setCampaignStatusFilter("");
      setCampaignNameFilter("");
      setCreateForm(emptyCampaignForm());
      setShowCreateForm(false);
      setCampaignMessage("캠페인을 생성했습니다.");
    } catch (error: unknown) {
      setCampaignMessage(errorMessage(error, "캠페인 생성에 실패했습니다."));
    } finally {
      setIsSavingCampaign(false);
    }
  };

  const handleUpdateCampaign = async () => {
    if (selectedCampaign === null) {
      return;
    }
    setIsSavingCampaign(true);
    setCampaignMessage("");
    try {
      const updated = await updateCampaign(selectedCampaign.id, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        channel: editForm.channel.trim() || null,
        status: editForm.status,
        start_at: toIsoDate(editForm.start_at),
        end_at: toIsoDate(editForm.end_at),
      });
      updateCampaignInList(updated);
      setEditingCampaign(false);
      setCampaignMessage("캠페인 정보를 저장했습니다.");
      setTargetRefreshKey((current) => current + 1);
    } catch (error: unknown) {
      setCampaignMessage(errorMessage(error, "캠페인 정보 저장에 실패했습니다."));
    } finally {
      setIsSavingCampaign(false);
    }
  };

  const handleTargetDraftChange = (targetId: number, draft: TargetDraft) => {
    setTargetDrafts((current) => ({ ...current, [targetId]: draft }));
  };

  const handleSaveTarget = async (targetId: number) => {
    const target = targetData?.items.find((item) => item.id === targetId);
    if (target === undefined) {
      return;
    }
    const draft = targetDrafts[targetId] ?? getTargetDraft(target);
    setSavingTargetId(targetId);
    setTargetError("");
    try {
      await updateCampaignTarget(targetId, {
        status: draft.status,
        assigned_to_user_id: draft.assigned_to_user_id,
        result: draft.result.trim() || null,
        result_code: draft.result_code || null,
        converted: draft.converted,
      });
      setTargetDrafts((current) => {
        const next = { ...current };
        delete next[targetId];
        return next;
      });
      setTargetRefreshKey((current) => current + 1);
      setCampaignMessage("캠페인 대상 처리를 저장했습니다.");
    } catch (error: unknown) {
      setTargetError(errorMessage(error, "캠페인 대상 처리 저장에 실패했습니다."));
    } finally {
      setSavingTargetId(null);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      onLoggedOut();
    } catch (error: unknown) {
      setLogoutError(errorMessage(error, "로그아웃하지 못했습니다."));
    } finally {
      setIsLoggingOut(false);
    }
  };

  const targetStats = targetData?.stats ?? selectedCampaign?.stats;
  const targetTotalPages = targetData === null ? 0 : Math.max(targetData.total_pages, 1);

  return (
    <main className="campaign-management-layout">
      <header className="campaign-management-header">
        <div>
          <p className="dashboard-eyebrow">CARDOPS CONSOLE / CAMPAIGNS</p>
          <h1>{isReadOnly ? "캠페인 조회" : "캠페인 관리"}</h1>
          <p className="dashboard-subtitle">
            {isReadOnly
              ? "캠페인 현황과 처리 이력을 조회합니다. 변경 작업은 담당 부서에서 수행합니다."
              : "캠페인 실행 기간, 대상 고객, 처리 결과와 변경 이력을 한 곳에서 관리합니다."}
          </p>
        </div>
        <div className="campaign-management-account">
          <button className="campaign-back-button" type="button" onClick={onBack}>분석 대시보드</button>
          <div>
            <strong>{user.display_name}</strong>
            <span>{roleLabels[user.role]}</span>
          </div>
          <button className="dashboard-logout" type="button" onClick={() => void handleLogout()} disabled={isLoggingOut}>
            {isLoggingOut ? "처리 중..." : "로그아웃"}
          </button>
        </div>
      </header>

      {logoutError !== "" && <p className="campaign-management-error" role="alert">{logoutError}</p>}
      {campaignError !== "" && <p className="campaign-management-error" role="alert">{campaignError}</p>}

      {canManageCampaigns && (
        <BulkTargetingPanel
          assignees={assignees}
          onExecuted={() => setCampaignRefreshKey((current) => current + 1)}
        />
      )}

      <section className="campaign-management-grid">
        <aside className="campaign-catalog-panel">
          <div className="campaign-panel-heading">
            <div>
              <p className="card-kicker">CAMPAIGN CATALOG</p>
              <h2>캠페인 목록</h2>
            </div>
            {canManageCampaigns && (
              <button className="campaign-primary-button campaign-primary-button--small" type="button" onClick={() => setShowCreateForm((current) => !current)}>
                {showCreateForm ? "목록 보기" : "+ 새 캠페인"}
              </button>
            )}
          </div>

          {showCreateForm && canManageCampaigns ? (
            <CampaignEditor
              title="새 캠페인 만들기"
              form={createForm}
              submitLabel="캠페인 생성"
              onChange={setCreateForm}
              onSubmit={() => void handleCreateCampaign()}
              onCancel={() => setShowCreateForm(false)}
              isSubmitting={isSavingCampaign}
              isCreate
            />
          ) : (
            <>
              <div className="campaign-catalog-filters">
                <input
                  type="search"
                  value={campaignNameFilter}
                  placeholder="캠페인 이름 검색"
                  aria-label="캠페인 이름 검색"
                  onChange={(event) => {
                    setCampaignNameFilter(event.target.value);
                    setCampaignPage(1);
                  }}
                />
                <select
                  value={campaignStatusFilter}
                  aria-label="캠페인 상태 필터"
                  onChange={(event) => {
                    setCampaignStatusFilter(event.target.value as CampaignLifecycleStatus | "");
                    setCampaignPage(1);
                  }}
                >
                  <option value="">전체 상태</option>
                  {Object.entries(lifecycleLabels).map(([status, label]) => (
                    <option value={status} key={status}>{label}</option>
                  ))}
                </select>
              </div>
              {campaignLoading ? (
                <p className="campaign-empty-copy">캠페인 목록을 불러오는 중입니다.</p>
              ) : campaignData === null || campaignData.items.length === 0 ? (
                <p className="campaign-empty-copy">등록된 캠페인이 없습니다.</p>
              ) : (
                <div className="campaign-catalog-list">
                  {campaignData.items.map((campaign) => (
                    <button
                      className={campaign.id === selectedCampaignId ? "campaign-catalog-item campaign-catalog-item--active" : "campaign-catalog-item"}
                      type="button"
                      key={campaign.id}
                      onClick={() => selectCampaign(campaign)}
                    >
                      <div>
                        <strong>{campaign.name}</strong>
                        <small>{campaign.channel ?? "채널 미지정"} · {formatDate(campaign.created_at)}</small>
                      </div>
                      <span className={`campaign-lifecycle campaign-lifecycle--${campaign.status}`}>{lifecycleLabels[campaign.status]}</span>
                      <div className="campaign-catalog-item__stats">
                        <span>대상 {formatNumber(campaign.stats.total_targets)}</span>
                        <span>전환 {formatNumber(campaign.stats.converted_targets)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {campaignData !== null && campaignData.total > 0 && (
                <div className="campaign-inline-pagination">
                  <span>{formatNumber(campaignData.total)}개 캠페인</span>
                  <div>
                    <button type="button" disabled={campaignPage <= 1} onClick={() => setCampaignPage((current) => current - 1)} aria-label="이전 캠페인 페이지">←</button>
                    <strong>{campaignPage}</strong>
                    <button type="button" disabled={campaignPage >= Math.max(campaignData.total_pages, 1)} onClick={() => setCampaignPage((current) => current + 1)} aria-label="다음 캠페인 페이지">→</button>
                  </div>
                </div>
              )}
            </>
          )}
        </aside>

        <section className="campaign-detail-panel">
          {selectedCampaign === null ? (
            <div className="campaign-detail-empty">
              <span aria-hidden="true">◌</span>
              <h2>캠페인을 선택하세요</h2>
              <p>왼쪽 목록에서 캠페인을 선택하면 대상과 처리 이력을 확인할 수 있습니다.</p>
            </div>
          ) : (
            <>
              <div className="campaign-detail-heading">
                <div>
                  <p className="card-kicker">CAMPAIGN DETAIL · #{selectedCampaign.id}</p>
                  <h2>{selectedCampaign.name}</h2>
                  <p>{selectedCampaign.description ?? "등록된 캠페인 설명이 없습니다."}</p>
                </div>
                <div className="campaign-detail-heading__actions">
                  <span className={`campaign-lifecycle campaign-lifecycle--${selectedCampaign.status}`}>{lifecycleLabels[selectedCampaign.status]}</span>
                  {canManageCampaigns && (
                    <button className="campaign-secondary-button" type="button" onClick={() => setEditingCampaign((current) => !current)}>
                      {editingCampaign ? "상세 보기" : "캠페인 편집"}
                    </button>
                  )}
                </div>
              </div>

              {editingCampaign && canManageCampaigns ? (
                <CampaignEditor
                  title="캠페인 정보 수정"
                  form={editForm}
                  submitLabel="변경사항 저장"
                  onChange={setEditForm}
                  onSubmit={() => void handleUpdateCampaign()}
                  onCancel={() => setEditingCampaign(false)}
                  isSubmitting={isSavingCampaign}
                  statusOptions={lifecycleTransitions[selectedCampaign.status]}
                />
              ) : (
                <>
                  {targetStats && <CampaignStats campaign={{ ...selectedCampaign, stats: targetStats }} />}
                  {campaignMessage !== "" && <p className="campaign-management-message" role="status">{campaignMessage}</p>}

                  <section className="campaign-target-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <p className="card-kicker">TARGET OPERATIONS</p>
                        <h3>캠페인 대상</h3>
                      </div>
                      <span className="campaign-panel-count">{formatNumber(targetData?.total ?? 0)}명</span>
                    </div>
                    <div className="campaign-target-filters">
                      <select
                        value={targetStatusFilter}
                        aria-label="대상 처리 상태 필터"
                        onChange={(event) => {
                          setTargetStatusFilter(event.target.value as CampaignStatus | "");
                          setTargetPage(1);
                        }}
                      >
                        <option value="">전체 처리 상태</option>
                        {Object.entries(targetStatusLabels).map(([status, label]) => (
                          <option value={status} key={status}>{label}</option>
                        ))}
                      </select>
                      <select
                        value={targetAssigneeFilter}
                        aria-label="대상 담당자 필터"
                        onChange={(event) => {
                          setTargetAssigneeFilter(event.target.value);
                          setTargetPage(1);
                        }}
                      >
                        <option value="">전체 담당자</option>
                        {assignees.map((assignee) => (
                          <option value={assignee.id} key={assignee.id}>{assignee.display_name}</option>
                        ))}
                      </select>
                      <input
                        type="search"
                        inputMode="numeric"
                        value={targetCustomerFilter}
                        placeholder="고객 ID"
                        aria-label="대상 고객 ID 필터"
                        onChange={(event) => {
                          setTargetCustomerFilter(event.target.value);
                          setTargetPage(1);
                        }}
                      />
                      <select
                        value={targetConvertedFilter}
                        aria-label="전환 여부 필터"
                        onChange={(event) => {
                          setTargetConvertedFilter(event.target.value as "" | "true" | "false");
                          setTargetPage(1);
                        }}
                      >
                        <option value="">전환 전체</option>
                        <option value="true">전환 완료</option>
                        <option value="false">미전환</option>
                      </select>
                    </div>
                    {targetError !== "" && <p className="campaign-management-error" role="alert">{targetError}</p>}
                    {targetLoading ? (
                      <p className="campaign-empty-copy">캠페인 대상을 불러오는 중입니다.</p>
                    ) : targetData === null || targetData.items.length === 0 ? (
                      <p className="campaign-empty-copy">조건에 맞는 캠페인 대상이 없습니다.</p>
                    ) : (
                      <TargetTable
                        data={targetData}
                        drafts={targetDrafts}
                        assignees={assignees}
                        canProcessTargets={canProcessTargets}
                        onDraftChange={handleTargetDraftChange}
                        onSave={(targetId) => void handleSaveTarget(targetId)}
                        isSaving={savingTargetId}
                      />
                    )}
                    {targetData !== null && targetData.total > 0 && (
                      <div className="campaign-inline-pagination">
                        <span>{formatNumber(targetData.total)}명 중 {targetData.page}페이지</span>
                        <div>
                          <button type="button" disabled={targetPage <= 1} onClick={() => setTargetPage((current) => current - 1)} aria-label="이전 대상 페이지">←</button>
                          <strong>{targetPage}</strong>
                          <button type="button" disabled={targetPage >= targetTotalPages} onClick={() => setTargetPage((current) => current + 1)} aria-label="다음 대상 페이지">→</button>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="campaign-event-panel">
                    <div className="campaign-panel-heading">
                      <div>
                        <p className="card-kicker">AUDIT TRAIL</p>
                        <h3>캠페인 이벤트 이력</h3>
                      </div>
                      {eventLoading && <span className="campaign-loading-label">불러오는 중...</span>}
                    </div>
                    {eventError !== "" && <p className="campaign-management-error" role="alert">{eventError}</p>}
                    <EventTimeline data={eventData} page={eventPage} onPageChange={setEventPage} />
                  </section>
                </>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  );
}
