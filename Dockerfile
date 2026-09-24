FROM python:3.12-slim

WORKDIR /app
COPY dashboard/requirements-cloud.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY dashboard/ /app/dashboard/
COPY *.stil /app/stils/

ENV STIL_DIR=/app/stils
ENV HOST=0.0.0.0
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

EXPOSE 8080
WORKDIR /app/dashboard
CMD ["python", "-u", "server.py"]
