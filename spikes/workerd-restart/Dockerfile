FROM node:24-bookworm-slim AS fetch
WORKDIR /fetch
RUN npm init -y >/dev/null && npm install --no-audit --no-fund workerd@1.20260911.1

FROM debian:bookworm-slim
COPY --from=fetch /fetch/node_modules/@cloudflare/workerd-linux-64/bin/workerd /usr/local/bin/workerd
WORKDIR /app
COPY config.capnp worker.js ./
VOLUME /data
EXPOSE 8080
CMD ["workerd", "serve", "/app/config.capnp", "--verbose"]
