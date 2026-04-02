FROM nginx:alpine
RUN apk add --no-cache nodejs npm redis
WORKDIR /app
COPY ./html /usr/share/nginx/html
COPY ./version.json /usr/share/nginx/html/version.json
COPY ./nginx.conf /etc/nginx/nginx.conf
COPY ./llm-backend/package.json /app/llm-backend/package.json
COPY ./llm-backend/package-lock.json /app/llm-backend/package-lock.json
RUN cd /app/llm-backend && npm ci --omit=dev
COPY ./llm-backend/server.js /app/llm-backend/server.js
COPY ./start.sh /app/start.sh
RUN chmod +x /app/start.sh && mkdir -p /shared/parsers /data
VOLUME ["/shared/parsers", "/data"]
EXPOSE 80
EXPOSE 15000
CMD ["/app/start.sh"]
