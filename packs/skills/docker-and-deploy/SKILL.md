---
name: docker-and-deploy
description: Containerize and deploy an app (Docker, docker compose, simple hosting).
source: you
uses: 0
category: Coding
triggers: dockerfile, docker compose, containerize, docker image, deploy the app, host the app, fly.io, render.com
---

1. Minimal Dockerfile: small base image, pinned versions, non-root user, multi-stage build for compiled apps, a .dockerignore.
2. Build and run locally (docker build, docker run -p) and hit the health endpoint.
3. Use compose for several services, with env files (never commit secrets).
4. Deploying to a public host goes outside this Mac: confirm with the user and document the steps and the rollback.
