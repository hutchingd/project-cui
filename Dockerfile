# Use LTS Alpine for stability
FROM node:lts-alpine

# Install required build tools and dependencies
RUN apk add --no-cache python3 make g++ coreutils

# Set working directory
WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install

# Run the app
CMD ["node", "index.js"]
