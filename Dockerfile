# Use the latest Node.js Alpine image
FROM node:latest-alpine

# Install required build tools and dependencies
RUN apk add --no-cache python3 make g++ coreutils

# Set working directory
WORKDIR /app

# Copy everything with root ownership
COPY . .

# Install dependencies
RUN npm install

# Run as root (default) - has full file access
CMD ["node", "index.js"]
