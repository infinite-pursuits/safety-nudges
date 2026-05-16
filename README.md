# Safety Nudges

Safety Nudges is a Chrome extension that audits chatbot conversations in real time by using an external LLM to screen for common problems.

Supported sites:
- `chatgpt.com`
- `chat.openai.com`
- `claude.ai`

## What It Does

- Watches supported chat pages after you explicitly enable it
- Reads the current exchange plus a bounded window of recent conversation history
- Sends that material to a hosted analysis route so the extension can decide whether to show a warning
- Shows an in-page nudge when a potential issue is detected
- Lets users optionally submit feedback on whether the nudge was helpful

## Analysis Routes

Safety Nudges supports one hosted path in this extension build:
- managed access using a Safety Nudges activation code

Managed access exchanges the activation email and code once for a scoped managed session. The raw activation code is not kept locally after exchange.
Managed analysis requests are relayed by Safety Nudges infrastructure to direct OpenAI or Anthropic provider accounts.

## Data Behavior

When enabled, the extension sends the current user prompt, the current assistant response, a bounded recent-history window, the page URL, and a conversation identifier to remote services so it can analyze the exchange.

Routine analysis does not by itself store chat history in Safety Nudges-hosted systems. Safety Nudges-hosted storage is used when a user explicitly opts in and submits feedback.

The extension may keep limited browser-local extension storage for functionality, including:
- scoped managed-session state
- provider settings
- recent activity-log entries shown in the popup

## Privacy Policy

The canonical public privacy policy for this extension is in [PRIVACY_POLICY.md](./PRIVACY_POLICY.md).

## Local Development

Load this directory as an unpacked extension in Chrome:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Choose `Load unpacked`
4. Select this directory

## Repo Contents

- `manifest.json`: Chrome extension manifest
- `background.js`: background service worker
- `content.js`: content script for supported chat surfaces
- `content.css`: in-page UI styles
- `popup.html`: extension popup UI
- `popup.js`: popup behavior and settings flow
- `tagging_prompt.js`: structured analysis prompt and sensitivity configuration
- `icons/`: extension icons

## Citation

If you use Safety Nudges in your research or projects, please cite:

```bibtex
@software{safety_nudges_2026,
  title = {Safety Nudges},
  author = {Yadav, Chhavi* and Wedgwood, James* and Smith, Virginia},
  year = {2026},
  url = {https://github.com/jtbwedgwood/safety-nudges},
  note = {Chrome extension for highlighting risks in AI chatbot responses in real time}
}
```

\* Equal contribution.

## Contact

For questions, feedback, or collaborations, please contact:  
[openreflection1@gmail.com](mailto:openreflection1@gmail.com)
