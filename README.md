# Safety Nudges Extension

This directory contains the active Step 2 Chrome extension baseline.

What is implemented:
- Manifest V3 extension wiring limited to ChatGPT surfaces (`chatgpt.com` and `chat.openai.com`).
- A background service worker that can call OpenAI directly, call Ollama's local `/api/chat` endpoint, or POST to a custom local analysis endpoint, then normalize Step 1-style results.
- A content script that watches the ChatGPT conversation DOM, waits for a quiet period after mutations, and extracts the latest user prompt plus assistant response.
- A small lower-right in-page nudge that stays hidden unless an issue is detected (or debug mode is enabled).
- A judgments-panel feedback flow with thumbs up/down, an optional short comment, inline consent copy, and a mock transport that records the future submission contract without persisting data yet.
- A popup that lets you store your OpenAI API key locally inside the extension, switch providers, configure an Ollama model, and watch a live activity log.

Testing visibility:
- The background service worker logs request start, response receipt, latency, provider-specific metadata, no-issue completions, issue detections, and failures to the extension console.
- The popup shows the same recent activity log so you can confirm the flow worked even when no issue was detected.

Using Ollama:
- Install and run Ollama locally so the default API is available at `http://127.0.0.1:11434/api/chat`.
- Pull a local model first, for example `ollama pull llama3.1:8b`.
- If you use the extension's direct `Ollama (local model)` provider, Ollama must allow the extension origin. Start it with `OLLAMA_ORIGINS="chrome-extension://*"` (or your exact extension origin) before loading the extension.
- To avoid changing Ollama's origin settings, run the local bridge in this repo and choose `Local endpoint` instead. That mirrors Rescriber's architecture: the extension talks to a local app server, and the server talks to Ollama.
- In the extension popup, choose `Ollama (local model)`, keep the default endpoint unless your setup differs, and set the installed model name.
- The extension sends a non-streaming chat request with `format: "json"` and expects the model to return JSON in `message.content`.

Running the local bridge:
- Create the repo virtualenv if it does not exist: `python3 -m venv .venv`
- Activate it: `source .venv/bin/activate`
- Install dependencies: `python -m pip install -r requirements.txt`
- Start the bridge: `python -m safety_nudges.extension.ollama_bridge`
- In the extension popup, choose `Local endpoint` and use `http://127.0.0.1:8787/analyze`

What is intentionally stubbed:
- Hardening the ChatGPT DOM selectors beyond the current baseline heuristics.
- Feedback persistence. `SAFETY_NUDGES_SUBMIT_JUDGMENT_FEEDBACK` currently routes to a background-worker no-op/mock that logs a receipt and payload summary only.

Judgment feedback contract:
- Event name: `judgment_feedback_submitted`
- Payload keys: `schema_version`, `source`, `submitted_at`, `page_url`, `conversation_id`, `turn_id`, `model_id`, `rating`, `comment`, `consent`, `judgment`, `latest_turn`, `chat_history`, `flags`
- Consent contract: `consent.share_chat_history=true` and `consent.purposes=["research","training","product_improvement"]`
- Judgment metadata for later API wiring: `conversation_id` as chat ID, `turn_id` as the judged-turn fingerprint, `model_id` from the analyzer result when available, plus `flags` for mock transport and anti-spam rules

Failure and anti-spam behavior:
- Offline submit attempts fail inline with a retryable message and do not send the mock event.
- Only one successful submission is allowed per judged response fingerprint.
- Comment length is capped at 280 characters.
- Submit stays disabled while a request is in flight so repeated clicks do not duplicate events.

Load this directory as an unpacked extension in Chrome to continue Step 2 development.
