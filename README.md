# Safety Nudges Extension

This directory contains the active Step 2 Chrome extension baseline.

What is implemented:
- Manifest V3 extension wiring for ChatGPT surfaces (`chatgpt.com` and `chat.openai.com`) plus Claude web (`claude.ai`).
- A background service worker that can call OpenAI directly, call Anthropic directly, or route managed access through Supabase, then normalize Step 1-style results.
- A content script with host adapters for ChatGPT-style and Claude-style DOMs that waits for a quiet period after mutations and extracts the latest user prompt plus assistant response.
- A small lower-right in-page nudge that stays hidden unless an issue is detected (or debug mode is enabled).
- A judgments-panel feedback flow with thumbs up/down, an optional short comment, an explicit consent checkbox, and direct Supabase persistence for submitted feedback.
- A popup redesigned around nontechnical use: first-run activation-code vs advanced setup, a simple provider selector, a prominent play/pause control, and an advanced screen for manual OpenAI/Anthropic keys and logs.

Testing visibility:
- The background service worker logs request start, response receipt, latency, provider-specific metadata, no-issue completions, issue detections, and failures to the extension console.
- The popup shows the same recent activity log so you can confirm the flow worked even when no issue was detected.

Using Anthropic:
- Open `Advanced settings`, paste an Anthropic API key, then choose `Anthropic` from the main provider selector.
- The extension uses Anthropic's Messages API and expects the model to return JSON matching the Step 1 issue schema.
- Manual Anthropic key entry should remain available even if the future alpha onboarding flow provisions managed credentials through Supabase Edge Functions.

Using the popup:
- On first run, users choose between `Use activation code` and `Advanced setup`.
- `Use activation code` exchanges the user's email plus Safety Nudges activation code with the hosted Supabase Edge Function, receives a scoped managed session, and persists only that managed session locally for later sessions.
- `Advanced setup` keeps manual OpenAI and Anthropic API key entry available, but those manual provider keys are kept only for the current browser session.
- After setup, the main screen exposes only three provider choices: `OpenAI`, `Anthropic`, and `Complementary provider` (`OpenAI` on `claude.ai`, `Anthropic` on `chatgpt.com`).
- Settings save automatically when changed.
- The prominent play/pause button controls whether the extension analyzes anything at all. When paused, the content script should not show a transient `Checking response...` state.

What is intentionally stubbed:
- Hardening the host-adapter selectors against large upstream DOM churn beyond the current ChatGPT/Claude baseline heuristics.

Judgment feedback contract:
- Event name: `judgment_feedback_submitted`
- Payload keys: `schema_version`, `source`, `submitted_at`, `page_url`, `conversation_id`, `turn_id`, `model_id`, `rating`, `comment`, `consent`, `judgment`, `latest_turn`, `chat_history`, `flags`
- Consent contract: explicit opt-in is required before submit, with `consent.share_chat_history=true` and `consent.purposes=["research","training","product_improvement"]`
- Judgment metadata for later API wiring: `conversation_id` as chat ID, `turn_id` as the judged-turn fingerprint, `model_id` from the analyzer result when available, plus `flags` for mock transport and anti-spam rules

Feedback ingestion:
- Transport: direct POST from the extension background worker to Supabase REST
- Storage: `public.feedback_judgments` in Supabase Postgres
- Idempotency: one row per judged response via a unique `(conversation_id, turn_id)` index
- Raw auditability: each row stores extracted analytical columns plus a minimized `raw_payload` audit object

Failure and anti-spam behavior:
- Offline submit attempts fail inline with a retryable message and do not send the mock event.
- Only one successful submission is allowed per judged response fingerprint.
- Comment length is capped at 280 characters.
- Submit stays disabled while a request is in flight so repeated clicks do not duplicate events.

Load this directory as an unpacked extension in Chrome to continue Step 2 development.

Automated browser harness:
- For deterministic end-to-end extension validation, use the local fixture harness documented in `docs/extension/extension_automation_harness.md`.
- The harness launches the real unpacked extension in Chrome, configures the popup automatically, serves ChatGPT-like and Claude-like fixtures on `127.0.0.1`, and drives assertions for panels, highlights, tooltips, invalid spans, and error states.
- For the Claude DOM path specifically, use `python -m safety_nudges.extension.browser_harness fixture-probe --scenario claude-highlight --json`.
- For real-page feedback verification without spending OpenAI tokens, use `python -m safety_nudges.extension.browser_harness chatgpt-feedback-e2e --json`.
- Live `claude.ai` smoke validation is intentionally separate from the deterministic harness path because it requires an authenticated Claude session/profile.
