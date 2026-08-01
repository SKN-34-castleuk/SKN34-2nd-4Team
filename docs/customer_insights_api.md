# customer_insights 조회 API

## 목적

로그인한 사용자가 고객별 최신 분석 스냅샷을 조회할 수 있도록 제공하는
Backend API입니다. 같은 고객의 과거 분석 결과가 여러 건 있어도 가장 최근
`scored_at` 결과 하나만 반환합니다.

모든 경로는 HttpOnly JWT 인증 쿠키가 필요합니다. 현재는 로그인한 모든 활성
사용자가 조회할 수 있으며, 역할별 접근 제한은 권한 기능 구현 단계에서 추가합니다.

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

## 인증과 오류

| 상태 코드 | 상황 |
|---|---|
| `200` | 조회 성공 |
| `401` | 인증 쿠키 없음·만료·비활성 사용자 |
| `404` | 해당 고객의 최신 분석 결과 없음 |
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

