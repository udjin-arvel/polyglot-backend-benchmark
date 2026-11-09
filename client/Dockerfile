FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NITRO_PRESET=node-server
ENV VITE_API_BASE_GO=/api/go/
ENV VITE_API_BASE_NODE=/api/node/
ENV VITE_API_BASE_PHP=/api/php/
ENV VITE_API_BASE_PYTHON=/api/python/
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache wget nodejs
COPY --from=build /app/.output /app/.output
COPY nginx.conf /etc/nginx/nginx.conf
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/ || exit 1
ENTRYPOINT ["/entrypoint.sh"]
