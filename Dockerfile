FROM node:20-alpine

# git + openssh-client: fetch/pull app repositories (incl. SSH remotes).
# docker-cli + docker-cli-compose: drive the host Docker daemon through
# the mounted socket (compose v2 plugin; Alpine community repository,
# available since Alpine 3.15 — node:20-alpine is well past that).
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY config ./config

ENV NODE_ENV=production \
    PORT=9000 \
    CONFIG_PATH=/app/config/apps.json \
    DATA_DIR=/app/data

EXPOSE 9000
CMD ["node", "src/server.js"]
