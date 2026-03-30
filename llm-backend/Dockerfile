FROM node:18-alpine
# 工作目录
WORKDIR /app
# 复制运行所需文件
COPY package.json ./
COPY server.js ./
RUN npm install --only=production
# 对外暴露服务端口
EXPOSE 8080
# 启动服务
CMD ["node", "server.js"]
