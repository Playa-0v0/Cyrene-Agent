# Spec: Channel conversation binding

## Objective

Allow a user to select one existing Cyrene conversation and bind a specific external chat to it. Messages from that external chat then use and extend the selected conversation context, so the same conversation can continue between the desktop and a supported channel.

This is the first, deliberately small slice of #61. It does not attempt full multi-device synchronization.

## Scope

- List recent external chats that have reached the channel dispatcher.
- List existing Cyrene conversations.
- Bind or unbind one external chat and one Cyrene conversation from the Channels settings page.
- Persist bindings under Electron `userData`.
- For a bound chat, load recent user/assistant messages from the selected Cyrene conversation before a model run.
- Append the external user message and generated assistant reply to both the existing channel history and the selected Cyrene conversation.
- Keep the existing channel tool policy authoritative. A binding shares context only and never inherits the selected conversation's tool permissions or execution mode.
- Keep the original channel session ID for Agent execution, lifecycle events, and runtime-associated state. The bound desktop conversation ID is used only to load text history and mirror messages, not as the Agent session ID.
- Do not inherit the selected conversation's workspace binding; an external-channel run receives no desktop workspace root through this feature.
- Leave unbound channel chats unchanged.

## Out of scope

- QR codes or short pairing codes.
- Cloud synchronization between separate Cyrene installations.
- Offline delivery, read receipts, or conflict resolution between concurrently active devices.
- Attachment replication into the desktop conversation.
- Changing channel authentication, allowlists, rate limits, or tool approval behavior.

## Data and interfaces

- A binding is keyed by the existing deterministic channel session ID derived from `channel + chatId`.
- The stored value contains the target conversation ID and non-secret display metadata for the external chat.
- Main-process IPC exposes list, bind, and unbind operations to the trusted settings preload API.
- Bind requests are validated in the main process. The channel and chat must be known from a recent inbound message, and the target conversation must exist.
- Persistence uses an atomic temporary-file replacement and a bounded collection.
- Binding target existence is checked using the existing in-memory session index; history is still read fresh before each run.
- Timestamp-only observations are coalesced during traffic (at most one write every five seconds). New chats, changed display metadata, binding and unbinding persist immediately. Shutdown flushes pending timestamps; there is no background timer, so an abrupt exit can lose the final unsaved display timestamp, but not acknowledged bindings or mirrored messages.

## Testing strategy

- Unit tests for binding validation, persistence, replacement, unbinding, malformed stored data, and collection limits.
- Dispatcher tests proving bound and unbound history selection and message mirroring.
- IPC tests proving invalid channels, unknown external chats, and missing conversations are rejected.
- Renderer tests for option rendering and bind/unbind actions where the current settings test harness supports DOM behavior.
- Full `npm test`, TypeScript builds, and the production build before PR creation.

## Security boundaries

- External message fields and renderer IPC payloads are untrusted and validated.
- Binding never changes `resolveChannelAgentPolicy`, exposed tools, execution mode, allowlists, or approval behavior.
- Binding never supplies the selected desktop conversation's workspace root to an external-channel run.
- Only user and assistant text is copied into the shared conversation context.
- Secrets, tool outputs, credentials, and attachment paths are not copied by this feature.
- Group chats remain distinct from private chats because bindings use each message's stable `chatId`.

## Success criteria

1. An external chat can be selected and bound to an existing conversation from Channels settings.
2. The next message from that chat receives the selected conversation's recent user/assistant context.
3. The external user message and assistant reply become visible in the selected desktop conversation.
4. Unbinding restores the existing channel-only history behavior.
5. A different external chat cannot use the binding unless it is explicitly bound.
6. Tool permission behavior is byte-for-byte unchanged outside the new context-selection path.
7. All existing tests and builds pass.
