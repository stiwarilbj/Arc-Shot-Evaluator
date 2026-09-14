"""Compare leakage-safe jump-shot probability baselines on an adjudicated manifest.

The command is deliberately a candidate evaluator. It trains two small
baselines on a grouped development split and writes metrics for review, but it
never writes a release model or changes ARC's model registry. Calibration and
the final held-out test are separate release gates.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any


_FORBIDDEN_FEATURE_TOKENS = {
    "outcome",
    "result",
    "label",
    "target",
    "make_miss",
    "rim_interaction",
    "landing",
    "post_cutoff",
    "later_footage",
    "source",
    "duplicate_group",
    "game_or_session",
    "session_id",
}


def load_rows(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="") as stream:
        if path.suffix.lower() == ".jsonl":
            return [json.loads(line) for line in stream if line.strip()]
        return list(csv.DictReader(stream))


def _nested(row: Mapping[str, Any], *paths: str) -> Any:
    for path in paths:
        value: Any = row
        for part in path.split("."):
            if not isinstance(value, Mapping) or part not in value:
                value = None
                break
            value = value[part]
        if value is not None:
            return value
    return None


def _outcome(row: Mapping[str, Any]) -> int | None:
    value = _nested(row, "outcome", "shot.outcome", "labels.outcome")
    value = str(value).strip().lower() if value is not None else ""
    if value in {"make", "made", "1", "true"}:
        return 1
    if value in {"miss", "missed", "0", "false"}:
        return 0
    return None


def _coerce_scalar(value: Any) -> Any:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return value
        return number if math.isfinite(number) else None
    return None


def _flatten_features(value: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten scalar model features while dropping target and identity fields."""
    flattened: dict[str, Any] = {}
    if isinstance(value, Mapping):
        for key, child in value.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            tokens = set(name.lower().replace("-", "_").split("."))
            if tokens & _FORBIDDEN_FEATURE_TOKENS:
                continue
            if any(token.endswith("_id") or token in {"id", "uri", "sha256", "rights", "license"} for token in tokens):
                continue
            flattened.update(_flatten_features(child, name))
    elif isinstance(value, (list, tuple)):
        # Variable-length defender lists must be summarized by the feature
        # extractor before training; expanding them would leak track identity.
        return flattened
    else:
        scalar = _coerce_scalar(value)
        if scalar is not None and prefix:
            flattened[prefix] = scalar
    return flattened


def _features(row: Mapping[str, Any], cutoff: str) -> dict[str, Any]:
    if cutoff == "release_plus_200ms":
        value = _nested(row, "features_after_200ms", "early_flight_features")
    else:
        value = _nested(row, "features_at_release", "release_features")
    if value is None:
        value = _nested(row, "features", "prediction_features")
    if value is None:
        # This fallback makes the manifest schema useful for an initial label
        # export while still excluding target outcome and post-shot fields.
        value = row
    return _flatten_features(value)


def _group(row: Mapping[str, Any]) -> str:
    values = (
        _nested(row, "source.duplicate_group", "duplicate_group"),
        _nested(row, "source.game_or_session", "game_or_session"),
        _nested(row, "source.shooter_id", "shot.shooter_id", "shooter_id"),
        _nested(row, "source.venue_id", "venue_id"),
    )
    return "|".join(str(value or "unknown") for value in values)


def _rights_allowed(row: Mapping[str, Any]) -> bool:
    rights = str(_nested(row, "source.rights", "rights") or "").strip().lower()
    allowed_model_use = _nested(row, "labels.allowed_model_use", "allowed_model_use")
    if isinstance(allowed_model_use, str):
        allowed_model_use = allowed_model_use.strip().lower() in {"1", "true", "yes"}
    return bool(allowed_model_use is not False and rights in {"commercial_or_public_release", "commercial", "public_release"})


def _metric_report(model: Any, x_test: Any, y_test: list[int]) -> dict[str, Any]:
    from sklearn.metrics import brier_score_loss, log_loss

    probabilities = model.predict_proba(x_test)[:, 1]
    return {
        "brier_score": round(float(brier_score_loss(y_test, probabilities)), 6),
        "log_loss": round(float(log_loss(y_test, probabilities, labels=[0, 1])), 6),
        "mean_predicted_probability": round(float(probabilities.mean()), 6),
        "observed_rate": round(float(sum(y_test) / len(y_test)), 6),
        "samples": len(y_test),
    }


