---
name: ci-pipeline
description: Set up continuous integration (GitHub Actions) for tests and builds.
source: you
uses: 0
category: Coding
---

1. Create .github/workflows/ci.yml: checkout, language setup with caching, install, lint, type check, test.
2. Run the same commands locally first.
3. Keep secrets in repository secrets, never in the file.
4. Pushing needs approval; then follow the run with gh run watch or gh run view.
