FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 10001 app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
USER app
ENV PORT=8082
EXPOSE 8082
ENTRYPOINT ["node", "server.js"]
