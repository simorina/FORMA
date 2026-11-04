# syntax=docker/dockerfile:1.7
# Forma, immagine CPU: provider hf_remote (Space Hugging Face) o procedural (offline).
#   docker compose up --build        ->  http://localhost:8000

FROM node:22-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH
# libopengl0/libgl1: needed by pymeshlab (the optional extra repair filters) on Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopengl0 libgl1 libglib2.0-0 libgomp1 curl \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.32
# EXTRAS="--extra meshlab" adds pymeshlab (x86_64 wheels; leave empty on ARM).
ARG EXTRAS=""
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project ${EXTRAS}
COPY backend/ ./
RUN uv sync --frozen --no-dev ${EXTRAS}
# The backend serves the built frontend from /app/frontend/dist.
COPY --from=web /src/frontend/dist /app/frontend/dist
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://127.0.0.1:8000/api/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
