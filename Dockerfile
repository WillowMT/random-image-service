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

# Install Claude Code CLI for story generation
RUN apt-get update -qq && apt-get install -y -qq git nodejs npm && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Story temp directory + DB
RUN mkdir -p /app/zips /app/tmp/stories /app/data

ENV ZIP_DIR=/app/images/zips
ENV SELECTION_MODE=flat
ENV PORT=3000
ENV STORY_TEMP_DIR=/app/tmp/stories
ENV STORY_IMAGE_COUNT=9
ENV STORY_DB_PATH=/app/data/stories.db

EXPOSE 3000

CMD ["sh", "-c", ". /root/.claude-env 2>/dev/null; exec bun run dist/index.js"]
