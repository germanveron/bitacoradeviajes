FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tools ./tools
COPY web ./web
# Render, Cloud Run y Fly inyectan PORT.
CMD ["sh", "-c", "uvicorn tools.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
