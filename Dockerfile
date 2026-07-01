# syntax = docker/dockerfile:1

# Node version used in this image.
#
# Must satisfy BOTH the Fly launch runtime constraint
# (currently `>=22.12.0 || >=20.19.0 <21.0.0` for the
# `Node.js/Prisma` label) AND match the CI workflow
# (`.github/workflows/api-contract.yml` uses `node-version: 24`).
# Drift between CI and the Dockerfile is the most common
# production cause of "works in CI, breaks on Fly" deploy
# failures, so we pin to the current LTS (Node 24) and let
# the `slim` tag roll forward to the latest 24.x patch.
#
# `package.json` `engines.node` is the source of truth — keep
# it in sync with this ARG.
ARG NODE_VERSION=24-slim
FROM node:${NODE_VERSION} AS base

LABEL fly_launch_runtime="Node.js/Prisma"

# Node.js/Prisma app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build native node modules (Prisma,
# bcrypt, sharp) and to run node-gyp. The runtime stage doesn't
# need any of this.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp openssl pkg-config python-is-python3 && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Install node modules (including devDeps for the build)
COPY package-lock.json package.json ./
RUN npm ci --include=dev

# Copy Prisma schema and generate client (this also runs the
# prebuild hook, so it has to happen before `npm run build`).
COPY prisma ./prisma/
RUN npx prisma generate

# Copy application code and build
COPY . .
RUN npm run build

# Remove dev deps to keep the build stage lean
RUN npm prune --omit=dev

# Final stage for the runtime image
FROM base

# Install runtime dependencies only (openssl is required for
# Prisma; ca-certificates for outbound TLS). No build tools —
# native modules are already compiled in the build stage and
# `npm prune` already stripped the dev deps.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Copy built application and node_modules from the build stage
COPY --from=build /app /app

# Start the server
EXPOSE 8080
CMD [ "npm", "run", "start" ]
