FROM nginx:alpine
COPY ./html /usr/share/nginx/html
COPY ./version.json /usr/share/nginx/html/version.json
COPY ./nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
EXPOSE 15000
