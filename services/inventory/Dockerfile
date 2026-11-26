# Compile TypeScript with development dependencies available.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.server.json ./
COPY shared ./shared
COPY services ./services

RUN npx tsc -p tsconfig.server.json

# Run compiled JavaScript without development tooling.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/shared ./dist/shared
COPY --from=build --chown=node:node /app/dist/services/inventory ./dist/services/inventory

USER node

EXPOSE 4002

CMD ["node", "dist/services/inventory/src/index.js"]