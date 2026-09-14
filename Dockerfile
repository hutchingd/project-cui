FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev express

COPY server ./server
COPY public ./public

RUN chmod -R 777 /app && chown -R root:root /app

CMD ["node", "server/index.js"]
