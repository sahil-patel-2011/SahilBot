---
name: devops-cicd-iac
description: Sets up containers, pipelines and infrastructure as code safely - small images, deploy gates, Terraform state, secrets, rollbacks, blue/green.
source: you
uses: 0
category: Coding
triggers: multi-stage dockerfile, non-root container, distroless image, docker compose healthcheck, deploy gate, terraform plan, terraform state, tfstate lock, infrastructure as code, drift detection, pulumi, secret rotation, vault secrets, blue green deploy, canary release, environment promotion
---

## When
Designing how code gets built, shipped and run. A concrete Docker build or deploy to a host: also read docker-and-deploy. Writing a specific CI workflow file: ci-pipeline.

## Docker checklist
1. Pin the base by version (and digest for prod): `python:3.12.7-slim`, not `latest`.
2. Multi-stage: build tools in a builder stage, copy only artifacts into a slim or distroless runtime.
3. Order layers for cache: copy lockfile, install deps, then copy source.
4. `.dockerignore` excludes `.git`, `node_modules`, `.env*`, build output, tests data.
5. Run as non-root (`USER 10001`), read-only filesystem where possible, one process per container, exec-form `CMD` so SIGTERM reaches the app.
6. Add a `HEALTHCHECK` or rely on the orchestrator probe; scan the image (trivy/grype).

```dockerfile
FROM node:22.11-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build /app /app
WORKDIR /app
USER 10001
CMD ["dist/server.js"]
```

## docker compose
For local dev and small single-host deploys. Use `depends_on: condition: service_healthy` with healthchecks, named volumes for data, an `.env` file that is gitignored, and profiles for optional services.

## CI/CD stages
1. Lint + typecheck + unit tests (fast, every push).
2. Build the artifact/image once, tag with the commit SHA; later stages promote that same artifact, never rebuild.
3. Integration/e2e against the built artifact.
4. Deploy to staging automatically; production behind a gate (manual approval, green checks, change window).
5. Post-deploy smoke test; auto-rollback on failure.
Cache dependencies, cancel superseded runs, keep main always deployable.

## IaC basics (Terraform)
- Remote state (S3+DynamoDB lock, GCS, Terraform Cloud) with locking and encryption; never commit `terraform.tfstate`.
- `terraform fmt && terraform validate && terraform plan -out=plan.tfplan`; review the plan (especially `destroy` and `replace` lines); `terraform apply plan.tfplan`. CI posts the plan on PRs; apply only from main.
- Pin provider and module versions. Small modules with clear inputs/outputs; one state per environment.
- Drift: scheduled `terraform plan -detailed-exitcode` (exit 2 = drift). Fix by importing or reverting the manual change, not by ignoring it.
- `prevent_destroy` on databases and buckets that hold data.

## Secrets
- Never in git, images, build args or logs. Inject at runtime from a secret manager (Vault, AWS/GCP Secrets Manager, CI encrypted secrets, Kubernetes secrets via external-secrets).
- Least privilege, per-environment credentials, OIDC federation from CI instead of long-lived cloud keys.
- Rotate on a schedule and immediately on any leak; a secret pushed to git is compromised even after deletion. Run gitleaks/trufflehog in CI.

## Releases and rollback
- Rolling: default. Blue/green: two full stacks, switch traffic, keep blue warm for instant rollback. Canary: 1-5% traffic with metric gates before 100%.
- Rollback = redeploy the previous artifact tag. Database migrations must be backward-compatible (expand, deploy, contract) so the old version still runs.
- Environments: dev, staging (prod-like data shape and config), prod. Config differs by env vars only, not by code branches.

## Verify
`docker run` the image locally and hit the health endpoint; `docker image ls` size sanity check; `terraform plan` shows zero changes after apply; a rehearsed rollback in staging.
