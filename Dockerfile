# Multi-stage build. Once the Vite client exists (backlog: scaffold client),
# add a build stage running `npm run build` and COPY its dist/ into runtime.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY public ./public
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
