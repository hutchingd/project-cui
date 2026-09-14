# Use LTS Alpine for stability
FROM node:lts-alpine

# Install build tools + dependencies required by node-pty
# ADDED: procps (full ps command) and shadow (user management)
RUN apk add --no-cache python3 make g++ coreutils bash procps shadow

# Clear ALL inherited npm/proxy settings from the build environment
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_PROXY= \
    NPM_CONFIG_HTTPS_PROXY= \
    NPM_CONFIG_STRICT_SSL=true \
    HTTP_PROXY= \
    HTTPS_PROXY= \
    http_proxy= \
    https_proxy= \
    NO_PROXY=registry.npmjs.org

# Set working directory
WORKDIR /app

# Copy package.json FIRST (so we control the install step)
COPY package.json ./

# Remove any Replit-tied npm config/lockfiles that may have been copied
RUN rm -f .npmrc package-lock.json npm-shrinkwrap.json

# Force public registry globally + install dependencies fresh
RUN npm config set registry https://registry.npmjs.org/ && \
    npm config delete proxy || true && \
    npm config delete https-proxy || true && \
    npm install --no-audit --no-fund

# Now copy the rest of the project files
COPY . .

# Ensure no Replit config sneaks back in after full copy
RUN rm -f .npmrc package-lock.json

# Run the app (package.json has "start": "node server/index.js")
CMD ["npm", "start"]
