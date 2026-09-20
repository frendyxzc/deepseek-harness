---
description: "The Memory section of Web Settings: one nav entry that names the TencentDB-Agent-Memory panel address the browser will open and jumps to it in a new tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-memory

English | [中文](README.zh.md)

## Summary

Use this package to give Web users a Settings entry that opens the TencentDB-Agent-Memory panel. Users select Memory in the settings navigation, read the panel address the page will actually open, and press Open memory panel to launch it in a new tab. The address follows the origin the browser already reaches dsh through: a loopback page opens the fixed local panel port, and a LAN page opens the same host on that port, so the jump link keeps working when dsh is shared across the network. The section itself stores nothing and requests nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in the Web client composition and the settings navigation gains a **Memory** entry: users open it, read the panel address the button will use, and press **Open memory panel** to launch the TencentDB-Agent-Memory console in a new tab. Nothing else needs configuring first — the section paints the same title, intro, address, and button for every locale its dictionary covers.

### When to choose it

Choose it when a deployment runs the standalone memory stack beside dsh and its users need that console — chat memories, skills, code graphs, team assets. Skip it when no panel is deployed: the section is only a jump link, so it would advertise a dead address. The shell that renders the navigation belongs to [ui-settings-general](../ui-settings-general/README.md); this package contributes just this section.

### Minimal configuration

The row the Web app bundle inserts is the whole mount, and the plugin accepts no composition config:

```yaml
- id: ui-settings-memory
  name: '@deepseek-ai/dsh-client-ui-settings-memory'
```

There is no field to point the link elsewhere: the only address this section can show is the panel port on the host the browser is already talking to, so a different panel origin is a deployment change to that stack, not a setting here.

### What the section shows

The section renders a **Memory Hub** title, the intro line naming what the panel manages, a `Panel URL: <address>` line, and a primary button that opens that address through `window.open(url, '_blank', 'noopener,noreferrer')`. Before the shell injects the section's dependencies the component returns `null`, so an outlet that has not resolved yet never paints half a page.

The address follows the origin the browser already uses to reach dsh: a loopback page shows and opens `http://127.0.0.1:8123`, while a LAN page shows and opens the same host on port `8123` (for example `http://192.168.1.5:8123`). The section issues no request, appends no session event, and writes no settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two halves, only one of which does anything: the host entry exports an empty `apply()`, and the browser entry registers the copy and the section.

### Slot contribution

The browser `apply()` injects `slots`, `locale`, and `connection`, registers the `settings.memory` dictionaries, and waits for `settings.section` to be declared before registering `{ id: 'memory', order: 20 }` with `MemorySection`. Order 20 places the entry after General (0), Models (10), and Built-in plugins (15). The `label` is a thunk over `t('nav')` and the entry names its `locale` namespace, so a language change renames the nav item in place without re-registering it.

### Origin resolution

`panelUrl(hostname, isLoopback)` is the entire address policy, and the component feeds it `window.location.hostname` plus the `isLoopback` flag from the connection handle, pulled through `inject` at render time. Because the flag is the browser's own connection classification, the section describes the link that user's browser will really follow rather than a Host-side guess about network topology.

### Why the port is a constant

`8123` is a deployment fact of the standalone TencentDB-Agent-Memory console, not a tunable of this repository, so it stays a module constant beside the component that renders it. The comment above the constant records the assumption it encodes: the panel runs on the same machine the session's memory proxy (`8096`) binds against.

Exact detail lives in `src/client/index.ts` (the registration), `src/client/MemorySection.tsx` (the `panelUrl` policy and the render), and `src/client/locales.ts` (both dictionaries).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the shell hosting the entry, the flag behind the address, and the memory stack it links to.

- [ui-settings-general](../ui-settings-general/README.md) — the Settings shell projecting the `settings.section` navigation.
- [ui-settings](../ui-settings/README.md) — the domain base declaring the section slot and its scope service.
- [connection](../connection/README.md) — the browser handle supplying `isLoopback`.
- [tdai-memory](../../llm/tdai-memory/README.md) — the identity layer the same memory stack serves.
- [ui-settings-im](../ui-settings-im/README.md) — the sibling surface where a user configures the per-bot memory identity.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings page that renders one fixed jump link and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, all of them consequences of the section being a single fixed link.

- **The panel origin is one fixed port on the page's own host** — a console on another port or machine cannot be linked until that origin becomes configurable.
- **Reachability is the panel's own policy** — whether a LAN browser can load `http://<host>:8123` is that service's bind decision, outside this repository's control.
- **The section cannot tell whether the panel is up** — it renders the address unconditionally and issues no probe, so an unstarted console surfaces only in the tab the button opens.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The intro line still enumerates the external console's feature list (chat memories, skills, code graphs, team assets), which is that product's vocabulary rather than this repository's; when it renames a capability, `src/client/locales.ts` is the only file here to touch. Nothing in this repo asserts the panel's own routes, so a copy edit is the whole update.

</details>

**Runtime invariant:** The `./invariant` companion registers an intentionally empty installer: the section emits no events and owns no cross-plugin mutable relation, so the slot ledger and the component tests own its behavior.
