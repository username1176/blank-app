# =============================================================================
# Warehouse Materials Intelligence Platform — database helpers
# =============================================================================
# Requires Docker and docker compose (v2).
# All flyway commands run via the official Flyway Docker image so no local
# Java installation is needed.
#
# Usage:
#   make migrate          — apply pending migrations (local env)
#   make migrate-info     — show migration status
#   make migrate-validate — validate applied migrations against files
#   make seed             — apply dev seed data (V100)
#   make rollback V=5     — manually apply the U<V> rollback script
#   make db-reset         — drop + recreate the dev DB and re-migrate from scratch
#   make db-clean         — Flyway clean (drops all objects in managed schemas)
#   make psql             — open a psql shell in the dev DB container

FLYWAY_IMAGE   := redgate/flyway:latest
FLYWAY_ENV     ?= local
PROJECT_ROOT   := $(shell pwd)

# ---------------------------------------------------------------------------
# Docker Compose targets
# ---------------------------------------------------------------------------

.PHONY: up
up:                ## Start TimescaleDB container
	docker compose up -d db

.PHONY: down
down:              ## Stop and remove containers (keeps volumes)
	docker compose down

.PHONY: psql
psql:              ## Open interactive psql session in the dev DB
	docker compose exec db psql -U postgres -d warehouse_dev

# ---------------------------------------------------------------------------
# Flyway wrapper — runs the official image against the project root
# ---------------------------------------------------------------------------
FLYWAY := docker run --rm \
	--network host \
	-v "$(PROJECT_ROOT)/db:/flyway/sql" \
	-v "$(PROJECT_ROOT)/flyway.toml:/flyway/flyway.toml" \
	--env FLYWAY_URL \
	--env FLYWAY_USER \
	--env FLYWAY_PASSWORD \
	$(FLYWAY_IMAGE)

.PHONY: migrate
migrate:           ## Apply all pending versioned migrations
	$(FLYWAY) -locations="filesystem:/flyway/sql/migrations" \
	          -environment=$(FLYWAY_ENV) migrate

.PHONY: migrate-info
migrate-info:      ## Show current migration status
	$(FLYWAY) -locations="filesystem:/flyway/sql/migrations" \
	          -environment=$(FLYWAY_ENV) info

.PHONY: migrate-validate
migrate-validate:  ## Validate checksums of applied migrations
	$(FLYWAY) -locations="filesystem:/flyway/sql/migrations" \
	          -environment=$(FLYWAY_ENV) validate

.PHONY: seed
seed:              ## Apply dev seed data (V100__dev_seed.sql)
	$(FLYWAY) -locations="filesystem:/flyway/sql/migrations,filesystem:/flyway/sql/seeds" \
	          -environment=$(FLYWAY_ENV) migrate

.PHONY: db-clean
db-clean:          ## Drop all Flyway-managed objects (destructive!)
	$(FLYWAY) -environment=$(FLYWAY_ENV) clean

.PHONY: db-reset
db-reset: db-clean seed  ## Wipe schema and reseed from scratch

# ---------------------------------------------------------------------------
# Manual rollback helper
# ---------------------------------------------------------------------------
# Usage: make rollback V=7   → applies db/rollbacks/U7__*.sql directly via psql
#
# Flyway community edition does not support undo migrations natively.
# These scripts are applied by hand when you need to step back a version.

.PHONY: rollback
rollback:          ## Apply rollback script for version V=<n>  e.g. make rollback V=7
ifndef V
	$(error V is required. Usage: make rollback V=<version_number>)
endif
	@SCRIPT=$$(ls db/rollbacks/U$(V)__*.sql 2>/dev/null | head -1); \
	if [ -z "$$SCRIPT" ]; then \
	    echo "ERROR: no rollback script found for version $(V) in db/rollbacks/"; \
	    exit 1; \
	fi; \
	echo "Applying rollback: $$SCRIPT"; \
	docker compose exec -T db psql -U postgres -d warehouse_dev < "$$SCRIPT"

# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------
.PHONY: help
help:              ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) \
	    | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
