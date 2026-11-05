# P2 workspace skills

Put custom skills under:

```text
.p2/skills/<name>/SKILL.md
```

`SKILL.md` uses the normal skill frontmatter:

```markdown
---
name: my-p2-skill
description: One sentence that tells the agent when this skill is useful.
---

# Body

Instructions for the agent.
```

- `name` and `description` are required; `whenToUse` is optional.
- Names `p2-operator`, `p2-persona`, `p2-memory`, `p2-wake`, and `p2-subagent`
  are reserved for the plugin.
- New or edited skills are picked up while the body is running; a broken file is
  skipped and logged instead of failing the session.
- Skills are prompt text. They cannot grant tool permissions, and the child
  subagent does not inherit the owner session's P2 skills.
- Keep files small (64 KB or less) and avoid secrets.
