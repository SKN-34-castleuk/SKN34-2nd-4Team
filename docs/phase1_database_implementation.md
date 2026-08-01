# 1단계 구현 문서: 고객 데이터와 분석 결과 저장 기반

## 1. 문서 목적

이 문서는 CardOps 프로젝트에 구현된 다음 기능의 구조와 사용법을 설명합니다.

- SQLAlchemy 기반 업무 데이터 모델
- Alembic migration을 이용한 MySQL 스키마 버전 관리
- 기존 users 회원 데이터를 보존하는 migration 도입
- 원본 고객 CSV의 CLIENTNUM과 19개 고객 특성 적재
- 모델 실행 이력·고객 분석·캠페인 결과를 저장하기 위한 테이블
- Docker Compose 시작 시 자동 migration
- Backend와 Frontend 인증 응답의 사용자 역할(role) 반영

이번 문서는 저장 기반을 처음 도입한 1단계 구현을 설명합니다. 이후 2단계에서
분류·회귀·군집 모델을 실행해 `model_runs`와 `customer_insights`를 채우는 배치도
구현했습니다. 배치의 상세 사용법과 실제 검증 결과는
[`phase2_analysis_batch.md`](phase2_analysis_batch.md)를 참고하세요.

## 2. 구현 범위와 현재 상태

~~~text
Docker Compose 시작
        │
        ▼
Backend entrypoint
        │
        ├─ migration_runner
        │      └─ Alembic upgrade head
        │
        └─ Uvicorn/FastAPI 시작

원본 BankChurners.csv
        │
        ▼
import_customers 명령
        │
        ├─ CLIENTNUM 기준 upsert
                   │
                   ▼
               customers

모델 배치
        │
        ├─ model_runs
        ├─ customer_insights
        └─ campaign_targets
~~~

최근 Docker MySQL에 적용한 검증 상태는 다음과 같습니다.

| 항목 | 상태 |
|---|---|
| Alembic revision | 20260801_0002 |
| 기존 사용자 | 1명 보존 |
| 기존 사용자 역할 | operations |
| customers 행 수 | 10,127 |
| customers.customer_id 중복 | 없음 |
| model_runs | 성공 3건 |
| customer_insights | 10,127건 |
| campaign_targets | 0건 |

`campaign_targets`가 0건인 것은 오류가 아닙니다. 분석 결과를 캠페인 대상으로
전환하는 후속 운영 기능이 아직 자동 실행되지 않기 때문입니다. 모델 배치의
재실행은 동일 artifact·데이터 조합이면 기존 스냅샷을 재사용합니다.

## 3. 관련 파일

| 파일 | 역할 |
|---|---|
| backend/alembic.ini | Alembic 스크립트 위치와 기본 설정 |
| backend/migrations/env.py | SQLAlchemy metadata와 DB 연결을 Alembic에 연결 |
| backend/migrations/versions/20260801_0001_users_baseline.py | 기존 users 구조의 기준선 revision |
| backend/migrations/versions/20260801_0002_customer_operations.py | 역할·고객·분석·캠페인 테이블 생성 |
| backend/app/database.py | DB 엔진·세션 생성 및 migration 여부 검증 |
| backend/app/models.py | SQLAlchemy 모델 전체 정의 |
| backend/app/enums.py | 역할·상태·위험등급 상수 정의 |
| backend/app/migration_runner.py | 기존 DB 호환 처리와 upgrade head 실행 |
| backend/app/customer_import.py | CSV 검증, 변환, MySQL/SQLite upsert |
| backend/scripts/import_customers.py | 고객 적재 CLI 진입점 |
| backend/app/analysis_batch.py | 세 모델 실행과 customer_insights 저장 |
| backend/scripts/run_analysis_batch.py | 모델 분석 배치 CLI 진입점 |
| backend/docker-entrypoint.sh | 컨테이너 시작 시 migration 후 API 실행 |
| compose.yaml | MySQL·Backend·Frontend 연결과 data 읽기 전용 mount |
| backend/tests/test_persistence.py | migration·기존 회원·적재·관계 검증 |

## 4. 데이터베이스 구조

