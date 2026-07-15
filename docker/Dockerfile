# ─── TriMC 最小部署拓扑 Dockerfile ───
# 构建上下文：D:\OneDrive\Code\ai（TriMC 和 TriModel 的父目录）
# 构建命令：docker build -f TriMC/docker/Dockerfile -t trimc:dev ../..
# CARRY-004 | 最后更新：2026-07-14

# ── Stage 1: Build ──
FROM node:20-alpine AS build

# Copy TriModel (dependency)
COPY TriModel/package.json TriModel/tsconfig.json /app/build/TriModel/
COPY TriModel/src/ /app/build/TriModel/src/

# Copy TriMC
COPY TriMC/package.json TriMC/tsconfig.json /app/build/TriMC/
COPY TriMC/src/ /app/build/TriMC/src/

# Build TriModel first (zero prod deps, build-only)
WORKDIR /app/build/TriModel
RUN npm install --ignore-scripts \
    && npm run build \
    && npm prune --production

# Build TriMC (file:../TriModel resolved via local copy)
WORKDIR /app/build/TriMC
RUN npm install --ignore-scripts \
    && npm run build \
    && npm prune --production \
    && rm -rf /app/build/TriMC/node_modules/trimodel \
    && cp -r /app/build/TriModel /app/build/TriMC/node_modules/trimodel

# ── Stage 2: Runtime ──
FROM node:20-alpine AS runtime

# Create non-root user
RUN addgroup -g 1001 trimc && adduser -u 1001 -G trimc -D trimc

WORKDIR /app

# Copy runtime artifacts (trimodel is now a materialized directory inside node_modules)
COPY --from=build --chown=trimc:trimc /app/build/TriMC/dist /app/dist
COPY --from=build --chown=trimc:trimc /app/build/TriMC/node_modules /app/node_modules
COPY --from=build --chown=trimc:trimc /app/build/TriMC/package.json /app/package.json

USER trimc

EXPOSE 8710

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8710/healthz || exit 1

CMD ["node", "dist/src/index.js"]
