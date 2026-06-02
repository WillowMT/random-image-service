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
RUN apt-get update -qq && apt-get install -y -qq git && \
    npm install -g @anthropic-ai/claude-code 2>/dev/null; \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Story temp directory
RUN mkdir -p /app/zips /app/tmp/stories

ENV ZIP_DIR=/app/zips
ENV SELECTION_MODE=flat
ENV PORT=3000
ENV STORY_TEMP_DIR=/app/tmp/stories
ENV STORY_IMAGE_COUNT=9

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
