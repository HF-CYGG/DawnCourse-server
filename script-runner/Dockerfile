FROM node:20-alpine
WORKDIR /runner
COPY package.json ./
COPY runner.js ./
EXPOSE 8090
CMD ["node", "runner.js"]
