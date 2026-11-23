# Contributing

Issues are welcome: bug reports, questions and feature requests. Please include the Ant0 desktop version, your MCP client, and the tool call that failed. Do not paste tokens, API keys or cookies.

Pull requests are welcome too. Maintainers review every PR and decide what is merged. For anything larger than a small fix, open an issue first so we can agree on the approach.

Before you open a PR:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

The tool list is frozen by `test/tool-contract.test.ts`. A change to a tool name, schema, annotation or description must update the files in `test/__snapshots__/` on purpose (`pnpm vitest run -u`) and the diff will be reviewed.

By contributing you agree that your contribution is licensed under the BSD-3-Clause licence of this repository.

To report a security problem, do not open a public issue. Use the repository's private security advisory form (Security tab), or contact us through https://ant0.link.
