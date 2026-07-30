# 신용카드 고객 이탈 예측 프로젝트

Kaggle의 `Credit Card Customers` 데이터를 활용해 고객 이탈 위험을 예측하고,
거래 활동성과 고객 행동 유형을 함께 분석하는 머신러닝 프로젝트입니다.

## 분석 목표

1. **분류**: 고객별 이탈 확률을 예측합니다.
2. **회귀**: 고객 프로필 대비 기대 거래건수를 추정해 활동성 격차를 확인합니다.
3. **군집**: 행동 특성이 유사한 고객을 묶어 군집별 유지 전략을 설계합니다.
4. **의사결정 지원**: 이탈 위험도, 활동성, 고객 유형을 결합해 관리 우선순위를 제안합니다.

## 저장소 구조

```text
SKN34-2nd-4Team/
├── README.md
├── requirements.txt
├── data/
│   ├── README.md
│   ├── raw/
│   │   └── BankChurners.csv
│   └── processed/
│       └── bankchurners_clean.csv
├── docs/
│   └── guides/
│       └── git_upstream_push_pr_guide.pdf
├── notebooks/
│   ├── 00_project_roadmap.ipynb
│   ├── 01_data_load_clean.ipynb
│   ├── 02_eda.ipynb
│   ├── 03_classification.ipynb
│   ├── 04_regression.ipynb
│   └── 05_clustering.ipynb
├── backend/
│   ├── app/
│   │   ├── config.py
│   │   ├── main.py
│   │   ├── model_manifest.py
│   │   ├── model_registry.py
│   │   └── schemas.py
│   ├── tests/
│   │   └── test_api.py
│   ├── README.md
│   ├── requirements.txt
│   └── requirements-dev.txt
├── dashboard/
│   └── app.py
├── src/
│   ├── README.md
│   ├── classification.py
│   ├── regression.py
│   └── clustering.py
└── outputs/
    └── README.md
```

Git의 `upstream` 설정부터 커밋, 포크 저장소 푸시, Pull Request 생성까지의 과정은
[`docs/guides/git_upstream_push_pr_guide.pdf`](docs/guides/git_upstream_push_pr_guide.pdf)에서 확인할 수 있습니다.

## 실행 순서

노트북은 `notebooks/` 디렉터리를 작업 디렉터리로 사용합니다.

```bash
python -m venv project_venv
source project_venv/bin/activate
pip install -r requirements.txt
cd notebooks
jupyter lab
```

아래 순서로 실행합니다.

1. `01_data_load_clean.ipynb`
2. `02_eda.ipynb`
3. `03_classification.ipynb`
4. `04_regression.ipynb`
5. `05_clustering.ipynb`

`00_project_roadmap.ipynb`는 역할 분담과 실행 계획을 정리한 문서입니다.

## 모델 코드 실행

노트북의 모델링 내용을 공부하기 쉬운 독립 Python 파일로 분리했습니다.

```bash
source project_venv/bin/activate

python src/classification.py
python src/regression.py
python src/clustering.py
```

학습 모델은 `outputs/models/`, 평가 결과는 `outputs/reports/`에 저장됩니다.
코드 구성과 모델별 입력 변수는 `src/README.md`에서 확인할 수 있습니다.

## FastAPI 백엔드 실행

분류 모델을 학습한 뒤 프로젝트 루트에서 FastAPI 서버를 실행합니다.

```powershell
.\project_venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
.\project_venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload
```

기본 주소는 `http://127.0.0.1:8000`이며 다음 API를 제공합니다.

- `GET /live`: API 프로세스 생존 여부 확인
- `GET /ready`: 모델 적재 상태 확인
- `POST /api/v1/predictions`: 고객 한 명의 이탈 상태와 확률 예측
- `GET /docs`: Swagger UI

백엔드의 파일별 책임, 모델 적재 흐름, 19개 입력 필드, React 연결, 테스트와
오류 해결 방법은 [`backend/README.md`](backend/README.md)에서 확인할 수
있습니다.

## 성능 대시보드 실행

세 모델 코드를 실행해 최신 결과를 만든 뒤 Streamlit 대시보드를 실행합니다.

```bash
source project_venv/bin/activate

python src/classification.py
python src/regression.py
python src/clustering.py

streamlit run dashboard/app.py
```

대시보드에서는 다음 내용을 확인할 수 있습니다.

- 분류: Train/Test 성능과 과적합 점검, 혼동행렬, ROC 곡선
- 회귀: Train/Test 성능과 과적합 점검, 실제값과 예측값, 잔차 분포
- 군집: Silhouette Score, 군집 프로파일, 군집별 고객 수와 이탈률

## 데이터 계보

- 원본: `data/raw/BankChurners.csv` — 10,127행, 23열
- 정제본: `data/processed/bankchurners_clean.csv` — 10,127행, 20열
- 정제 과정:
  - 식별자 `CLIENTNUM` 제거
  - 기존 모델 출력인 `Naive_Bayes_Classifier_..._1`, `_2` 제거
  - `Attrition_Flag`를 `Target`으로 변환
  - `Existing Customer=0`, `Attrited Customer=1`
  - `Unknown` 범주는 삭제·대체하지 않고 유지

자세한 데이터 설명과 무결성 정보는 `data/README.md`를 확인합니다.

## 평가 원칙

이탈 고객은 전체의 약 16.1%이므로 정확도만으로 모델을 평가하지 않습니다.

- 분류: Recall, Precision, F1, ROC-AUC, Lift/Gain
- 회귀: MAE, RMSE, R²
- 군집: Silhouette Score와 군집별 비즈니스 해석

## 주의사항

- `CLIENTNUM`과 두 개의 `Naive_Bayes_Classifier` 열은 모델 입력으로 사용하지 않습니다.
- 이 데이터는 시간 순서가 없는 공개·가공 데이터이므로 실제 운영 성능으로 직접 일반화하지 않습니다.
- 회귀 결과는 미래 LTV가 아니라 현재 데이터에 기반한 거래 활동성 분석으로 해석합니다.

## 데이터 출처

- https://www.kaggle.com/datasets/sakshigoyal7/credit-card-customers