def _split_indices(rows: list[dict[str, Any]], seed: int) -> tuple[list[int], list[int], str]:
    import numpy as np
    from sklearn.model_selection import GroupShuffleSplit, train_test_split

    groups = [_group(row) for row in rows]
    unique_groups = len(set(groups))
    indices = np.arange(len(rows))
    if unique_groups >= 4:
        splitter = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=seed)
        train, test = next(splitter.split(indices, groups=groups))
        return train.tolist(), test.tolist(), "grouped_group_shuffle_split"
    labels = [_outcome(row) for row in rows]
    stratify = labels if len({label for label in labels if label is not None}) > 1 else None
    train, test = train_test_split(
        indices,
        test_size=max(1, int(round(len(rows) * 0.2))),
        random_state=seed,
        stratify=stratify,
    )
    return train.tolist(), test.tolist(), "row_split_insufficient_groups"


def _compare_cutoff(rows: list[dict[str, Any]], cutoff: str, seed: int) -> dict[str, Any]:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.feature_extraction import DictVectorizer
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    usable = [(row, _outcome(row)) for row in rows]
    usable = [(row, label) for row, label in usable if label is not None]
    if len(usable) < 8 or len({label for _, label in usable}) < 2:
        return {"status": "insufficient_labeled_data", "samples": len(usable)}
    labeled_rows = [row for row, _ in usable]
    labels = [int(label) for _, label in usable]
    train_indices, test_indices, split_method = _split_indices(labeled_rows, seed)
    if not test_indices or len({labels[index] for index in test_indices}) < 2:
        return {"status": "insufficient_test_classes", "samples": len(usable), "split_method": split_method}
    vectorizer = DictVectorizer(sparse=False)
    x_all = vectorizer.fit_transform([_features(row, cutoff) for row in labeled_rows])
    if x_all.shape[1] == 0:
        return {"status": "no_cutoff_features", "samples": len(usable), "split_method": split_method}
    x_train = x_all[train_indices]
    x_test = x_all[test_indices]
    y_train = [labels[index] for index in train_indices]
    y_test = [labels[index] for index in test_indices]
    if len(set(y_train)) < 2:
        return {"status": "insufficient_train_classes", "samples": len(usable), "split_method": split_method}
    models: dict[str, Any] = {
        "regularized_logistic_regression": make_pipeline(
            SimpleImputer(strategy="median"),
            StandardScaler(),
            LogisticRegression(C=1.0, penalty="l2", max_iter=2000, random_state=seed),
        ),
        "histogram_gradient_boosted_trees": make_pipeline(
            SimpleImputer(strategy="median"),
            HistGradientBoostingClassifier(
                learning_rate=0.05,
                max_iter=150,
                max_leaf_nodes=15,
                l2_regularization=1.0,
                random_state=seed,
            ),
        ),
    }
    metrics: dict[str, Any] = {}
    for name, model in models.items():
        model.fit(x_train, y_train)
        metrics[name] = _metric_report(model, x_test, y_test)
    logistic = metrics["regularized_logistic_regression"]
    trees = metrics["histogram_gradient_boosted_trees"]
    selected = (
        "histogram_gradient_boosted_trees"
        if trees["brier_score"] < logistic["brier_score"] and trees["log_loss"] < logistic["log_loss"]
        else "regularized_logistic_regression"
    )
    return {
        "status": "candidate_only",
        "samples": len(usable),
        "train_samples": len(train_indices),
        "test_samples": len(test_indices),
        "feature_count": int(x_all.shape[1]),
        "split_method": split_method,
        "group_count": len({_group(row) for row in labeled_rows}),
        "models": metrics,
        "selected_candidate": selected,
        "calibration": "not_run_separate_holdout_required",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare grouped jump-shot probability baselines")
    parser.add_argument("manifest", type=Path, help="Rights-cleared adjudicated CSV or JSONL manifest")
    parser.add_argument("--report", type=Path, required=True, help="Output comparison report path")
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()
    rows = load_rows(args.manifest)
    if not rows:
        raise SystemExit("manifest is empty")
    try:
        import sklearn  # noqa: F401
    except ImportError as error:
        raise SystemExit("Install scikit-learn in the training environment; ARC runtime does not require it") from error
    eligible_rows = [row for row in rows if _rights_allowed(row)]
    report = {
        "status": "candidate_only",
        "rows": len(rows),
        "eligible_rows": len(eligible_rows),
        "excluded_rows": len(rows) - len(eligible_rows),
        "dataset_version": "jump-shot-v1",
        "models_compared": ["regularized_logistic_regression", "histogram_gradient_boosted_trees"],
        "cutoffs": {
            cutoff: _compare_cutoff(eligible_rows, cutoff, args.seed)
            for cutoff in ("release", "release_plus_200ms")
        },
        "group_split_required": ["shooter_id", "venue_id", "game_or_session", "duplicate_group"],
        "release_model_exported": False,
        "reason": "Add independent calibration and final-test metrics before registry promotion",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
