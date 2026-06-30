#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"
if [[ "${OLLAMA_HOST}" == http://* || "${OLLAMA_HOST}" == https://* ]]; then
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-${OLLAMA_HOST}}"
else
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://${OLLAMA_HOST}}"
fi
export OLLAMA_BASE_URL OLLAMA_MODEL

BACKEND_PID=""
FRONTEND_PID=""
OLLAMA_PID=""

cleanup() {
  echo
  echo "Stopping Orgarhythmus dev stack..."
  if [[ -n "${FRONTEND_PID}" ]] && kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${OLLAMA_PID}" ]] && kill -0 "${OLLAMA_PID}" 2>/dev/null; then
    kill "${OLLAMA_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

wait_for_ollama() {
  for _ in {1..40}; do
    if OLLAMA_HOST="${OLLAMA_HOST}" ollama list >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "Starting Orgarhythmus dev stack..."
echo "Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo "Ollama:   ${OLLAMA_BASE_URL}"
echo

if command -v ollama >/dev/null 2>&1; then
  if OLLAMA_HOST="${OLLAMA_HOST}" ollama list >/dev/null 2>&1; then
    echo "Ollama is already running."
  else
    echo "Starting Ollama on ${OLLAMA_HOST}..."
    OLLAMA_HOST="${OLLAMA_HOST}" ollama serve &
    OLLAMA_PID=$!
    if ! wait_for_ollama; then
      echo "Warning: Ollama did not become ready. AI headline suggestions will fall back."
    fi
  fi

  if OLLAMA_HOST="${OLLAMA_HOST}" ollama list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fxq "${OLLAMA_MODEL}"; then
    echo "Ollama model ready: ${OLLAMA_MODEL}"
  else
    echo "Warning: Ollama model '${OLLAMA_MODEL}' is not installed."
    echo "Install it with: ollama pull ${OLLAMA_MODEL}"
  fi
else
  echo "Warning: ollama command not found. AI headline suggestions will fall back."
fi

echo
echo "Starting backend..."
./.venv/bin/uvicorn main:app --reload --host "${BACKEND_HOST}" --port "${BACKEND_PORT}" &
BACKEND_PID=$!

echo "Starting frontend..."
npm run dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}" &
FRONTEND_PID=$!

echo
echo "All services started. Press Ctrl+C to stop."
wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
