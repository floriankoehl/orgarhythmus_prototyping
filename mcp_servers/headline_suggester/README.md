# Headline suggester MCP server

A tiny local MCP server that proposes a new note headline from a note description.

It exposes one tool:

- `propose_note_headline`

Input:

```json
{
  "description": "Long note body or HTML",
  "currentHeadline": "Optional current headline",
  "style": "Optional style hint",
  "maxWords": 7
}
```

Output:

```json
{
  "headline": "Suggested Headline",
  "provider": "ollama",
  "providerError": null
}
```

## Run locally with Ollama

Ollama is the default provider.

```bash
ollama serve
ollama pull qwen2.5:7b
python3 mcp_servers/headline_suggester/server.py
```

Recommended local models for an 8 GB VRAM / 32 GB RAM laptop:

- `qwen2.5:7b` — recommended default; good for headlines now and structured classification later
- `llama3.1:8b` — strong general local model; also plausible on this machine
- `llama3.2:3b` — very light fallback if you want maximum speed

Configure the model:

```bash
HEADLINE_PROVIDER=ollama \
OLLAMA_MODEL=qwen2.5:7b \
python3 mcp_servers/headline_suggester/server.py
```

The default local-model timeout is 90 seconds so the first cold Ollama call has enough time to load the model. You can override it:

```bash
HEADLINE_TIMEOUT_SECONDS=30
```

If Ollama is not running or the model is missing, the server falls back to a deterministic local heuristic so the tool remains usable.

## Future API-key / frontier-model mode

The server already has an OpenAI-compatible provider:

```bash
HEADLINE_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-4.1-mini \
python3 mcp_servers/headline_suggester/server.py
```

For OpenAI-compatible gateways, set:

```bash
OPENAI_BASE_URL=https://your-compatible-endpoint/v1
```

## MCP client config example

Add something like this to your MCP client config:

```json
{
  "mcpServers": {
    "orgarhythmus-headline": {
      "command": "python3",
      "args": [
        "/home/florian/Desktop/personal/orgaryhthmus_prototypes/goals/mcp_servers/headline_suggester/server.py"
      ],
      "env": {
        "HEADLINE_PROVIDER": "ollama",
        "OLLAMA_MODEL": "qwen2.5:7b"
      }
    }
  }
}
```

## Manual smoke test

The server also accepts newline-delimited JSON for simple testing:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"propose_note_headline","arguments":{"description":"We need to refactor the Gantt hierarchy rendering so filtered child notes still show their parent path.","maxWords":6}}}' \
  | python3 mcp_servers/headline_suggester/server.py
```
