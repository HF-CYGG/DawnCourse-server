FROM node:20-alpine AS backend-build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/llm-backend
COPY ./llm-backend/package.json ./llm-backend/package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci
COPY ./llm-backend/tsconfig.json ./
COPY ./llm-backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM nginx:alpine
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN apk add --no-cache nodejs npm redis postgresql postgresql-client
WORKDIR /app

COPY ./html /usr/share/nginx/html
COPY ./version.json /usr/share/nginx/html/version.json
COPY ./nginx.conf /etc/nginx/nginx.conf

COPY ./llm-backend/package.json /app/llm-backend/package.json
COPY ./llm-backend/migrations /app/llm-backend/migrations
COPY --from=backend-build /app/llm-backend/node_modules /app/llm-backend/node_modules
COPY --from=backend-build /app/llm-backend/dist /app/llm-backend/dist

COPY ./script-runner/package.json /app/script-runner/package.json
COPY ./script-runner/runner.js /app/script-runner/runner.js

COPY ./start.sh /app/start.sh
RUN chmod +x /app/start.sh && mkdir -p /shared/parsers /data /run/redis /run/postgresql
VOLUME ["/shared/parsers", "/data"]
EXPOSE 80
EXPOSE 15000
# 单容器镜像与 docker-compose 共用同一健康检查口径，确认 nginx 与后端链路都可用。
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD wget -q -O - http://127.0.0.1/health >/dev/null 2>&1 || exit 1
CMD ["/app/start.sh"]
