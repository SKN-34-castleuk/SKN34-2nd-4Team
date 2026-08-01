# customer_insights 조회 API

## 목적

로그인한 사용자가 고객별 최신 분석 스냅샷을 조회할 수 있도록 제공하는
Backend API입니다. 같은 고객의 과거 분석 결과가 여러 건 있어도 가장 최근
`scored_at` 결과 하나만 반환합니다.

모든 경로는 HttpOnly JWT 인증 쿠키가 필요합니다. 분석 결과·이력·배치 상태는
모든 활성 사용자가 조회할 수 있습니다. 캠페인 대상 등록·수정은 `admin`,
`operations`, `marketing` 역할만 수행할 수 있고 `analyst`는 읽기 전용입니다.

활성 팀 계정 목록은 다음 경로에서 조회합니다. 운영·마케팅 화면은 이 목록을
캠페인 담당자 선택에 사용하며, 관리자만 비활성 계정까지 포함할 수 있습니다.

~~~http
GET /api/v1/auth/users
~~~

표시 이름, 아이디, 역할과 활성 상태를 반환하며, 비밀번호 해시는 반환하지
않습니다. `include_inactive=true`는 관리자 외 역할에서 `403 Forbidden`을 반환합니다.

관리자는 다음 경로로 역할과 계정 활성 상태를 변경할 수 있습니다.

~~~http
PATCH /api/v1/auth/users/{user_id}
Content-Type: application/json

{
  "role": "marketing",
  "is_active": true
}
~~~

자기 계정 비활성화는 차단하며, 활성 관리자가 한 명뿐인 경우 마지막 관리자
권한 제거·비활성화도 차단합니다.

## 목록 조회

~~~http
GET /api/v1/customer-insights
~~~

### Query 파라미터

| 파라미터 | 기본값 | 설명 |
|---|---:|---|
| `risk_level` | 없음 | `low`, `medium`, `high` |
| `cluster_name` | 없음 | 예: `우선케어(거래 감소)` |
| `customer_id` | 없음 | 고객 ID 정확히 검색 |
| `sort_by` | `churn_probability` | `churn_probability`, `activity_gap`, `scored_at` |
| `sort_order` | `desc` | `asc`, `desc` |
| `page` | `1` | 1 이상의 페이지 번호 |
| `page_size` | `50` | 1~100 |

예시:

~~~bash
curl -b cookies.txt \
  'http://127.0.0.1:8000/api/v1/customer-insights?risk_level=high&page=1&page_size=20'
~~~

### 응답 구조

~~~json
{
  "items": [
    {
      "id": 1,
      "customer_id": 123456789,
      "classification_run_id": 1,
      "regression_run_id": 2,
      "clustering_run_id": 3,
      "churn_probability": 0.91,
      "risk_level": "high",
      "expected_transaction_count": 42.5,
      "activity_gap": -18.5,
      "cluster_name": "우선케어(거래 감소)",
      "cluster_confidence": 0.88,
      "recommended_action": "이탈 위험 우선 상담 및 거래 활성화 혜택",
      "reason_codes": ["transaction_decline", "below_expected_activity"],
      "scored_at": "2026-08-01T08:00:00"
    }
  ],
  "page": 1,
  "page_size": 20,
  "total": 1519,
  "total_pages": 76,
  "stats": {
    "total": 1519,
    "average_churn_probability": 0.91,
    "risk_counts": {
      "high": 1519
    },
    "cluster_counts": {
      "우선케어(거래 감소)": 1519
    }
  }
}
~~~

`stats`는 현재 필터가 적용된 전체 결과를 기준으로 계산되므로 대시보드의
요약 카드와 차트에 사용할 수 있습니다.

## 고객 상세 조회

~~~http
GET /api/v1/customer-insights/{customer_id}
~~~

상세 응답은 목록 항목에 다음 `customer` 객체를 추가합니다.

- 고객 ID
- 19개 모델 입력 특성
- 고객 생성·수정 시각
- 최신 분석 결과와 세 모델 실행 ID

분석 결과가 없는 고객은 `404 Not Found`를 반환합니다.

## 고객 분석 이력

~~~http
GET /api/v1/customer-insights/history/{customer_id}?limit=24
~~~

한 고객의 분석 스냅샷을 최신순으로 반환합니다. 같은 고객의 이탈 확률,
활동성 갭, 군집 결과가 시간에 따라 어떻게 바뀌었는지 상세 패널의 이력
영역에서 확인할 때 사용합니다. `limit`은 1~100 사이입니다.

## 최신 모델 배치 상태

~~~http
GET /api/v1/model-runs/latest
~~~

분류·회귀·군집별 가장 최근 성공 실행을 하나의 배치로 묶어 반환합니다.
대시보드는 데이터 갱신 시각, 처리 행 수, 모델 버전을 표시합니다. 성공한
실행 이력이 없으면 `404 Not Found`를 반환합니다.

## 캠페인 대상 업무 API

### 목록 조회

~~~http
GET /api/v1/campaign-targets?status=pending&page=1&page_size=20
~~~

캠페인 대상, 담당자, 처리 상태, 처리 일시와 결과를 반환합니다. `status`는
`pending`, `assigned`, `contacted`, `completed`, `cancelled` 중 하나입니다.

### 대상 등록

~~~http
POST /api/v1/campaign-targets
Content-Type: application/json

{
  "customer_insight_id": 42,
  "campaign_name": "이탈 위험 리텐션",
  "assigned_to_user_id": 7
}
~~~

같은 분석 스냅샷과 캠페인 이름 조합은 중복 등록할 수 없습니다. 담당자를
지정하면 초기 상태는 `assigned`, 지정하지 않으면 `pending`입니다.

### 처리 결과 수정

~~~http
PATCH /api/v1/campaign-targets/{target_id}
Content-Type: application/json

{
  "status": "completed",
  "result": "혜택 안내 완료",
  "result_notes": "앱 푸시 발송 후 상담 완료"
}
~~~

`contacted`, `completed`, `cancelled`로 상태를 변경하면 `processed_at`이
자동으로 기록됩니다. `pending` 또는 `assigned`로 되돌리면 처리 시각이
초기화됩니다.

## 인증과 오류

| 상태 코드 | 상황 |
|---|---|
| `200` | 조회 성공 |
| `401` | 인증 쿠키 없음·만료·비활성 사용자 |
| `404` | 해당 고객의 최신 분석 결과 없음 |
| `403` | 캠페인 등록·수정 권한 없음 |
| `409` | 같은 캠페인 대상이 이미 등록됨 |
| `422` | 잘못된 필터·페이지·정렬 파라미터 |
| `503` | DB가 설정되지 않음 |

## 대시보드 사용 예

대시보드는 다음 요청으로 초기 데이터를 가져올 수 있습니다.

~~~ts
const response = await fetch(
  "/api/v1/customer-insights?sort_by=churn_probability&sort_order=desc&page_size=50",
  { credentials: "include" },
);
const data = await response.json();
~~~

목록에서 고객을 선택하면 `/api/v1/customer-insights/{customer_id}`를 호출해
상세 패널을 구성합니다.
