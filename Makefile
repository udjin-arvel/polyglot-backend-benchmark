.PHONY: up down ps logs reseed smoke bench lint gen\:api

COMPOSE := docker compose
PROJECT := polyglot-backend-benchmark
NET := $(PROJECT)_polyglot-net

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

reseed:
	$(COMPOSE) down -v
	$(MAKE) up

smoke:
	docker run --rm --network $(NET) \
	  -v "$(CURDIR)/scripts:/scripts:ro" \
	  -e SMOKE_GO=http://backend-go:8081 \
	  -e SMOKE_NODE=http://backend-node:8082 \
	  -e SMOKE_PHP=http://backend-php-nginx:8083 \
	  -e SMOKE_PY=http://backend-python:8084 \
	  alpine:3.20 sh -c "apk add --no-cache curl jq >/dev/null && sh /scripts/smoke.sh"

bench:
	$(COMPOSE) --profile bench run --rm bench /bench/run-all.sh

bench-quick:
	BENCH_QUICK=1 $(COMPOSE) --profile bench run --rm -e BENCH_QUICK=1 bench /bench/run-all.sh

publish-bench:
	sh scripts/publish-bench-results.sh bench/results client/public/bench

lint:
	cd backends/go && golangci-lint run ./...
	npm run lint --prefix client
	ruff check backends/python

gen-api:
	cd client && npx --yes openapi-typescript ../contract/openapi.yaml -o src/lib/schema.d.ts
