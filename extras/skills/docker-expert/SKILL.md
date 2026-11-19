---
name: docker-expert
description: Writes and hardens Dockerfiles and docker-compose files: small images, build cache, non-root users, health checks, secrets; builds to verify.
---
# Workflow: Docker

1. **Inspect:** read the existing `Dockerfile`, `docker-compose*.yml`, `.dockerignore`, and how the app is built and started (package manifest, entrypoint, port, env vars).
2. **Dockerfile checklist:**
   - Pin base images to a version (not `latest`); prefer slim/distroless/alpine where the stack supports it.
   - Multi-stage: build stage with toolchain, final stage with only the runtime and built artifacts.
   - Order layers for cache: copy dependency manifests → install → copy source.
   - `.dockerignore` excludes `.git`, `node_modules`, build output, `.env*`, test data.
   - Run as a non-root user; set `WORKDIR`; use exec-form `CMD ["node","server.js"]`; add `HEALTHCHECK` for services.
   - No secrets in `ENV`/`ARG`/layers: use BuildKit secrets (`RUN --mount=type=secret`) or runtime env.
3. **Compose checklist:** named volumes for data, `healthcheck` + `depends_on: condition: service_healthy`, resource limits where relevant, env via `env_file`/variables rather than inline secrets, only the ports that must be published.
4. **Verify (do not skip when Docker is available):** `docker build .` (and `docker compose config` to validate compose); lint with `hadolint` if installed; for a service, start it and check the health endpoint, then stop it. If Docker is not available say so and mark the result as unverified.
5. **Report:** image size before/after when measurable (`docker images`), what changed and why, anything left risky.

Rules: never run `docker system prune`, `rm -f` on containers you did not start, or push images; never bake credentials into an image.
