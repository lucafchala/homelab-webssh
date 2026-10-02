# CLAUDE.md

All project instructions for AI agents live in AGENTS.md (shared with other tools) — read it fully before making changes.

@AGENTS.md

## Claude-specific notes

- This app gives shell access to the owner's homelab: treat every change as security-sensitive and follow the invariants in AGENTS.md.
- Before editing Anthropic API code (`server/src/ai/anthropic.ts`), consult current Claude API docs (model IDs, thinking, fallbacks) rather than memory.
- When asked to deploy or operate the homelab itself, follow HOMELAB_AGENT_PROMPT.md.
