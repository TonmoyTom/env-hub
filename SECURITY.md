# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Email: _(to be filled in before the first public release)_

We will acknowledge your report and work on a fix before any public disclosure.

## Design principles

- The renderer runs with `contextIsolation`, `sandbox`, and without `nodeIntegration`.
- The renderer reaches the main process only through allowlisted IPC functions in `preload/preload.js`.
- Every IPC handler validates its sender and input in the main process.
- Docker is always called with argument arrays, never with shell strings built from user input.
- Ports bind to `127.0.0.1` by default. LAN sharing is opt-in per project.
- Database and mail admin tools are not exposed to the LAN by default.
