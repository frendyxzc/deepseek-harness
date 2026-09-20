---
description: "The IM tab in Web Settings: per-bot Feishu connection pills and the editor that maps each bot to a default TDAI team and agent, including write-only App Secret entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-im

English | [中文](README.zh.md)

## Summary

Use this package to run several Feishu bots from one dsh deployment and give each its own defaults. In Settings' Built-in plugins section the IM tab lists the configured bots, each with a connection pill and a row of fields — bot id, App ID, a write-only App Secret, and the team and agent chosen from the TDAI catalog — and users add, remove, and edit entries there. Saving writes the Host's validated `feishu-bot` settings section; a document the Host will not accept writes for renders the same fields read-only.

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

Mount the row in the Web client composition and Settings' Built-in plugins area gains an **IM** tab beside the plugin list. Users open it to see one card per configured bot, change the team and agent each bot should default to, and press Save; status and catalog data are pulled only once the component mounts, so plugin activation itself issues no Remote call.

### When to choose it

Choose it when more than one Feishu app serves the same deployment and each app's chats should default into a different TDAI team and agent — the pairing the memory proxy uses to keep stores apart. Skip it for a single flat app whose mapping never changes: the composition's `feishu-bot` config already carries that list, and this tab is only the settings-plane editor for it.

### Minimal configuration

The row the Web app bundle inserts is the whole mount, and the plugin accepts no composition config:

```yaml
- id: ui-settings-im
  name: '@deepseek-ai/dsh-client-ui-settings-im'
```

Everything the tab displays or edits is Host state: the `feishu-bot` settings section installed by `dsh-feishu-bot`, the `feishuStatus.list()` projection behind the pills, the `tdaiMemory` team and agent catalog behind the selects, and the credential store the App Secret writes land in.

### What the tab shows

The masthead names the surface and states the model: manage Feishu bot connections and map each App ID to a default team and agent, with the task chosen per session. Below it one disclosure card holds the list. Each row shows the bot id or **Untitled bot**, the literal App ID when the entry carries one, a connection pill, and five fields — Bot ID, App ID, Team ID, Agent ID, App Secret — plus **Remove**; **Add bot**, **Discard**, and **Save** sit in the card footer, and **Unsaved changes** appears in the header while the draft differs from the loaded list.

The two catalog fields are selects, not text boxes: teams and agents are created in the memory hub, so the tab offers only what the catalog returns. An empty team list disables its select and notes that the catalog is unavailable; the agent select stays disabled until that team's agents arrive, reading **Select a team first**.

App Secret is write-only. Its placeholder reports whether the Host already holds a value for that bot, typing a new value replaces the stored one on the next Save, and leaving the field blank keeps the credential untouched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half owns everything; the host entry is an empty `apply()` placeholder.

### Tab registration

`apply()` injects `slots`, `locale`, `remote`, the three Remote faces it calls (`remote.feishuStatus`, `remote.tdaiMemory`, `remote.credentials`), and `settingsScope`; it registers the `settings.im` dictionaries and waits for `settings.plugins.tab` to be declared before registering `{ id: 'im', order: 20 }` with `FeishuStatusTab`, which puts the tab after the plugin-list tab at `order: 10`. The label is a `t('tab')` thunk, so the tab renames itself with the active locale.

### Read and write paths

`load()` pulls the section through a bound settings scope: a `ready` snapshot yields its `bots` list plus the document's writability, an `unavailable` one yields nothing and the editor renders no card at all, and a snapshot that has not settled is awaited through the scope's subscription rather than guessed at. `save()` replaces the whole list — ids trimmed, empty optional fields dropped so the stored section carries only what the user filled in — and only then writes each App Secret that received a fresh value, before reseeding the draft from the reloaded view.

### Secret reference derivation

`secret-ref.ts` mirrors the Host's rule so a bot that does not exist yet can receive its secret in the same save: the flat `feishu-bot` id keeps `FEISHU_APP_SECRET`, any other id is upper-cased and sanitized into `FEISHU_APP_SECRET_<ID>`, with a `BOT_` prefix when the sanitized form is empty or starts with a digit. `dsh-feishu-bot` owns the authoritative function, and each package pins the same outputs in its own tests.

### Failure and empty states

A rejected load renders the mapping-unavailable line; a rejected status or catalog read degrades to an empty list instead, which is why a core outage looks like an unavailable catalog rather than an error. A save that throws — usually a credential write the Host refused — renders the failure line and keeps the draft, so nothing typed is lost.

Exact detail lives in `src/client/index.ts` (registration and the injected verbs), `src/client/TdaiBotsEditor.tsx` (the card), `src/client/tdai-bots.ts` (the settings controller), and `src/client/secret-ref.ts`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the section hosting the tab, the state it edits, and the services behind its reads.

- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Built-in plugins section that projects `settings.plugins.tab`.
- [ui-settings](../ui-settings/README.md) — the domain base declaring the tab slot and the settings scope service.
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.md) — the sibling tab sharing the same slot.
- [feishu-bot](../../feishu/feishu-bot/README.md) — the owner of the section this tab edits and of the authoritative reference derivation.
- [feishu-status](../../feishu/feishu-status/README.md) — the Host service behind the connection pills.
- [tdai-memory](../../llm/tdai-memory/README.md) — the catalog the selects read and the identity the saved ids feed.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that edits the `feishu-bot` mapping and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and the team and agent ids it stores reach a model only as headers another package adds.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints; each one names what the tab deliberately does not claim.

- **Status is matched by bot id** — a bot the Host has not registered yet has no status entry, so its pill reads Unavailable rather than a pending state.
- **Catalog and status failures look empty** — the status and catalog reads render a failed result as an empty list; only the mapping load carries an error state.
- **Secrets cannot be read back** — the field shows only whether a value exists, so a mistyped secret is corrected by typing a new one, never by inspection.
- **One save covers the whole card** — the bot list is written first and each typed secret afterwards, so a rejected secret write leaves the mapping saved with that secret missing behind one retry message.
- **Nothing is validated in the browser** — the editor submits what the user typed after trimming; the Host's `feishu-bot` schema and the receive channel decide what an unknown or repeated bot id means.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The settings namespace and the secret-reference rule are both deliberate client mirrors of Host facts, and `dsh-feishu-bot` is the authority for each: renaming either is a two-package change, and its tests pin the same reference names. The `settings.im` dictionary also carries keys no component renders today, so check the render sites before deleting one.

</details>

**Runtime invariant:** The `./invariant` companion registers an intentionally empty installer: the namespace and its schema belong to `dsh-feishu-bot`, and this tab's behavior is covered by its controller and component tests.
