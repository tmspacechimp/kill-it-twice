FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.mjs .prettierrc.json .prettierignore ./
COPY src ./src
COPY test ./test
RUN npm run build
RUN npm prune --omit=dev

FROM docker:29.1.3-cli AS docker-cli

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Root is required for the local demo's mounted Docker socket.
CMD ["node", "dist/main.js"]
