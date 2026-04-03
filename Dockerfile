# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# dev: full source + dev deps, no tests
FROM base AS dev
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
RUN mkdir -p data
CMD ["bun", "run", "--watch", "src/index.ts"]

# release: production deps + source, tests as build gate
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY . .
ENV NODE_ENV=production
RUN bun test
RUN mkdir -p data
CMD ["bun", "run", "src/index.ts"]
