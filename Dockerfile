# ---------------- Project CUI - container image ----------------
# Works on Railway, Render, Fly.io, and any Docker host.
# HTTP + WebSocket share the same PORT (Railway/Render inject it at runtime).
FROM node:20-alpine

# node-pty requires native compilation on Alpine (musl).
RUN apk add --no-cache python3 make g++ bash

WORKDIR /app

# Install deps first for better layer caching.
# Fall back to `npm install` if the lockfile drifts from package.json, so a
# wrong/empty package.json in the build context can never silently install
# zero packages (which caused "Cannot find module 'express'" at boot).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    || npm install --omit=dev --no-audit --no-fund

# Fail the build loudly if any runtime dependency is missing from the image,
# instead of crashing at boot with "Cannot find module 'X'".
RUN node -e "['express','@babel/core','@babel/preset-react','node-pty','ws'].forEach(m=>require(m)); console.log('deps ok')"

COPY server ./server
COPY public ./public

# App data (database.json + each registered user's sandbox folder).
# Override IDEROOT at runtime if your platform mounts a disk elsewhere.
ENV IDEROOT=/data
ENV NODE_ENV=production
# EXPOSE documents the port; Railway/Render inject PORT at runtime.
EXPOSE 3000

# Ensure /data exists even if no volume is mounted (Railway, etc.)
RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]