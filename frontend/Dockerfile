FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY frontend ./frontend
COPY shared ./shared

RUN npx tsc --noEmit -p frontend/tsconfig.json \
    && npx vite build --config frontend/vite.config.ts

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080