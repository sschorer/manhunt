# Manhunt — one entrypoint for every common task.
# Run `make` (or `make help`) to see everything you can do.

IMAGE ?= ghcr.io/sschorer/manhunt
TAG   ?= latest
COMPOSE ?= docker compose
COMPOSE_DEV ?= docker compose -f compose.dev.yml

.DEFAULT_GOAL := help

# ── Help ────────────────────────────────────────────────────────────────────
.PHONY: help
help: ## Show this help
	@echo "Manhunt — available commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ── Project (npm workspace) ─────────────────────────────────────────────────
.PHONY: install
install: ## Install all dependencies (server + client)
	npm install

.PHONY: dev
dev: ## Run the server with live reload (http://localhost:3000)
	npm run dev

.PHONY: dev-client
dev-client: ## Run the Vite client dev server (http://localhost:5173, proxies to the server)
	npm run dev:client

# ── Full dev stack in Docker (db + redis + server + client, live reload) ─────
.PHONY: dev-certs
dev-certs: ## Generate a locally-trusted TLS cert for LAN GPS testing (mkcert)
	scripts/dev-certs.sh

.PHONY: dev-up
dev-up: ## Start the full dev stack (Postgres, Redis, server:3000, client on https://…:5173)
	$(COMPOSE_DEV) up -d

.PHONY: dev-down
dev-down: ## Stop the dev stack
	$(COMPOSE_DEV) down

.PHONY: dev-logs
dev-logs: ## Tail logs from the dev stack
	$(COMPOSE_DEV) logs -f

.PHONY: dev-reset
dev-reset: ## Stop the dev stack and delete its data + node_modules volumes
	$(COMPOSE_DEV) down -v

.PHONY: build
build: ## Build the client into ./dist
	npm run build

.PHONY: start
start: ## Start the server serving the built client (run `make build` first)
	npm start

.PHONY: icons
icons: ## Regenerate the PWA icons (requires Python + Pillow)
	python3 client/scripts/gen-icons.py

.PHONY: lint
lint: ## Lint everything (ESLint + Stylelint + markdownlint)
	npm run lint

.PHONY: typecheck
typecheck: ## Type-check the server and client with tsc
	npm run typecheck

.PHONY: lint-fix
lint-fix: ## Auto-fix lint issues where possible
	npm run lint:fix

.PHONY: audit
audit: ## Report dependency vulnerabilities
	npm audit

.PHONY: clean
clean: ## Remove build output, test artifacts and installed dependencies
	rm -rf dist client/dist coverage \
		client/test-results client/playwright-report \
		node_modules client/node_modules

# ── Tests ───────────────────────────────────────────────────────────────────
.PHONY: test
test: ## Run unit tests (Vitest: server + client)
	npm test

.PHONY: e2e-install
e2e-install: ## Install the Chromium browser Playwright needs (one-time)
	cd client && npx playwright install --with-deps chromium

.PHONY: e2e
e2e: ## Run end-to-end tests (Playwright; builds + boots the real server)
	npm run test:e2e

.PHONY: test-all
test-all: test e2e ## Run every test suite (unit + e2e)

# ── Docker image ────────────────────────────────────────────────────────────
.PHONY: image
image: ## Build the production Docker image (override with IMAGE=... TAG=...)
	docker build -t $(IMAGE):$(TAG) .

.PHONY: docker-run
docker-run: ## Run the built image standalone on http://localhost:3000
	docker run --rm -p 3000:3000 --env-file .env $(IMAGE):$(TAG)

# ── Docker Compose (full stack: app + Caddy + Postgres + Redis) ──────────────
.PHONY: env
env: ## Create .env from .env.example if it is missing
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example — edit the secrets.")

.PHONY: up
up: env ## Start the full stack in the background
	$(COMPOSE) up -d

.PHONY: down
down: ## Stop the full stack
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart the full stack
	$(COMPOSE) restart

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f

.PHONY: ps
ps: ## Show the status of all services
	$(COMPOSE) ps

.PHONY: pull
pull: ## Pull the latest published image
	$(COMPOSE) pull

.PHONY: shell
shell: ## Open a shell inside the running app container
	$(COMPOSE) exec app sh

.PHONY: health
health: ## Check the app's /health endpoint
	curl -fsS http://localhost:3000/health && echo

.PHONY: clean-docker
clean-docker: ## Stop the stack and delete its volumes (Postgres data, Caddy certs)
	$(COMPOSE) down -v
