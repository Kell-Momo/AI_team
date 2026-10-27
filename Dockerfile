# GrowthLoop: Node backend (TypeScript run by tsx, no build step) serving the prebuilt React UI.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so these layers stay cached while the source changes.
# tsx runs the TypeScript at runtime, so the backend needs its dev dependencies too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci && npm cache clean --force

# Source, scripts and the synthetic data/ (.dockerignore keeps secrets, runtime output and .git out).
COPY . .

# Build the UI into frontend/dist, then drop its toolchain: only the static files are served.
RUN cd frontend && npm run build && rm -rf node_modules

# Folders the app writes at runtime (traces, memory, dry-run outbox), owned by the
# unprivileged "node" user that ships with the base image.
RUN mkdir -p logs .memory outbox && chown node:node logs .memory outbox

USER node
EXPOSE 8000
CMD ["npx", "tsx", "run.ts", "serve"]
