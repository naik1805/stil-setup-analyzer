"""Learning-to-Defer with a Gradient Boosting Classifier. Engineer review is the label."""

from __future__ import annotations

import json
import time
from pathlib import Path

FEATURE_KEYS = (
    "duplicate",
    "tap_already_reset",
    "reset_already_released",
    "tck_zero",
    "tms_one",
    "is_sib",
    "is_tdr",
    "is_ir",
    "is_exit",
    "is_tms_tlr",
    "is_reset_assert",
    "loop_repeat",
    "rule_says_cut",
)

MODEL_DIR = Path(__file__).resolve().parent / "models"
REVIEWS_PATH = MODEL_DIR / "reviews.jsonl"
MODEL_PATH = MODEL_DIR / "ltd_gbc_cuda.pt"
MODEL_PATH_CPU = MODEL_DIR / "ltd_gbc.joblib"


def _cuda_ready() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False

# LtD thresholds on P(engineer will accept a cut)
P_CUT = 0.65
P_KEEP = 0.35


def _vec(feat: dict) -> list[float]:
    return [float(feat.get(k, 0)) for k in FEATURE_KEYS]


def _load_reviews() -> list[dict]:
    if not REVIEWS_PATH.is_file():
        return []
    rows = []
    for line in REVIEWS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def save_reviews(items: list[dict]) -> int:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with REVIEWS_PATH.open("a", encoding="utf-8") as fh:
        for item in items:
            rec = {
                "file": item.get("file"),
                "index": item.get("index"),
                "label": item.get("label"),
                "features": item.get("features") or {},
                "ts": time.time(),
            }
            fh.write(json.dumps(rec) + "\n")
    return len(items)


def approved_removes(file_name: str) -> set[int]:
    out: set[int] = set()
    latest: dict[int, str] = {}
    for r in _load_reviews():
        if r.get("file") != file_name:
            continue
        try:
            latest[int(r["index"])] = r.get("label")
        except (TypeError, ValueError):
            continue
    for idx, lab in latest.items():
        if lab == "remove":
            out.add(idx)
    return out


def review_map(file_name: str) -> dict[int, str]:
    latest: dict[int, str] = {}
    for r in _load_reviews():
        if r.get("file") != file_name:
            continue
        try:
            latest[int(r["index"])] = r.get("label")
        except (TypeError, ValueError):
            continue
    return latest


def _cuda_gbc():
    from cuda_gbc import CudaGBC

    return CudaGBC


def bootstrap_rows(classified: list[dict], file_name: str) -> list[tuple[list[float], int]]:
    rows = []
    for c in classified:
        y = 1 if c.get("rule_hint") == "waste" else 0
        rows.append((_vec(c.get("features") or {}), y))
    return rows


def train_gbc(extra_classified: list[list[dict]] | None = None) -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    X: list[list[float]] = []
    y: list[int] = []

    for bundle in extra_classified or []:
        for c in bundle:
            X.append(_vec(c.get("features") or {}))
            y.append(1 if c.get("rule_hint") == "waste" else 0)

    for r in _load_reviews():
        if r.get("label") not in ("keep", "remove"):
            continue
        feat = r.get("features") or {}
        label = 1 if r["label"] == "remove" else 0
        # Human labels count more than bootstrap rule rows.
        for _ in range(6):
            X.append(_vec(feat))
            y.append(label)

    if len(set(y)) < 2 or len(X) < 8:
        if MODEL_PATH.is_file():
            MODEL_PATH.unlink()
        if MODEL_PATH_CPU.is_file():
            MODEL_PATH_CPU.unlink()
        return {"trained": False, "n_samples": len(X), "n_reviews": len(_load_reviews()), "reason": "need both keep and remove examples"}

    if _cuda_ready():
        clf = _cuda_gbc()(n_estimators=80, max_depth=3, learning_rate=0.08)
        clf.fit(X, y)
        clf.save(MODEL_PATH)
        from cuda_gbc import gpu_name

        return {
            "trained": True,
            "n_samples": len(X),
            "n_reviews": len(_load_reviews()),
            "classes": sorted(set(y)),
            "device": "cuda",
            "gpu": gpu_name(),
        }

    from sklearn.ensemble import GradientBoostingClassifier
    import joblib

    clf = GradientBoostingClassifier(n_estimators=80, max_depth=3, learning_rate=0.08, random_state=7)
    clf.fit(X, y)
    joblib.dump({"model": clf, "keys": FEATURE_KEYS}, MODEL_PATH_CPU)
    return {
        "trained": True,
        "n_samples": len(X),
        "n_reviews": len(_load_reviews()),
        "classes": sorted(set(y)),
        "device": "cpu",
        "gpu": "cpu",
    }


def _model():
    if _cuda_ready() and MODEL_PATH.is_file():
        from cuda_gbc import CudaGBC

        return CudaGBC.load(MODEL_PATH)
    if MODEL_PATH_CPU.is_file():
        import joblib

        blob = joblib.load(MODEL_PATH_CPU)
        return blob["model"]
    return None


def ltd_action(protected: bool, p_cut: float) -> str:
    if protected:
        return "keep"
    if p_cut >= P_CUT:
        return "recommend_cut"
    if p_cut <= P_KEEP:
        return "keep"
    return "defer"


def apply_ltd(classified: list[dict], file_name: str) -> tuple[list[dict], dict]:
    model = _model()
    reviews = review_map(file_name)
    proba_rows = None
    if model is not None and classified:
        proba_rows = model.predict_proba([_vec(c.get("features") or {}) for c in classified])
    out = []
    for i, c in enumerate(classified):
        feat = c.get("features") or {}
        p_cut = 0.5
        source = "untrained"
        if proba_rows is not None:
            p_cut = float(proba_rows[i][1])
            source = "gbc_cuda" if _cuda_ready() else "gbc"
        elif c.get("rule_hint") == "waste":
            p_cut = 0.8
            source = "rule_prior"
        else:
            p_cut = 0.15
            source = "rule_prior"

        action = ltd_action(bool(c.get("protected")), p_cut)
        human = reviews.get(c["index"])
        row = dict(c)
        row["p_cut"] = round(p_cut, 3)
        row["ltd_action"] = action
        row["ltd_source"] = source
        row["review_label"] = human
        if human == "remove":
            row["final"] = "remove"
        elif human == "keep":
            row["final"] = "keep"
        else:
            row["final"] = "pending" if action in ("recommend_cut", "defer") else "keep"
        out.append(row)

    n_review = sum(1 for c in out if c["final"] == "pending")
    n_remove = sum(1 for c in out if c["final"] == "remove")
    n_keep = sum(1 for c in out if c["final"] == "keep")
    return out, {
        "model_ready": model is not None,
        "n_reviews": len(_load_reviews()),
        "n_keep": n_keep,
        "n_review": n_review,
        "n_remove": n_remove,
        "source": ("gbc_cuda" if _cuda_ready() else "gbc") if model is not None else "rule_prior",
        "device": "cuda" if (_cuda_ready() and model is not None) else ("cpu" if model is not None else "cpu"),
    }
