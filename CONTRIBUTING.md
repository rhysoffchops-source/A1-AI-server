# Contributing to A1

## Required checks

Every change must pass:

```bash
npm run verify
```

The verification pipeline checks formatting, lint rules, TypeScript project references, the
production build, and tests.

## Change rules

- Keep commits atomic and describe one coherent change.
- Do not mix provider SDK types into domain or kernel contracts.
- Add tests for behavior, failure modes, and configuration validation.
- Reject unknown configuration rather than silently accepting it.
- Add an architecture decision record when changing an accepted system boundary.
- Never commit credentials, model weights, generated runtime data, logs, or user projects.
- Never delete or overwrite user-managed data in migrations, scripts, or tests.
- Destructive maintenance commands must require an explicit target and confirmation.

## Definition of done

A change is complete when implementation, tests, documentation, configuration, failure handling, and
operational behavior are consistent. Stubs, TODOs, commented-out implementations, and unvalidated
placeholder configuration are not accepted.
