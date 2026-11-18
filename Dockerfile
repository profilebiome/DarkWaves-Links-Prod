# Imagen para cualquier host que corra Docker (Railway, Fly.io, VPS…).
#   docker build -t darkwaves .
#   docker run -p 4321:4321 -v darkwaves-data:/var/data -e NODE_ENV=production \
#     -e DARKWAVES_DATA_DIR=/var/data/data -e DARKWAVES_MUSIC_DIR=/var/data/music darkwaves
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=production \
    PORT=4321 \
    DARKWAVES_DATA_DIR=/var/data/data \
    DARKWAVES_MUSIC_DIR=/var/data/music

RUN mkdir -p /var/data/data /var/data/music && chown -R node:node /var/data /app

USER node

EXPOSE 4321
VOLUME ["/var/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
