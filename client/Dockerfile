FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV NITRO_PRESET=node-server
ENV VITE_API_BASE_GO=
ENV VITE_API_BASE_NODE=
ENV VITE_API_BASE_PHP=
ENV VITE_API_BASE_PYTHON=
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