~~~mermaid
erDiagram
    USERS ||--o{ CAMPAIGN_TARGETS : assigns
    CUSTOMERS ||--o{ CUSTOMER_INSIGHTS : receives
    CUSTOMERS ||--o{ CAMPAIGN_TARGETS : targets
    MODEL_RUNS ||--o{ CUSTOMER_INSIGHTS : classifies
    MODEL_RUNS ||--o{ CUSTOMER_INSIGHTS : regresses
    MODEL_RUNS ||--o{ CUSTOMER_INSIGHTS : clusters
    CUSTOMER_INSIGHTS ||--o{ CAMPAIGN_TARGETS : recommends
~~~

### 4.1 users

기존 회원가입·로그인 계정 테이블입니다. 비밀번호 원문은 저장하지 않고
Argon2 해시만 저장합니다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INT | 기본키, 자동 증가 |
| username | VARCHAR(50) | 로그인 ID, unique |
| display_name | VARCHAR(100) | 표시 이름 |
| password_hash | VARCHAR(255) | Argon2 비밀번호 해시 |
| role | VARCHAR(20) | admin, analyst, operations, marketing |
| is_active | BOOLEAN | 계정 활성 여부 |
| created_at | DATETIME | 생성 시각 |
| updated_at | DATETIME | 수정 시각 |

회원가입 요청에서는 role을 받지 않습니다. 신규 계정은 항상 operations로 생성됩니다.
사용자가 직접 회원가입하면서 관리자 권한을 얻는 상황을 방지하기 위한 정책입니다.
역할 변경 API와 역할별 접근 제어는 후속 구현 대상입니다.

### 4.2 customers

원본 BankChurners.csv에서 모델 입력으로 사용할 고객 식별자와 19개 특성을
저장합니다. 모델 정제 데이터에서 제거한 CLIENTNUM은 서비스에서 고객을 조회하고
다른 테이블과 연결하기 위해 customer_id로 보존합니다.

| DB 컬럼 | 원본 컬럼 | 설명 |
|---|---|---|
| customer_id | CLIENTNUM | 고객 업무 식별자, 기본키 |
| customer_age | Customer_Age | 고객 연령 |
| gender | Gender | 성별 |
| dependent_count | Dependent_count | 부양가족 수 |
| education_level | Education_Level | 교육 수준 |
| marital_status | Marital_Status | 결혼 상태 |
| income_category | Income_Category | 소득 구간 |
| card_category | Card_Category | 카드 등급 |
| months_on_book | Months_on_book | 카드 이용 기간 |
| total_relationship_count | Total_Relationship_Count | 보유 관계 상품 수 |
| months_inactive_12_mon | Months_Inactive_12_mon | 최근 12개월 비활성 개월 수 |
| contacts_count_12_mon | Contacts_Count_12_mon | 최근 12개월 문의 횟수 |
| credit_limit | Credit_Limit | 신용 한도 |
| total_revolving_bal | Total_Revolving_Bal | 리볼빙 잔액 |
| avg_open_to_buy | Avg_Open_To_Buy | 평균 사용 가능 한도 |
| total_amt_chng_q4_q1 | Total_Amt_Chng_Q4_Q1 | 거래금액 변화율 |
| total_trans_amt | Total_Trans_Amt | 총 거래금액 |
| total_trans_ct | Total_Trans_Ct | 총 거래건수 |
| total_ct_chng_q4_q1 | Total_Ct_Chng_Q4_Q1 | 거래건수 변화율 |
| avg_utilization_ratio | Avg_Utilization_Ratio | 평균 이용률 |
| created_at, updated_at | - | 적재·수정 시각 |

다음 컬럼은 customers에 저장하지 않습니다.

- Attrition_Flag: 모델 학습 정답인 Target은 운영 고객 정보와 분리합니다.
- Naive_Bayes_Classifier_...: 원본에 포함된 기존 모델 결과이므로 제외합니다.

즉 customer_id는 조회용 식별자이고, 모델 입력 19개에는 포함되지 않습니다.

### 4.3 model_runs

모델 파일과 배치 실행의 계보를 보존합니다. 같은 모델 버전을 여러 번 실행해도
실행별 행을 남길 수 있습니다.

| 컬럼 | 설명 |
|---|---|
| id | 모델 실행 기본키 |
| task | classification, regression, clustering 등 작업명 |
| model_name | 예: xgboost, voting, activity-gap-gmm |
| model_version | 모델 manifest 버전 또는 실행 식별자 |
| artifact_path | 사용한 모델 파일 경로 |
| artifact_sha256 | 모델 파일 무결성 해시 |
| dataset_sha256 | 사용 데이터셋 해시, 선택값 |
| status | running, succeeded, failed |
| processed_rows | 처리한 고객 수 |
| error_message | 실패 시 오류 내용 |
| started_at | 실행 시작 시각 |
| completed_at | 실행 종료 시각 |
| created_at | 실행 레코드 생성 시각 |

artifact_sha256는 현재 모델 manifest의 파일 무결성 검증 방식과 연결됩니다.
향후 모델 배치가 실패해도 failed 상태와 오류를 남길 수 있습니다.

### 4.4 customer_insights

고객별 분류·회귀·군집 결과를 하나의 분석 스냅샷으로 저장합니다. 고객 한 명의
결과를 매번 덮어쓰지 않고 scored_at을 기준으로 분석 이력을 누적할 수 있도록
설계했습니다.

| 컬럼 | 설명 |
|---|---|
| id | 분석 스냅샷 기본키 |
| customer_id | customers.customer_id 외래키 |
| classification_run_id | 이탈 분류 모델 실행 외래키 |
| regression_run_id | 거래건수 회귀 모델 실행 외래키 |
| clustering_run_id | 활동성 군집 모델 실행 외래키 |
| churn_probability | 이탈 확률, 0~1 |
| risk_level | low, medium, high |
| expected_transaction_count | 모델이 예상한 거래건수 |
| activity_gap | 실제 거래건수 - 예상 거래건수 |
| cluster_name | 우선케어·일반관리·우량 등 비즈니스 이름 |
| cluster_confidence | 군집 소속 확률 또는 신뢰도 |
| recommended_action | 추천 대응 문구 |
| reason_codes | 영향 요인 코드 JSON |
| scored_at | 분석 계산 시각 |
| created_at | 저장 시각 |

세 개의 model_run_id를 각각 보존하는 이유는 분류 모델만 교체되거나 회귀
모델만 다시 계산된 경우에도 어떤 산출물을 조합했는지 확인하기 위해서입니다.

### 4.5 campaign_targets

분석 결과에서 추천된 캠페인 대상과 실제 업무 처리 결과를 저장합니다.

| 컬럼 | 설명 |
|---|---|
| id | 캠페인 대상 기본키 |
| customer_id | 대상 고객 외래키 |
| customer_insight_id | 추천 근거가 된 분석 스냅샷 외래키 |
| campaign_name | 예: 이탈 위험 리텐션 |
| assigned_to_user_id | 담당자, users.id 외래키 |
| status | pending, assigned, contacted, completed, cancelled |
| processed_at | 처리 완료 또는 마지막 처리 시각 |
| result | 상담·캠페인 결과 |
| result_notes | 상세 메모 |
| created_at, updated_at | 생성·수정 시각 |

같은 분석 스냅샷에 같은 캠페인을 중복 생성하지 않도록
customer_insight_id + campaign_name 조합에 unique 제약을 둡니다.

## 5. Alembic migration 동작

### 5.1 새 DB

빈 MySQL 또는 SQLite DB에서 migration을 실행하면 다음 순서로 적용됩니다.

~~~text
20260801_0001_users_baseline
        │
        ▼
20260801_0002_customer_operations
~~~

첫 번째 revision은 users 기준선 테이블을 만들고, 두 번째 revision은
users.role과 나머지 업무 테이블을 추가합니다.

### 5.2 기존 DB

기존 프로젝트는 Alembic 도입 전에 Base.metadata.create_all()로 users만
생성하고 있었습니다. 이 DB에 새 migration을 바로 적용하면 첫 revision이
이미 존재하는 users를 다시 만들려고 할 수 있습니다.

backend.app.migration_runner는 다음 방식으로 이를 처리합니다.

1. alembic_version의 현재 revision을 확인합니다.
2. revision이 없고 users가 있으면 기존 필수 컬럼을 확인합니다.
3. 기존 users 데이터가 정상인 경우 20260801_0001을 기준선으로 stamp합니다.
4. 20260801_0002를 upgrade해 role과 신규 테이블을 추가합니다.
5. 기존 회원 데이터는 삭제하거나 재생성하지 않습니다.

이미 신규 관리 테이블이 일부만 존재하는 비정상 상태라면 자동으로 진행하지 않고
오류를 발생시킵니다. 이런 경우에는 DB 백업과 현재 revision을 확인한 뒤 수동으로
복구해야 합니다.

### 5.3 FastAPI 시작 전 검증

initialize_database()는 더 이상 Base.metadata.create_all()을 호출하지 않습니다.
대신 다음을 확인합니다.

- alembic_version 테이블 존재 여부
- SQLAlchemy 모델에 등록된 필수 테이블 존재 여부

조건을 만족하지 않으면 API를 준비 상태로 띄우지 않고 migration 실행 명령을
안내하는 오류를 발생시킵니다. 이를 통해 모델만 바꾸고 DB migration을 빠뜨리는
상황을 조기에 확인할 수 있습니다.

## 6. 실행 방법

### 6.1 Docker Compose

프로젝트 루트에서 실행합니다.

~~~bash
cp .env.example .env
docker compose up -d --build
docker compose ps
~~~

Backend 컨테이너의 docker-entrypoint.sh가 다음 순서로 실행됩니다.

~~~text
python -m backend.app.migration_runner
        │
        ▼
alembic upgrade head
        │
        ▼
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
~~~

고객 CSV는 compose.yaml의 다음 읽기 전용 mount로 컨테이너에 전달됩니다.

~~~yaml
- ./data:/app/data:ro
~~~

서비스 시작 후 고객을 적재합니다.

~~~bash
docker compose exec backend python -m backend.scripts.import_customers
~~~

### 6.2 호스트에서 Backend 실행

호스트에서 실행하는 경우 .env의 DATABASE_URL은 127.0.0.1:3307을
사용해야 합니다.

~~~bash
source project_venv/bin/activate
python -m backend.app.migration_runner
python -m backend.scripts.import_customers
python -m uvicorn backend.app.main:app --reload
~~~

호스트에서 실행하는 FastAPI는 Docker 내부 주소인 mysql:3306에 접근할 수
없습니다. 반대로 Docker Backend는 127.0.0.1:3307이 아니라 Compose 서비스명인
mysql:3306을 사용합니다.

### 6.3 Alembic 상태 확인

~~~bash
alembic -c backend/alembic.ini current
alembic -c backend/alembic.ini history
alembic -c backend/alembic.ini check
~~~

가상환경의 실행 파일을 직접 사용할 수도 있습니다.

~~~bash
project_venv/bin/alembic -c backend/alembic.ini current
~~~

check 결과가 No new upgrade operations detected.이면 현재 SQLAlchemy 모델과
DB migration 상태가 일치한다는 의미입니다.

## 7. 고객 CSV 적재 규칙

### 입력 파일

기본 입력 경로는 다음과 같습니다.

~~~text
data/raw/BankChurners.csv
~~~

필수 컬럼은 CLIENTNUM과 모델 입력 19개입니다. Attrition_Flag와
Naive Bayes 결과 컬럼은 읽지만 저장하지 않습니다.

### 변환

- 원본 대문자 컬럼을 DB snake_case 컬럼으로 변환합니다.
- 정수형 특성은 int로 변환합니다.
- 금액·비율 특성은 float으로 변환합니다.
- 필수 컬럼 누락, 빈 값, 잘못된 숫자, 중복 CLIENTNUM을 거부합니다.
- customer_id를 기본키로 사용합니다.

### 중복 처리

customer_import.py는 DB dialect에 따라 upsert를 사용합니다.

- MySQL: ON DUPLICATE KEY UPDATE
- SQLite: ON CONFLICT DO UPDATE
- 기타 DB: SQLAlchemy merge

따라서 다음 명령을 여러 번 실행해도 고객 행이 계속 증가하지 않습니다.

~~~bash
docker compose exec backend python -m backend.scripts.import_customers
~~~

출력 예시는 다음과 같습니다.

~~~text
Customer import complete: processed=10127, inserted=10127, updated=0, total=10127
~~~

재실행하면 inserted=0, updated=10127이 되며 총 고객 수는 10,127명으로
유지됩니다.

## 8. 테스트와 검증

Persistence 테스트는 다음을 검증합니다.

- 빈 SQLite DB를 최신 migration까지 생성
- 기존 users 테이블과 회원 보존
- users.role 기본값 operations
- 원본 CSV 10,127행 파싱
- 고객 upsert 재실행 시 중복 방지
- 세 model_runs와 하나의 customer_insight 연결
- 캠페인 담당자와 분석 lineage 관계 저장

실행 명령:

~~~bash
project_venv/bin/python -m pytest backend/tests -q
~~~

현재 구현 검증 결과는 Backend 테스트 24개 통과입니다. Frontend 인증 타입과
OpenAPI 생성 타입도 role 필드를 포함하도록 갱신했으며 Frontend lint,
typecheck, test, build를 통과했습니다.

## 9. 운영 및 보안 주의사항

- .env에는 DB 비밀번호와 JWT secret이 있으므로 커밋하지 않습니다.
- 회원 비밀번호 원문은 어떤 테이블에도 저장하지 않습니다.
- CLIENTNUM은 모델 입력으로 사용하지 않습니다.
- Attrition_Flag/Target은 운영 캠페인 규칙의 입력으로 사용하지 않습니다.
- 모델 artifact 경로와 SHA-256은 model_runs에 기록해 실행 결과를 추적합니다.
- docker compose down -v는 MySQL named volume을 삭제하므로 회원·고객 데이터를
  지울 때만 사용합니다.
- 실제 운영 DB에는 migration 전 백업과 migration 후 alembic check를 권장합니다.

## 10. 다음 구현 단계

현재 저장 기반 위에 다음 순서로 기능을 추가합니다.

1. customers와 최신 customer_insights 조회 API를 추가합니다.
2. 우선관리 고객 목록·상세 화면을 Frontend에 추가합니다.
3. 추천 캠페인을 campaign_targets에 생성하고 담당자·처리 결과를 저장합니다.
4. users.role을 기준으로 관리자·분석·운영·마케팅 API 권한을 적용합니다.
