# --- Stage 1: Install dependencies ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Build ---
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: Production runtime ---
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Install uv (for Trino MCP subprocess)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"

# Pre-warm Trino MCP dependencies so first query is fast
RUN uvx --from 'git+https://github.com/Remitly/toolbox.git#subdirectory=trino' trino-mcp --help || true

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy app assets needed at runtime
COPY --from=builder /app/query-library ./query-library
COPY --from=builder /app/domain-context.md ./domain-context.md

# Create cache directory
RUN mkdir -p .cache

EXPOSE 3000

CMD ["node", "server.js"]
