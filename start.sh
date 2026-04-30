#!/bin/bash
set -e

PORT=$1

if [ -z "$PORT" ]; then
  echo "Usage: ./start.sh <PORT>"
  exit 1
fi

export APP_PORT=$PORT
docker-compose up --build -d
echo "Stock Market running at http://localhost:$PORT"