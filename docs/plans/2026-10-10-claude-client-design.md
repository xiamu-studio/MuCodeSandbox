# Real Claude Code, account-free acceptance

Use the actual Linux Claude Code client against an in-process Messages API
fixture. Extend the existing loopback-only lab with `/v1/messages` and
`/v1/messages/count_tokens`; retain its Host/Origin checks. Only a fixed synthetic
credential is accepted. The fixture never forwards requests or invokes a model.

The existing OpenAI-shaped fixture cannot establish Claude Code compatibility.
A hand-written HTTP client would test the fixture rather than the shipped CLI.
The chosen test therefore installs the actual client in a disposable strict VM,
then switches its authenticated test proxy to deny all non-fixture destinations.
Download traffic is a separate setup phase. No host credentials or configuration
are shared. Client configuration, synthetic credentials and files stay in the
disposable guest. Model names and usage in fixture responses are protocol fields,
not evidence of paid requests.

Finite deterministic scenarios cover streamed text, fragmented tool JSON, Write,
Read and Bash, an unfinished stream for cancellation, and a truncated tool block
for disconnect. Check actual guest files, UID, tool results, process termination,
and a fresh successful run after faults. Keep CLI outputs, proxy decisions and
physical capture as bounded, private artifacts. Never report a cancelled timeout
as a natural disconnect failure or a process kill as a graceful client abort.

The lab route is reusable in the product. VM orchestration and fault injection
remain in a verifier, with no production API for arbitrary scripted model tools.
The fixture only emits fixed commands and paths. Successful local compatibility
does not prove paid-account acceptance, provider policy compliance, the behavior
of other CLI versions, or Claude Desktop support.

Protocol references:
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/env-vars
