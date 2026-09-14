FROM node:20-alpine

RUN apk add --no-cache python3 make g++ coreutils

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev express

COPY server ./server
COPY public ./public

RUN mkdir -p /data \
 && chmod -R 777 /app /data \
 && chown -R root:root /app /data

ENV PORT=3300
ENV IDEROOT=/data
EXPOSE 3300

CMD ["node", "server/index.js"]
