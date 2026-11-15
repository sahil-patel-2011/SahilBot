---
name: data-ml-engineering
description: Makes data and ML work correct and reproducible - pandas hygiene, notebook-to-script, validation, leak-free splits and honest evaluation.
source: you
uses: 0
category: Coding
triggers: pandas settingwithcopywarning, chained assignment, merge validate, pandas dtype, notebook to script, random seed, data leakage, train test split, cross validation, baseline model, holdout set, confidence interval, experiment tracking, mlflow, pandera schema, feature pipeline
---

## When
Pipelines, feature code, training and evaluation. Quick exploratory analysis and charts: python-data-analysis. Packaging, venvs and pyproject: python-project.

## pandas hygiene
- Set dtypes on read: `pd.read_csv(p, dtype={...}, parse_dates=[...])`. Check `df.dtypes` and `df.isna().sum()` first thing. IDs as strings, money as integer cents or Decimal, categories as `category`.
- Copies vs views: never chain `df[mask]["col"] = x`. Use `df.loc[mask, "col"] = x`; take `.copy()` when you slice a frame you will modify. Treat `SettingWithCopyWarning` as an error. With copy-on-write (pandas 2.x option, default in 3) chained assignment silently does nothing.
- Merges: always `pd.merge(a, b, on=k, how="left", validate="many_to_one", indicator=True)`; assert row count is what you expect and check `_merge` for unmatched rows. Duplicate keys silently multiply rows.
- NaN: `NaN != NaN`; use `isna()`. Aggregations skip NaN by default; decide explicitly whether missing means 0, unknown, or drop. Integer columns with NaN become float unless you use `Int64`.
- Vectorize; `apply` with a Python lambda over millions of rows is a smell.

## Notebook to script
1. Move logic into functions in a module (`src/pkg/features.py`); the notebook only calls them.
2. Parameters (paths, dates, hyperparameters) come from CLI args or a config file, never edited cells.
3. Seed everything: `random`, `numpy`, framework (`torch.manual_seed`), and pass `random_state` to splitters/models.
4. Pin the environment (lockfile, Python version) and record the data version or hash.
5. Run top to bottom from a clean kernel (`jupyter nbconvert --execute`) or as `python -m pkg.train --config cfg.yaml`.

## Data validation
Assert schema and invariants at pipeline boundaries: column set, dtypes, non-null keys, uniqueness, value ranges, row-count deltas vs last run (pandera, Great Expectations, or plain asserts). Fail loudly; don't impute your way past a broken upstream.

## Splits and leakage
- Split first, then fit any scaler/encoder/imputer/feature selector on train only (use a `Pipeline`).
- Time data: split by time, never shuffle; features may only use information available at prediction time.
- Grouped data (same user/patient/device): `GroupKFold` / group split so one entity is never in both sides.
- Leakage signals: validation score suspiciously high, one feature dominates importance, target-derived columns (status after outcome, IDs that encode labels).

## Evaluation hygiene
1. Baseline first: majority class, mean, last value, or a simple linear model. A model that barely beats it is not a result.
2. Choose the metric from the decision: imbalanced classes -> PR-AUC/recall at fixed precision, not accuracy; regression with outliers -> MAE; ranking -> NDCG.
3. Tune on validation or CV only. Touch the test holdout once, at the end.
4. Report uncertainty: bootstrap a 95% CI on the test metric, or mean +/- std across folds. Small differences inside the CI are not wins.
5. Slice metrics by important segments; overall averages hide failures.

## Experiment tracking
Log per run: git commit, config, data hash, seed, metrics, and artifacts (MLflow, W&B, or a JSON line per run). If you cannot reproduce a number from the log, it doesn't count.

## Verify
Re-run the pipeline twice with the same seed and get identical metrics; asserts on row counts after every merge; a unit test for each feature function with a tiny hand-made frame.
