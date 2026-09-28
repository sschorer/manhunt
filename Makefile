# Manhunt — one entrypoint for every common task.
# Run `make` (or `make help`) to see everything you can do.

IMAGE ?= ghcr.io/sschorer/manhunt
TAG   ?= latest
# The self-hosted workerd stack. Its settings live in deploy/.env, which Compose
# reads because the compose file's directory is the project directory.
COMPOSE ?= docker compose -f deploy/compose.yml

.DEFAULT_GOAL := help

# ── Help ────────────────────────────────────────────────────────────────────
.PHONY: help
help: ## Show this help
	@echo "Manhunt — available commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ── Development ─────────────────────────────────────────────────────────────
.PHONY: install
install: ## Install all dependencies
	npm install

.PHONY: dev
dev: ## Run the PWA and the Worker in local workerd (http://localhost:5173)
	npm run dev

.PHONY: dev-certs
dev-certs: ## Generate a locally-trusted TLS cert for LAN GPS testing (mkcert)
	scripts/dev-certs.sh

.PHONY: build
build: ## Build the PWA into ./dist and the Worker into ./dist-worker
	npm run build

.PHONY: vapid-keys
vapid-keys: ## Generate a VAPID key pair for Web Push
	npm run vapid:keys

.PHONY: icons
icons: ## Regenerate the PWA icons (requires Python + Pillow)
	python3 client/scripts/gen-icons.py

.PHONY: lint
lint: ## Lint everything (ESLint + Stylelint + markdownlint)
	npm run lint

.PHONY: lint-fix
lint-fix: ## Auto-fix lint issues where possible
	npm run lint:fix

.PHONY: typecheck
typecheck: ## Type-check the backend and the client with tsc
	npm run typecheck

.PHONY: audit
audit: ## Report dependency vulnerabilities
	npm audit

.PHONY: clean
clean: ## Remove build output, test artifacts and installed dependencies
	rm -rf dist dist-worker dist-assets coverage \
		client/test-results client/playwright-report \
		node_modules client/node_modules

# ── Tests ───────────────────────────────────────────────────────────────────
.PHONY: test
test: ## Run unit tests (Vitest: game core, shared, Worker, client)
	npm test

.PHONY: e2e-install
e2e-install: ## Install the Chromium browser Playwright needs (one-time)
	cd client && npx playwright install --with-deps chromium

.PHONY: e2e
e2e: ## Run end-to-end tests (Playwright; builds, then runs the Worker in workerd)
	npm run test:e2e

.PHONY: test-all
test-all: test e2e ## Run every test suite (unit + e2e)

# ── The Docker image ────────────────────────────────────────────────────────
.PHONY: image
image: ## Build the workerd image (override with IMAGE=... TAG=...)
	docker build -f deploy/Dockerfile -t $(IMAGE):$(TAG) .

.PHONY: docker-dev
docker-dev: TAG = dev
docker-dev: image ## Build and run the image locally (https://localhost)
	DOMAIN=localhost COMPOSE_PROFILES=caddy IMAGE=$(IMAGE) TAG=$(TAG) \
		$(COMPOSE) up -d --wait
	@echo ""
	@echo "Manhunt is on https://localhost — Caddy's own CA signed the certificate,"
	@echo "so the browser will warn once. Stop it again with 'make down'."

.PHONY: docker-e2e
docker-e2e: TAG = dev
docker-e2e: image ## Play a real Game against the image, then replace the container
	IMAGE=$(IMAGE) TAG=$(TAG) npm run test:docker

# ── Running the self-hosted stack ───────────────────────────────────────────
.PHONY: env
env: ## Create deploy/.env from deploy/.env.example if it is missing
	@test -f deploy/.env || (cp deploy/.env.example deploy/.env \
		&& echo "Created deploy/.env from the example — set DOMAIN.")

.PHONY: up
up: env ## Start the stack (deploy/.env picks the proxy)
	$(COMPOSE) up -d --wait

.PHONY: down
# `--profile "*"` so whichever proxy is running is stopped too.
down: ## Stop the stack, leaving the Games on the volume
	$(COMPOSE) --profile "*" down --remove-orphans

.PHONY: reset
reset: ## Stop the stack and delete its Games
	$(COMPOSE) --profile "*" down -v --remove-orphans

.PHONY: pull
pull: ## Pull the published image, then restart into it with `make up`
	$(COMPOSE) pull

.PHONY: ps
ps: ## Show the status of the stack's services
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail the stack's logs
	$(COMPOSE) logs -f

.PHONY: health
health: ## Read /health from the running container (ok, version, protocol)
	$(COMPOSE) exec app curl -fsS http://127.0.0.1:8080/health && echo

.PHONY: shell
shell: ## Open a shell inside the running app container
	$(COMPOSE) exec app sh
