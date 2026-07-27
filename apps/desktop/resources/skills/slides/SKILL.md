---
name: slides
description: Create or revise a conversation-bound Bento presentation and keep it editable in the Cortex artifact panel.
argument-hint: "[topic, source material, or requested slide change]"
supported-agents: [claude, codex, pi]
---

# Conversation Slides

Work on the Slides artifact attached to the current Cortex conversation.

- Treat the deck context and revision supplied by Cortex as authoritative.
- Use the `cortex-slides` tools for all deck reads and writes; do not bypass them with direct file replacement.
- On a new deck, propose a concise outline before generating the complete presentation.
- On an existing deck, inspect the deck and current selection before editing; preserve unrelated slides.
- Keep visual language, narrative hierarchy, speaker notes, and source attribution coherent.
- Respect revision conflicts and retry only after reading the latest deck.
- Finish with a short summary naming the slides changed.
