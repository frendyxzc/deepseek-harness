# @deepseek-ai/dsh-client-ui-settings-memory

Browser half of the Memory panel settings section: a single nav entry on the
settings surface (owned by `ui-settings-general`) that links out to the running
TencentDB-Agent-Memory (Memory Hub) panel.

The deepseek-harness repo carries no memory panel of its own. This section is
only the jump link; the panel itself is the standalone TencentDB-Agent-Memory
control console that the DSH session's memory proxy (`8096`) binds against.

## Model Experience

- Adds one **Memory** nav entry to the settings panel, ordered after the Models
  section.
- The section renders a title, a one-line intro, the panel URL, and an
  **Open memory panel** primary button that opens the panel in a new browser tab.
- No network requests, no session events, and no settings writes are performed;
  the section is a fixed link and contributes nothing to the model or the
  session log.

## Known Limitations and Deferred Work

- The panel origin is fixed to `http://127.0.0.1:8123` (the local memory
  stack's panel port). A deployment that hosts the panel elsewhere needs this
  value made configurable before the link can follow it.
