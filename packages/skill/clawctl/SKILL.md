---
name: clawctl
description: "Use when managing installed claws, switching the active claw, or checking runtime status."
read_when:
  - You need to install a claw implementation or version
  - You need to switch the active claw runtime
  - You need to inspect clawctl status, config, or health
  - You need to send a quick ping or chat message to the active claw
---

# clawctl Skill

`clawctl` is a local-first runtime manager for claw implementations.

Use it when the task is about:

- installing a claw version
- selecting which claw is active
- checking the current runtime
- inspecting shared configuration
- sending direct `ping` or `chat` commands

## Core Commands

```bash
clawctl install <impl>[@version] [--runtime local]
clawctl use <impl>[@version] [--runtime local]
clawctl current
clawctl status [<impl>[@version]]
clawctl ping [<impl>[@version]]
clawctl chat [<impl>[@version]] <message>
clawctl config get <key>
clawctl config set <key> <value>
```

## Guidance

- Prefer the active claw when the user does not specify a target.
- Treat shared credentials as clawctl-owned configuration.
- When changing the active claw, assume the previous runtime may need to be stopped first.
- If the user asks about implementation details, inspect the local `clawctl` workspace before guessing.
