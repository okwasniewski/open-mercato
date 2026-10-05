---
name: om-auto-create-pr-loop
description: Open Mercato repo-local extension of the shared `om-auto-create-pr-loop` skill (installed from open-mercato/skills into .agents/skills/). Pins the spec-completion gates (OM integration suites + om-ds-guardian) and the .ai/specs/enterprise spec scope.
---

# Auto Create PR Loop — Open Mercato extension

This file extends the shared `om-auto-create-pr-loop` skill from [open-mercato/skills](https://github.com/open-mercato/skills) (installed at `.agents/skills/om-auto-create-pr-loop/SKILL.md`). Follow the shared workflow with these repo specifics:

- **Spec sources**: work may be driven by a file under `.ai/specs/` or `.ai/specs/enterprise/` (enterprise scope). The run-folder contract is documented in `.ai/runs/README.md`.
- **Spec-completion gates**: "the repo's integration suite" means the agentic e2e suite (`cd e2e && APP_URL=<url> npm test`; see the `om-integration-tests` skill) plus `yarn test:create-app:integration` when the change touches template-synced surfaces. "Any style-compliance pass" means running the `om-ds-guardian` skill when UI was touched.
- **Checkpoint artifacts**: the e2e report is `e2e/.e2e/report.json`; failure screenshots and traces sit under `e2e/.e2e/artifacts/`.
- **Validation runner**: pick Docker vs local per root `AGENTS.md` § Validation Commands before running the gate.
