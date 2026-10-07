# Agent Instructions

This is a Chromium browser extension. Agents working in this repository must follow the workflow below.

## Manual verification required

The user must manually check extension behavior in Chromium before a change is considered done. Automated checks do not replace this browser check.

After making extension changes, tell the user what to verify and remind them to reload the extension in `chrome://extensions`.

## Agent build requirement

After each change to extension source code or public assets, the agent must run:

```bash
npm run build
```

This compiles TypeScript and copies assets into `dist/`, making the extension ready for the user to test. Do not skip the build step, even for small edits.

If the build fails, fix the errors before finishing.

## Testing workflow for the user

1. Open `chrome://extensions` and reload Volume Master.
2. Test the affected behavior in a normal browser tab.

Use `npm run watch` only when the user is actively developing and wants continuous compilation.
