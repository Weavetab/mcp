FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production

FROM node:26-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*
 
RUN groupadd -r weavetab && useradd -r -g weavetab -d /home/weavetab -s /sbin/nologin weavetab
RUN mkdir -p /home/weavetab/.weavetab && chown -R weavetab:weavetab /home/weavetab

ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV WEAVETAB_HEADLESS=true
ENV CHROMIUM_FLAGS="--no-first-run --no-default-browser-check --disable-dev-shm-usage"

COPY --from=build /app /app
WORKDIR /app

USER weavetab
EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
