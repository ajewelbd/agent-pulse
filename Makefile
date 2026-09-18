.PHONY: help uid up down dev logs migrate migrate-status backup install-hooks uninstall-hooks test typecheck build clean

COMPOSE := docker compose
DEV     := $(COMPOSE) -f compose.yaml -f compose.dev.yaml

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

uid: ## Print the HOST_UID/HOST_GID to put in .env (git needs these to match)
	@echo "HOST_UID=$$(id -u)"
	@echo "HOST_GID=$$(id -g)"
	@echo ""
	@echo "Put these in .env. If they do not match your host user, git inside the"
	@echo "collector rejects your repos with 'detected dubious ownership' and every"
	@echo "git-based gap fill silently returns nothing."

up: ## Start postgres + migrate + collector
	$(COMPOSE) up -d --build
	@echo ""
	@echo "collector: http://127.0.0.1:4317/healthz"

dev: ## Start with source bind-mounts and hot reload
	$(DEV) up --build

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

test: ## Run unit tests
	pnpm --filter @aiuo/collector run test

build: ## Build every package
	pnpm -r run build

clean: ## Remove build output
	rm -rf packages/*/dist apps/*/dist
