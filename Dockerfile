FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tools ./tools
COPY web ./web
# Detrás del proxy del hosting (Easypanel, Render, Fly): se confía en X-Forwarded-* para ver la IP real del usuario.
# PORT lo inyectan algunos hosting; si no, 8000.
CMD ["sh", "-c", "uvicorn tools.server:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
