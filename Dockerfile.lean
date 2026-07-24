# Lean image to minimize the SberOSC vulnerability-scan surface.
# vs the main Dockerfile: Alpine base (far fewer OS CVEs than Debian slim),
# no `obsidian-headless` (huge Electron tree — not needed for GigaChat/local-folder
# users; Obsidian-sync users must use the Debian `Dockerfile` instead), and no
# build toolchain in the final stage.

# ── Stage 1: build (has toolchain to compile better-sqlite3) ──────────────
FROM node:22-alpine AS build
ENV COREPACK_INTEGRITY_KEYS=""
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build
# Keep only prod deps (incl. the compiled better-sqlite3 *.node).
RUN pnpm prune --prod

# ── Stage 2: production (minimal Alpine; only the sqlite runtime lib) ──────
FROM node:22-alpine AS production
ENV NODE_ENV=production
RUN apk add --no-cache libstdc++ tini
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
