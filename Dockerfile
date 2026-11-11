# Runs on any host that accepts a Dockerfile (Railway, Fly.io, Render, a VPS...).
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# All records live here. Attach a persistent volume at /data or they are lost on every redeploy.
# (Runs as root because hosted volumes are usually mounted root-owned.)
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
