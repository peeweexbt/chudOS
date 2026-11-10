# Explicit build so Railway doesn't use Nixpacks (its npm cache mount causes EBUSY on npm ci).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server/index.js"]
