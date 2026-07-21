# Stage 1 — build the Vite client into /app/dist.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY client/package.json ./client/
RUN npm install
COPY . .
RUN npm run build

# Stage 2 — install server production dependencies only (skip the client workspace).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-workspaces

# Stage 3 — slim runtime image.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY db ./db
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
USER node
CMD ["node", "server/index.js"]
