# ─── Build stage ──────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS builder

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY src/ ./src/
RUN bun build src/index.ts --target bun --outdir dist

# ─── Run stage ────────────────────────────────────────────────────
FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/

# ZIPs are mounted from outside — create the dir so it exists
RUN mkdir -p /app/zips

ENV ZIP_DIR=/app/zips
ENV SELECTION_MODE=flat
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
