# Use LTS Alpine for stability
FROM node:lts-alpine

# Install build tools + dependencies required by node-pty
# node-pty needs python3, make, g++, and also bash for its shell
RUN apk add --no-cache python3 make g++ coreutils bash

# Override npm registry to use public npm (fixes Replit firewall issue)
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

# Set working directory
WORKDIR /app

# Copy everything
COPY . .

# Remove any Replit-specific .npmrc that points to the internal firewall
RUN rm -f .npmrc

# Install dependencies using the public npm registry
RUN npm install --registry=https://registry.npmjs.org/

# Run the app
CMD ["npm", "start"]
