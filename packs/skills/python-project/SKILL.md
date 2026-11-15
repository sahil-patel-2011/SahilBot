---
name: python-project
description: Work in a Python package or service - set up uv/venv/poetry, run ruff, mypy or pyright and pytest, and avoid classic Python bugs.
source: you
uses: 0
category: Coding
triggers: pyproject.toml, pytest, ruff check, mypy, pyright, uv sync, poetry install, virtualenv, requirements.txt, conftest.py, pytest parametrize, modulenotfounderror, python type hints, dataclass, pip install -e
---

## When
A Python codebase with tests and packaging. For a single throwaway script read python-script instead; for pandas work, python-data-analysis.

## Orient
1. code(action="project"); read pyproject.toml ([project], [tool.ruff], [tool.mypy], [tool.pytest.ini_options]), plus setup.cfg, tox.ini, noxfile.py, Makefile if present.
2. Environment manager from files: uv.lock = uv; poetry.lock = poetry; Pipfile.lock = pipenv; requirements*.txt only = venv + pip. Use that tool only.
3. Python version: requires-python, .python-version. Check python --version inside the env, not the system python3.
4. Setup (asks the user): uv sync; or poetry install; or python3 -m venv .venv && .venv/bin/pip install -e ".[dev]".

## Commands (prefix with uv run or poetry run when used)
- Lint: ruff check . (ruff check --fix on touched files). Format: ruff format --check . (or black --check).
- Types: mypy src (or the configured paths); pyright if pyrightconfig.json or [tool.pyright] exists.
- Tests: pytest -q. One test: pytest tests/test_io.py::test_reads_utf8 -x. By name: pytest -k "parse and not slow". Debug: -x --pdb, -l for locals, -s to see prints, --lf to rerun failures.
- SahilBot: code(action="lint"), code(action="typecheck"), code(action="run_tests", filter="tests/test_io.py").

## Layout
src/<pkg>/ with __init__.py, tests/ beside src, shared fixtures in tests/conftest.py. The src layout forces tests to import the installed package, catching packaging mistakes. Entry points go in [project.scripts], not ad hoc sys.path hacks.

## Idioms
- Type hints on public functions; list[int], X | None (3.10+). Protocol for duck typing, TypedDict for dict-shaped JSON, Literal for fixed options.
- @dataclass(frozen=True, slots=True) for value objects; field(default_factory=list) for mutable defaults.
- pathlib.Path everywhere: Path(__file__).parent / "data.json", p.read_text(encoding="utf-8").
- Context managers for files, locks and connections. logging, not print, in libraries.
- Raise specific exceptions; catch the narrowest type; never bare except.
- pytest: fixtures for setup (tmp_path, monkeypatch, capsys are built in), @pytest.mark.parametrize for input tables, pytest.raises(ValueError, match="...") for errors, pytest.approx for floats.

## Pitfalls
- Mutable default argument: def f(x, acc=[]) shares one list across calls. Use None and create inside.
- Late binding: [lambda: i for i in range(3)] all return 2. Bind with lambda i=i: i.
- Encoding: always pass encoding="utf-8" to open and read_text; Windows and some locales default otherwise.
- A local file named json.py, random.py or test.py shadows the stdlib.
- ModuleNotFoundError: wrong interpreter or package not installed in editable mode; check which python and pip show.
- Naive vs aware datetimes; use datetime.now(timezone.utc). Money in float; use Decimal.
- is for None only, == for values. Modifying a list while iterating it.
- Running mypy on files the project excludes, or pinning versions the lockfile doesn't.

## Packaging
Build with python -m build (or uv build); version in one place; pin ranges in [project.dependencies], exact pins only in lockfiles. Never commit .venv.

## Verify
ruff and type checker clean on touched files, the targeted test with -x then the whole suite. Report the commands and counts.

## Example
```python
@pytest.mark.parametrize("raw, expected", [("1,2", [1, 2]), ("", []), (" 3 ", [3])])
def test_parse_ids(raw: str, expected: list[int]) -> None:
    assert parse_ids(raw) == expected
```
