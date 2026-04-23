# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=20.18.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js/Prisma"

# Node.js/Prisma app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp openssl pkg-config python-is-python3

# Install node modules (including devDeps for build)
COPY package-lock.json package.json ./
RUN npm ci --include=dev

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy application code
COPY . .

# Build application (This will now pass successfully!)
RUN npm run build

# Remove development dependencies to keep image slim
RUN npm prune --omit=dev

# Final stage for app image
FROM base

# Install runtime dependencies (openssl is required for Prisma)
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Copy built application and modules from build stage
COPY --from=build /app /app

# Start the server
EXPOSE 8080
CMD [ "npm", "run", "start" ]
