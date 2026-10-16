# DeepSeek translation integration

User scope: replace unreliable public Google inline translation with the user's DeepSeek key. Chinese to English and English to Chinese; translate text only. Preserve existing Linux/network protections, existing fonts/resources and file tools.

Design: keep the existing compact input popup and explicit click. Add auto / English / Chinese target selector and a collapsed local key setting. Use the official fixed api.deepseek.com/chat/completions endpoint and deepseek-flash (official current Flash name; legacy V4 Flash is routed to the current Flash model). Disable thinking and tools, return translation only, single request, no automatic retries or provider/host fallback. Preserve drafts on failures and never auto-paste a model reply.

Secrets: reuse the app's AES-256-GCM credential encryption, in a separate 0600 local application file outside the project and environment snapshots/backups. API returns configured status only. No key in browser storage, command argv, guest files, logs or GitHub. The guest needs the key in process memory for the explicitly requested HTTPS call, sent by stdin only. Existing before/after access validation remains.

Implementation:
1. Shared translation directions and request/response types; bounded encrypted local settings with atomic writes and unsafe-file refusal.
2. Fixed Python/curl guest request using stdin configuration for both key and source, no redirects or certificate bypass; explicit bounded time/bytes and errors including auth, balance, quota, timeout, incomplete output.
3. Authenticated settings endpoints, connect provider to GuestExchange, preserve operation authorization and one in-flight request per environment. No changes to firewall, lease, quorum, desktop, fonts or graphics settings.
4. Compact popup direction control, editable result, inline collapsed key configuration; same tools across browser/desktop/CLI/Shell. No automatic requests while typing or saving keys.
5. Local fake provider tests (both directions, prompt shape, no answered questions, no leaks/fallback, auth/revocation, corrupt settings), local component tests and bundle checks. Paid provider checks remain a deliberate user click after entering the key; no real AI sites are opened by the agent.
6. Deliver a normal update after drafts are saved; preserve profiles and network policy, verify current build and exit/protection. Do not claim paid translation success before the user triggers a real call.
