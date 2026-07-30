from lightgbm import LGBMClassifier
from sklearn.model_selection import GridSearchCV

PARAM_GRID = {
    "n_estimators" : [200, 300, 500],
    "max_depth" : [5, 7, 10, -1],
    "learning_rate" : [0.01, 0.05, 0.1],
    "num_leaves" : [31, 50, 70],
}

BEST_PARAMS = {"learning_rate" : 0.1, "max_depth" : -1, "n_estimators" : 500, "num_leaves" : 31}

def get_best_params() -> dict:
    """자리표시자 : 이미 탐색된 최적값을 반환한다"""
    return BEST_PARAMS


def search_best_params(X_train, y_train, random_state : int = 42) -> dict:
    """ 필요할 때 수동으로 재탐색 하는 함수 (평소 실행 흐름에서는 호출 안함)"""
    base = LGBMClassifier(class_weight = 'balanced', random_state = random_state, verbose = -1)
    grid_search = GridSearchCV(base, PARAM_GRID, scoring="f1", cv=5, n_jobs=-1)
    grid_search.fit(X_train, y_train)
    return grid_search.best_params_