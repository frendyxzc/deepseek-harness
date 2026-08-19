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
- The panel URL follows the page's own host: loopback renders the fixed
  `http://127.0.0.1:8123`, and a LAN origin renders the same host on the panel
  port (for example `http://192.168.1.5:8123`), so the jump link keeps working
  when DSH itself is opened across the network.
- No network requests, no session events, and no settings writes are performed;
  the section is a fixed link and contributes nothing to the model or the
  session log.

## Known Limitations and Deferred Work

- The panel port is fixed to `8123` and the panel is assumed to live on the
  same machine as DSH; a deployment that hosts the panel on another port or
  machine needs the origin made configurable before the link can follow it.
- The panel itself is the standalone TencentDB-Agent-Memory service. Whether a
  LAN browser can actually load `http://<host>:8123` is that service's own bind
  policy, outside this repo's control.
