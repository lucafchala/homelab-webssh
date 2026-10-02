# Contributing

Thanks for helping! WebSSH gives people shell access to their machines, so the bar for security-related changes is high — but every kind of contribution is welcome: bug reports, docs, new offline help entries, UI polish, tests.

## Before you start

- Read [AGENTS.md](AGENTS.md) — it is the developer guide for humans *and* AI agents: project layout, commands, conventions and the **security invariants** every change must keep.
- Architecture and protocols: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **Security vulnerabilities: do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/lucafchala/webssh.lucafchala.com.git webssh && cd webssh
npm install                       # Node.js 22.13+
PUBLIC_URL=http://localhost:5173 npm run dev
```

Open http://localhost:5173 — the first-run setup token is printed in the terminal.

## Checks (all must pass)

```bash
npm run typecheck
npm run build
sudo -E env "PATH=$PATH" npm test     # run last: starts a throwaway sshd (apt install openssh-server); root is needed for PTYs
npm run test:e2e                      # optional locally; see AGENTS.md for the e2e prerequisites
```

## Pull requests

- Keep PRs focused; describe *what* and *why*, and how you tested it.
- Add or update tests for behaviour changes (security-relevant logic must have tests).
- Update the docs (`README.md`, `docs/*`, `.env.example`) when behaviour or configuration changes.
- Never commit secrets, `.env`, databases, or real hostnames/IPs from your network.
- AI-assisted contributions are welcome (this project is mostly AI-written) — but you are responsible for reviewing what you submit.

## Easy first contributions

- New commands or task recipes for the offline help (`server/src/help/commands.ts`, `server/src/help/recipes.ts`) — include good `keywords` and add a test case in `server/test/logic.test.ts`.
- New terminal colour themes (`web/src/terminal/themes.ts`).
- Translations of the docs.
