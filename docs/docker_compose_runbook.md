# Docker Compose 실행 가이드

이 문서는 현재 CardOps Docker Compose 구성의 실행 순서와 자동화 동작을 설명합니다.

## 구성

`compose.yaml`은 다음 서비스를 실행합니다.

| 서비스 | 역할 | 상태 |
| --- | --- | --- |
| `mysql` | 회원·고객·분석 결과 저장 | 계속 실행 |
| `model-builder` | 최종 분류·회귀·군집 모델 생성 | 작업 후 `Exited (0)` |
| `backend` | FastAPI API와 모델 추론 | 계속 실행 |
| `frontend` | React/Vite 화면 | 계속 실행 |

모델 생성 순서는 다음과 같습니다.

```text
src/classification.py
  → src/final/classification_final.py
  → classification_manifest.json 갱신
  → src/final/regression_final.py
  → src/final/clustering_final.py
  → Backend 시작
```

`outputs/`는 호스트 디렉터리를 컨테이너에 마운트합니다. 따라서 생성된 모델과
manifest는 Docker 이미지에 포함되지 않고 프로젝트의 `outputs/models/`에 남습니다.

## 최초 실행 및 재실행

Docker Desktop을 실행한 뒤 프로젝트 루트에서 실행합니다.

```powershell
docker compose up -d --build
docker compose ps -a
```

정상 상태는 다음과 같습니다.

```text
mysql           Up (healthy)
model-builder   Exited (0)
backend         Up
frontend        Up
```

`model-builder`는 모델 생성이 끝나면 종료되는 일회성 서비스입니다. `Exited (0)`은
오류가 아니라 성공 종료입니다. 모델 파일이 이미 존재하면 다음 메시지와 함께 학습을
건너뜁니다.

```text
Final model artifacts already exist; skipping model training.
```

컨테이너만 다시 시작할 때는 named volume의 MySQL 데이터가 유지됩니다.

```powershell
docker compose down
docker compose up -d --build
```

`docker compose down -v`는 MySQL 회원·고객 데이터를 삭제하므로 DB를 초기화할 때만
사용합니다.

## 모델 강제 재학습

모델 코드나 원본 데이터가 변경되어 최종 모델을 다시 만들 때 사용합니다.

```powershell
$env:FORCE_MODEL_REBUILD = "true"
docker compose up -d --build --force-recreate
Remove-Item Env:FORCE_MODEL_REBUILD
```

강제 재학습이 끝나면 Backend가 새 `classification_manifest.json`을 읽고 최종
분류 모델을 사용합니다. 모델 생성은 OOF 예측을 포함하므로 수 분이 걸릴 수 있습니다.

## 고객 데이터 적재와 분석 배치

모델 생성과 서버 시작 후 고객 원본 데이터를 적재합니다. `CLIENTNUM` 기준 upsert라
반복 실행해도 고객이 중복 생성되지 않습니다.

```powershell
docker compose exec backend python -m backend.scripts.import_customers
docker compose exec backend python -m backend.scripts.run_analysis_batch
```

새 모델로 분석 이력을 다시 만들려면 `--force`를 사용합니다.

```powershell
docker compose exec backend python -m backend.scripts.run_analysis_batch --force
```

## 테스트 계정

로컬 개발 Compose에서는 테스트 계정이 Backend 시작 시 migration 후 자동으로 upsert됩니다.
테스트 계정용 비밀번호는 Compose 기본값으로 제공되므로 `TEST_*_PASSWORD`를 `.env`에
작성하지 않아도 됩니다.

| 아이디 | 기본 비밀번호 | 역할 |
| --- | --- | --- |
| `test_admin` | `CardOpsAdmin2026!` | 관리자 |
| `test_analyst` | `CardOpsAnalyst2026!` | 분석 |
| `test_operations` | `CardOpsOps2026!` | 운영 |
| `test_marketing` | `CardOpsMarketing2026!` | 마케팅 |

`ALLOW_TEST_USER_SEEDING=false`를 명시하면 자동 생성을 끌 수 있습니다. 테스트 계정은
로컬 개발 DB에서만 사용하고 운영 환경에서는 반드시 비활성화합니다.

## 접속 주소와 로그

- Frontend: <http://localhost:5173>
- FastAPI Swagger: <http://localhost:8000/docs>
- Liveness: <http://localhost:8000/live>
- Readiness: <http://localhost:8000/ready>

```powershell
docker compose logs -f model-builder
docker compose logs -f backend
docker compose logs -f frontend
```

Backend가 재시작하면 먼저 다음 명령으로 원인을 확인합니다.

```powershell
docker compose ps -a
docker compose logs backend --tail=100
```

Docker Backend 내부의 MySQL 주소는 `mysql:3306`이며, 호스트에서 직접 접속할 때의
기본 포트는 `127.0.0.1:3307`입니다.
