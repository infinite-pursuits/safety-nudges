# Safety Nudges Privacy Policy

This privacy policy applies to the Safety Nudges Chrome extension.

## TL;DR

To analyze chatbot responses, Safety Nudges sends the current exchange plus a bounded window of recent conversation history to remote services: Safety Nudges managed infrastructure and direct OpenAI or Anthropic provider accounts.

Safety Nudges does not store routine-analysis chat content in Safety Nudges-hosted systems just because analysis runs. We store chat-related data in Safety Nudges-hosted systems only if you explicitly submit feedback and agree to share it with us.

## What Safety Nudges Sends During Analysis

The extension starts paused when first installed. When Safety Nudges is enabled, it sends:
- the current user prompt
- the current assistant response
- a bounded window of recent conversation history from the same chat
- the current supported page URL
- a conversation identifier derived from the page when available

Analysis traffic goes through Safety Nudges managed infrastructure and then to OpenAI or Anthropic.

## What Safety Nudges Stores

Safety Nudges stores chat-related data in Safety Nudges-hosted systems only when you explicitly submit feedback and opt in to share it.

That feedback payload may include:
- the current page URL
- the latest prompt and response for the judged exchange
- the extracted chat history visible at submission time
- your feedback rating
- your optional comment
- judgment metadata
- consent metadata

If you are in a pilot study, a pseudonymous participant ID may also be attached to your feedback so researchers can group feedback from the same participant over time.

## What Safety Nudges Does Not Store By Default

Safety Nudges does not store routine-analysis chat history in its database merely because ordinary analysis runs.

Safety Nudges also does not persist:
- the raw activation email
- the raw activation code

## Local Browser Storage

To support extension functionality, Safety Nudges may keep limited data in the browser's extension storage, including:
- a scoped managed session token and refresh token for managed access
- non-sensitive provider settings
- recent activity-log entries visible in the popup

These browser-local records are not the same as storing chat data in Safety Nudges-hosted systems. They remain on the user's device unless the user separately chooses a feature that transmits data, such as feedback submission.

## How We Use Data

We use analysis data to generate the Safety Nudges warning shown in the extension.

We use explicitly submitted feedback to:
- evaluate warning quality
- improve the product
- support research and evaluation
- build or improve training and evaluation datasets

Submitted feedback may be manually reviewed by researchers or operators.

## Third Parties

Safety Nudges uses:
- Safety Nudges managed infrastructure for request routing and managed access
- OpenAI and Anthropic for hosted model inference
- Supabase for backend infrastructure and feedback storage

## Your Choices

- You can pause Safety Nudges at any time.
- Safety Nudges starts paused when first installed and stays paused until you turn it on.
- If you leave it paused or uninstall it, analysis stops.
- You do not need to submit feedback to use the extension.
- If you do not want Safety Nudges to store chat details, do not submit feedback.

## Sensitive Information

Do not use Safety Nudges on chats or feedback comments containing especially sensitive personal, medical, legal, financial, account, or other confidential information unless you are comfortable with that information being processed by Safety Nudges and OpenAI or Anthropic.

## Retention

Submitted non-test feedback records are deleted on a rolling basis after 180 days.

A record may be kept longer only if an explicit retention hold is applied for security review, abuse investigation, legal compliance, or another documented operational need.

## Credentials And Sessions

If you use a Safety Nudges activation code, the extension exchanges it once for a scoped managed session. Ordinary analysis requests then use that managed session instead of resending the activation code.

Managed-session lifecycle:
- access token lifetime: 12 hours
- refresh token lifetime: 30 days
- token rotation occurs on refresh
- re-onboarding is required after expiry or revocation

## Deletion Requests

Deletion requests can be sent to the privacy/support contact below. Because ordinary feedback does not require a direct real-world identifier, we may need enough detail to locate the correct record, such as timing, page URL, rating, optional comment text, or a pseudonymous participant ID when applicable.

## Contact

Support and privacy contact: `jwedgwoo@cs.cmu.edu`
