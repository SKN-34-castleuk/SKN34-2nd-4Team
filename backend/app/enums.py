"""데이터베이스와 API에서 공통으로 사용하는 제한된 상태값입니다."""

from enum import Enum


class UserRole(str, Enum):
    """CardOps 팀 사용자의 업무 역할입니다."""

    ADMIN = "admin"
    ANALYST = "analyst"
    OPERATIONS = "operations"
    MARKETING = "marketing"


class ModelRunStatus(str, Enum):
    """모델 배치 실행의 처리 상태입니다."""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class RiskLevel(str, Enum):
    """고객 이탈 위험 등급입니다."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class CampaignStatus(str, Enum):
    """캠페인 대상 고객의 업무 처리 상태입니다."""

    PENDING = "pending"
    ASSIGNED = "assigned"
    CONTACTED = "contacted"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class CampaignLifecycleStatus(str, Enum):
    """캠페인 자체의 실행 생명주기 상태입니다."""

    DRAFT = "draft"
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class CampaignEventType(str, Enum):
    """캠페인·대상 업무 이력의 이벤트 종류입니다."""

    CREATED = "created"
    STATUS_CHANGED = "status_changed"
    ASSIGNED = "assigned"
    RESULT_UPDATED = "result_updated"
    CONVERSION_UPDATED = "conversion_updated"


class CampaignResultCode(str, Enum):
    """캠페인 접촉 결과를 집계 가능한 코드로 표준화합니다."""

    CONVERTED = "converted"
    NOT_CONVERTED = "not_converted"
    NO_RESPONSE = "no_response"
    DECLINED = "declined"
    INVALID_CONTACT = "invalid_contact"
