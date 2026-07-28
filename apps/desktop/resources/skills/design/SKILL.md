---
name: design
description: Create or revise a conversation-bound interface design artifact and keep it editable in the Cortex artifact panel.
argument-hint: "[design brief or requested change]"
supported-agents: [claude, codex, pi]
---

# Conversation Design

Work on the design artifact attached to the current Cortex conversation.

- Treat the artifact context supplied by Cortex as authoritative — it names the document directory you must write into.
- For an existing artifact, inspect its current files before changing them and preserve unrelated screens and versions.
- Use the existing project design system when present. Otherwise establish a coherent visual direction before generating screens.
- Keep links, local assets, responsive states, accessibility, and interaction states functional.
- Finish with a short summary naming the screens or versions changed. Do not invent a different output directory.

## On-disk layout (mandatory)

The canvas discovers screens by scanning ONE level of sub-directories under the document
directory and reading `v<N>.html` inside each. Anything written anywhere else exists on disk
but never shows up in the canvas — the user sees an empty board and concludes nothing ran.

- One screen = one sub-directory: `<document dir>/<screen-id>/v1.html`
  (`screen-id`: 6–8 lowercase alphanumeric characters, e.g. `a3f91c2b`).
- A revision adds `v2.html`, `v3.html`, … in the SAME directory. Never overwrite or delete an
  earlier version file.
- Optional per-screen notes go in `DESIGN.md` next to the version files.
- Never write `.html` directly into the document directory root.
- Never invent an index file (`entry.json`, `index.json`, `screens.json`, …). The canvas scans
  directories; it does not read any index you write.
- Never hand-write `design-system.json` — the app owns that file. Writing your own structure
  into it breaks the design canvas.
