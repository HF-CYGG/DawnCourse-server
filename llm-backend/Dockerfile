FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV SCRIPT_OUTPUT_DIR=/shared/parsers
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /shared/parsers/metrics
VOLUME ["/shared/parsers"]
EXPOSE 8080
CMD ["node", "dist/main.js"]
