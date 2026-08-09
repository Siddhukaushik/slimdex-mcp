# slimdex-mcp — stdio MCP server.
#
# Build:  docker build -t slimdex-mcp .
# Run:    docker run -i --rm -v /path/to/repo:/repo -e SLIMDEX_ROOT=/repo slimdex-mcp
#
# The server speaks MCP over stdin/stdout, so `-i` is required and there is no
# port to expose. Mount the repo you want indexed; without SLIMDEX_ROOT the
# server falls back to the working directory, which in this image is empty.

FROM node:20-alpine AS build
WORKDIR /app

# Install with dev dependencies — the build needs TypeScript.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only; the compiled output needs no toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY README.md LICENSE ./

# The index and memory live under the indexed repo (.slimdex/), not here, so
# nothing needs to persist in the image itself.
USER node

ENTRYPOINT ["node", "dist/index.js"]
