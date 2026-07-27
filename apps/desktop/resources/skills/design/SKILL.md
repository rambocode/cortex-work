---
name: design
description: Create or revise a conversation-bound interface design artifact and keep it editable in the Cortex artifact panel.
argument-hint: "[design brief or requested change]"
supported-agents: [claude, codex, pi]
---

# Conversation Design

Work on the design artifact attached to the current Cortex conversation.

- Treat the artifact context supplied by Cortex as authoritative.
- For a new artifact, create the requested interface as editable single-file HTML screens under the supplied document directory.
- For an existing artifact, inspect its current files before changing them and preserve unrelated screens and versions.
- Use the existing project design system when present. Otherwise establish a coherent visual direction before generating screens.
- Keep links, local assets, responsive states, accessibility, and interaction states functional.
- Finish with a short summary naming the screens or versions changed. Do not invent a different output directory.
