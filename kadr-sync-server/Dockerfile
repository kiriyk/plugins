FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . \
 && useradd --system --uid 10001 kadr \
 && mkdir /data && chown kadr /data

USER kadr
ENV KADR_DB=/data/kadr.sqlite3
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD ["python", "-m", "kadr_sync.cli", "check"]
CMD ["uvicorn", "--factory", "kadr_sync.app:from_env", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--proxy-headers"]
