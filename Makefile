# Forma — comandi di sviluppo. `make help` per l'elenco.
.PHONY: help install install-gpu dev offline backend frontend test e2e lint build serve docker docker-gpu clean

PORT ?= 8000

help: ## questo elenco
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

install: ## dipendenze di backend (uv) e frontend (npm)
	cd backend && uv sync
	cd frontend && npm ci

install-gpu: ## extra per l'inferenza locale su GPU NVIDIA (poi i pacchetti dei modelli: vedi README)
	cd backend && uv sync --extra gpu

dev: ## backend con reload + frontend Vite insieme: http://localhost:5173
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port $(PORT)) & \
	(cd frontend && npm run dev) & \
	wait

offline: ## come dev, ma senza rete né token: forme procedurali
	GEN_PROVIDER=procedural $(MAKE) dev

backend: ## solo il backend con reload
	cd backend && uv run uvicorn app.main:app --reload --host 127.0.0.1 --port $(PORT)

frontend: ## solo il frontend Vite
	cd frontend && npm run dev

test: ## pytest + vitest
	cd backend && uv run pytest
	cd frontend && npm test

e2e: build ## flussi end-to-end in Chromium (Playwright) su dati temporanei e provider offline
	@data=$$(mktemp -d); \
	(cd backend && GEN_PROVIDER=procedural DATA_DIR="$$data" exec uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 >/dev/null 2>&1) & api=$$!; \
	(cd frontend && exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 >/dev/null 2>&1) & web=$$!; \
	for i in $$(seq 1 60); do curl -sf http://127.0.0.1:8000/api/health >/dev/null && curl -sf http://127.0.0.1:4173/ >/dev/null && break; sleep 0.5; done; \
	FORMA_E2E=1 node frontend/e2e/flows.cjs; status=$$?; \
	kill $$api $$web 2>/dev/null; wait $$api $$web 2>/dev/null; rm -rf "$$data"; exit $$status

lint: ## ruff + typecheck TypeScript
	cd backend && uv run ruff check .
	cd frontend && npm run typecheck

build: ## build di produzione del frontend (frontend/dist)
	cd frontend && npm run build

serve: build ## tutto da un solo server: http://localhost:8000
	cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port $(PORT)

docker: ## immagine CPU con docker compose: http://localhost:8000
	docker compose up --build

docker-gpu: ## immagine CUDA (profilo gpu): http://localhost:8001
	docker compose --profile gpu up --build forma-gpu

clean: ## rimuove build e cache (non i modelli in backend/data)
	rm -rf frontend/dist backend/.pytest_cache backend/.ruff_cache
