# syntax=docker/dockerfile:1

FROM node:26.8.1-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@11.1.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run typecheck && pnpm run build

FROM node:26.8.1-alpine AS runtime
ENV NODE_ENV=production
ARG DOCKER_GID=0
RUN set -eux; \
  if [ "$DOCKER_GID" = "0" ]; then adduser node root; \
  else addgroup -g "$DOCKER_GID" docker && adduser node docker; fi
WORKDIR /app
COPY --from=builder /app/dist/sidecar.cjs ./sidecar.cjs
USER node
CMD ["node", "/app/sidecar.cjs"]
