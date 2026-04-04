FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

EXPOSE 18789

CMD ["node", "dist/index.js", "gateway", "start"]
