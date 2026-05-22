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
CMD ["/app/start.sh"]
