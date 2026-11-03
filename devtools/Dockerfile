FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
WORKDIR /app
RUN pip install --no-cache-dir aiohttp==3.14.5
COPY backend /app/backend
COPY frontend /app/frontend
ENV DEVTOOLS_HOST=127.0.0.1 DEVTOOLS_PORT=7700
CMD ["python", "-u", "/app/backend/app.py"]
