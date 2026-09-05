# Repository Guidelines

## Project Structure

```text
src/index.ts       Pi extension entry point
src/lifecycle.ts   Lifecycle and active-tool management
src/config.ts      Project policy persistence and legacy migration
src/manifest.ts    Bounded tool manifest generation
src/registry.ts    Tool policies and source identities
src/tool.ts        Exact-name deferred-tool loader and rendering
src/ui.ts          SettingsList configuration panel
test/              Unit and integration coverage
scripts/deploy.mjs Local Pi deployment script
```

Keep source in `src/` and mirror behavioral changes in `test/*.test.ts`. Treat project-local `.pi/` state as development artifacts unless a change intentionally targets configuration behavior.

## Commands

Use Node.js 22.19 or newer.

- `npm install` installs development dependencies.
- `npm run check` runs strict TypeScript checks.
- `npm test` runs all Node test files through `tsx`.
- `npm run verify` runs type checks and the full suite.
- `pi --no-extensions -e ./src/index.ts` loads the extension in isolation.
- `npm run deploy` verifies and replaces `~/.pi/agent/extensions/pi-tool-search/`.

## Style and Tests

Write TypeScript ESM with `.ts` relative imports. Follow nearby style: tabs in `src/`, double quotes, semicolons, and trailing commas in multiline constructs. Use `node:test` with `node:assert/strict`. Cover failures, state restoration, policy migration, and constrained-width rendering where relevant.

## Pi Reference Documentation

The following local Pi documentation is available for reference. Consult it as needed when implementing or reviewing Pi-related behavior:

1. **Main documentation**

   ```text
   /home/thelya/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md
   ```

2. **Detailed documentation directory**

   ```text
   /home/thelya/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs
   ```

   This directory contains more than 20 topic-specific documents, including `extensions.md`, `themes.md`, `skills.md`, `tui.md`, and `sdk.md`.

3. **Example code directory**

   ```text
   /home/thelya/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples
   ```

   This directory contains reference implementations and examples under directories such as `extensions/`, `plugins/`, and `sdk/`.
