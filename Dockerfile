ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts/build.ts scripts/status.ts scripts/preview.ts ./scripts/
RUN bun run build

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
RUN apk add --no-cache curl

WORKDIR /app
ENV NODE_ENV=production \
    CONTROL_HOST=0.0.0.0 \
    HOME=/tmp

COPY --from=build --chown=bun:bun /app/dist ./dist
RUN mkdir -p /app/.runtime && chown bun:bun /app/.runtime

USER bun
EXPOSE 43820
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=6 \
  CMD ["bun", "/app/dist/status.js"]

CMD ["bun", "/app/dist/service.js"]
