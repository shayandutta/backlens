# Security

backlens runs inside your app, controls it from a local dashboard, can edit files when you apply a fix, and can create an index on the database your app uses. Problems in any of these are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of this repository, then **Report a vulnerability**.

Include the version (`npm ls backlens`), what an attacker needs (for example: another website open in the same browser, another user on the same machine), and what they can do. You will get an answer within a few days.

## What backlens is designed to protect

- The dashboard listens on 127.0.0.1 only, needs the private token from the link it prints, checks the Host header and refuses requests from other origins.
- While it runs, the dashboard's port and token are in `.backlens/session.json` (owner-only permissions, git-ignored, removed on exit) so `backlens mcp` can reach it. The MCP server only reads that dashboard; it never receives query parameters or results.
- It only runs scripts from your `package.json`, by name.
- Query parameters and results are never sent to the dashboard, only short hashes.
- A Claude API key is stored in your user config folder with owner-only permissions and is never sent back to the browser.
- The command that creates an index inside your app needs the same token and accepts only checked identifiers, never SQL text.

Supported versions: the latest release on npm.
