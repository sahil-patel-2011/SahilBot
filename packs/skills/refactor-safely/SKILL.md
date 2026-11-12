---
name: refactor-safely
description: Restructure code without changing what it does.
source: you
uses: 0
category: Engineering
---

1. Make sure there are tests that cover the code; if not, add characterization tests that pin the current behavior first.
2. Run the tests: they must pass before you start.
3. Change one thing at a time (rename, extract function, move module). Run tests after each step.
4. Search for every usage (`rg <symbol>`) before renaming or moving; update imports.
5. Don't mix refactors with behavior changes in one commit.
6. End with the full test suite and a type check passing, and a short summary of what moved where.
