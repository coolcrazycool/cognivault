---
phase: quick
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/docker-publish.yml
  - docker-compose.prod.yml
autonomous: true
requirements: [QUICK-CI-1]
must_haves:
  truths:
    - "Push to main triggers a Docker image build and publish to GHCR"
    - "Production compose file pulls the pre-built GHCR image instead of building locally"
    - "GHCR image is tagged with both sha and latest"
  artifacts:
    - path: ".github/workflows/docker-publish.yml"
      provides: "GitHub Actions CI workflow for Docker build+publish"
      contains: "ghcr.io"
    - path: "docker-compose.prod.yml"
      provides: "Production docker-compose referencing GHCR image"
      contains: "ghcr.io/coolcrazycool/cognivault"
  key_links:
    - from: ".github/workflows/docker-publish.yml"
      to: "Dockerfile"
      via: "docker/build-push-action"
      pattern: "build-push-action"
---

<objective>
Add CI/CD for Docker image publishing and a production-ready compose file.

Purpose: Enable automated Docker image builds on push to main, published to GHCR, so users can deploy CogniVault on any server with just a docker-compose file (no source checkout needed).
Output: GitHub Actions workflow + production docker-compose.prod.yml
</objective>

<execution_context>
@/Users/cytryx/.claude/get-shit-done/workflows/execute-plan.md
@/Users/cytryx/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@Dockerfile
@docker-compose.yml
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create GitHub Actions workflow for Docker build and GHCR publish</name>
  <files>.github/workflows/docker-publish.yml</files>
  <action>
Create `.github/workflows/docker-publish.yml` that:

- Triggers on push to `main` branch (paths: ignore docs/planning changes to avoid unnecessary builds)
- Uses `docker/login-action` to authenticate to ghcr.io using `GITHUB_TOKEN` (built-in, no secrets setup needed)
- Uses `docker/metadata-action` to generate tags: `type=sha`, `type=raw,value=latest`
- Uses `docker/build-push-action` to build from the existing multi-stage Dockerfile and push to `ghcr.io/coolcrazycool/cognivault`
- Sets appropriate permissions: `contents: read`, `packages: write`
- Uses `docker/setup-buildx-action` for layer caching
- Adds cache-from/cache-to using GitHub Actions cache backend for faster rebuilds

The image name should be lowercase: `ghcr.io/coolcrazycool/cognivault`.

Labels should include org.opencontainers.image metadata (source, description) via the metadata-action.
  </action>
  <verify>
    <automated>cat .github/workflows/docker-publish.yml | head -80 && echo "---" && grep -c "ghcr.io" .github/workflows/docker-publish.yml</automated>
  </verify>
  <done>Workflow file exists, references ghcr.io, uses build-push-action with proper auth and tagging</done>
</task>

<task type="auto">
  <name>Task 2: Create production docker-compose.prod.yml pulling from GHCR</name>
  <files>docker-compose.prod.yml</files>
  <action>
Create `docker-compose.prod.yml` based on the existing `docker-compose.yml` but with these changes:

- The `cognivault` service uses `image: ghcr.io/coolcrazycool/cognivault:latest` instead of `build: .`
- Keep the same environment variables, volumes, healthcheck, and depends_on as the dev compose
- Keep the `qdrant` service identical (same image, healthcheck, volumes)
- Remove prometheus and grafana services (keep it minimal for production deployment — users can add monitoring separately)
- Add a comment at the top explaining this file is for deploying from the pre-built GHCR image
- Include `OPENAI_API_KEY` in environment (passed through from host env, needed for embeddings)
- Include `restart: unless-stopped` on both services for production resilience
- Keep `cognivault_data` and `qdrant_data` named volumes

Do NOT include `ports` for Qdrant (only CogniVault needs external access in prod). Qdrant is internal-only, accessed by CogniVault via the Docker network.
  </action>
  <verify>
    <automated>cat docker-compose.prod.yml && echo "---" && grep "ghcr.io" docker-compose.prod.yml && grep -c "build:" docker-compose.prod.yml; test $? -ne 0 && echo "PASS: no build directive"</automated>
  </verify>
  <done>Production compose file exists, pulls from GHCR, has no build directive, includes restart policy and essential services only</done>
</task>

</tasks>

<verification>
- `.github/workflows/docker-publish.yml` is valid YAML and references the correct GHCR path
- `docker-compose.prod.yml` is valid YAML and uses `image:` instead of `build:`
- Both files follow the project's existing Docker patterns (same env vars, healthchecks, volume names)
</verification>

<success_criteria>
- GitHub Actions workflow will build and push Docker image to GHCR on push to main
- Production compose file lets users deploy with just `docker-compose -f docker-compose.prod.yml up -d` on any server
- No manual secrets configuration needed (uses built-in GITHUB_TOKEN)
</success_criteria>

<output>
After completion, create `.planning/quick/1-add-ci-workflow-for-docker-image-build-a/1-SUMMARY.md`
</output>
