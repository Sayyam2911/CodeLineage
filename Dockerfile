FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    CODELINEAGE_DATA="/tmp/codelineage"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    pip install --no-cache-dir uv==0.13.6
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    uv sync --locked --no-dev
COPY --chown=65532:65532 codelineage/ ./codelineage/
COPY --from=web --chown=65532:65532 /app/web/dist ./web/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["python"]
CMD ["-m", "uvicorn", "codelineage.main:app", "--host", "0.0.0.0", "--port", "8080"]
