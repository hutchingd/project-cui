FROM node:20-alpine

# node-pty requires native compilation (node-gyp)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=3300
ENV IDEROOT=/data
EXPOSE 3300

# Persistent user files live in /data (mount a volume here)

CMD ["node", "server/index.js"]
