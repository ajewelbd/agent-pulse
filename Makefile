.PHONY: help install uninstall uid compose-override up down dev web web-dev logs migrate migrate-status backup install-hooks uninstall-hooks test test-installer shellcheck typecheck build clean

COMPOSE := docker compose
# compose.override.yaml is auto-merged only when no -f is given, so dev names it.
DEV     := $(COMPOSE) -f compose.yaml -f compose.dev.yaml -f compose.override.yaml

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ARGS passes flags through, e.g. make install ARGS="--native --yes".
install: ## One-command install (asks Docker vs native). Flags: ARGS="--native --yes …"
	./install.sh $(ARGS)

uninstall: ## Stop and remove services; keeps the database (ARGS="--purge" deletes it)
	./install.sh --uninstall $(ARGS)

uid: ## Print the HOST_UID/HOST_GID to put in .env (git needs these to match)
	@echo "HOST_UID=$$(id -u)"
	@echo "HOST_GID=$$(id -g)"
	@echo ""
	@echo "Put these in .env. If they do not match your host user, git inside the"
	@echo "collector rejects your repos with 'detected dubious ownership' and every"
	@echo "git-based gap fill silently returns nothing."

compose-override: ## Regenerate compose.override.yaml (mounts for CODE_ROOT_2… in .env)
	@./scripts/installer/compose-override.sh

up: compose-override ## Start postgres + migrate + collector
	$(COMPOSE) up -d --build
	@echo ""
	@echo "collector: http://127.0.0.1:4317/healthz"

dev: compose-override ## Start with source bind-mounts and hot reload
	$(DEV) up --build

web: compose-override ## Start the dashboard too (read-only) at http://127.0.0.1:3000
	$(COMPOSE) --profile phase5 up -d --build
	@echo ""
	@echo "dashboard: http://127.0.0.1:3000"

web-dev: compose-override ## Dashboard with hot reload
	$(DEV) --profile phase5 up --build web

down: ## Stop everything. Keeps your data.
	$(COMPOSE) down
	@echo "Data kept. 'docker compose down -v' would have deleted it — see 'make backup'."

logs: ## Follow collector logs
	$(COMPOSE) logs -f collector

migrate: ## Run pending migrations (one-shot service)
	$(COMPOSE) run --rm migrate

migrate-status: ## Show applied/pending migrations
	$(COMPOSE) run --rm migrate node packages/schema/dist/migrate.js status

backup: ## pg_dump into ./backups
	@mkdir -p backups
	$(COMPOSE) exec -T postgres pg_dump -Fc -U $${POSTGRES_USER:-aiuo} $${POSTGRES_DB:-aiuo} \
	  > backups/aiuo-$$(date -u +%Y%m%dT%H%M%SZ).dump
	@ls -lh backups | tail -1

install-hooks: ## Install agent hooks on the HOST (idempotent, backs up, prints uninstall)
	./scripts/install-hooks.sh

uninstall-hooks: ## Remove the agent hooks this project installed
	./scripts/install-hooks.sh --uninstall

typecheck: ## Typecheck every package
	pnpm -r run typecheck

test: ## Run unit tests (collector, web, installer)
	pnpm --filter @agentpulse/collector run test
	pnpm --filter @agentpulse/web run test
	./scripts/installer/tests/run.sh

test-installer: ## Installer tests only (plain bash; no Docker or network needed)
	./scripts/installer/tests/run.sh

# shellcheck from PATH, else its official image. Dev-only: nothing at runtime needs it.
SHELL_SCRIPTS := install.sh scripts/install-hooks.sh scripts/installer/*.sh scripts/installer/tests/*.sh
shellcheck: ## Lint every shell script
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck -x -s bash $(SHELL_SCRIPTS); \
	else docker run --rm -v "$$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x -s bash $(SHELL_SCRIPTS); fi

build: ## Build every package
	pnpm -r run build

clean: ## Remove build output
	rm -rf packages/*/dist apps/*/dist apps/web/.test-out
