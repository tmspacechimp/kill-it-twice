FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.mjs .prettierrc.json .prettierignore ./
COPY src ./src
COPY test ./test
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /state && chown node:node /state
USER node
CMD ["node", "dist/main.js"]
