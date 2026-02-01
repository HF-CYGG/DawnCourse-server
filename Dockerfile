FROM nginx:alpine

# Copy static assets to default nginx public folder
COPY . /usr/share/nginx/html

# Expose port 80
EXPOSE 80
