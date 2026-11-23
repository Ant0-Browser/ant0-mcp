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

Before we can merge your first pull request, you need to accept our [Contributor Licence Agreement](https://github.com/Ant0-Browser/.github/blob/main/legal/cla-individual.md) (CLA); the CLA Assistant bot will ask on your pull request. You license your contribution to RENEWBYTE LABS LTD under the CLA, and we publish it under this repository's BSD-3-Clause licence. The CLA also lets us use it in other Ant0 products, including in closed-source products and under other licences. If we publish your contribution, we keep it available under the licence that applied to this repository on the date you submitted it.

If your employer or another organisation has rights in your contribution, don't sign the individual CLA; your employer signs the [entity CLA](https://github.com/Ant0-Browser/.github/blob/main/legal/cla-entity.md) instead (email cla@ant0.link). You must be 18 or over to sign. If AI tools helped substantially with your change, say so in the pull request description. See the [CLA privacy notice](https://github.com/Ant0-Browser/.github/blob/main/legal/cla-privacy-notice.md).

To report a security problem, do not open a public issue. Use the repository's private security advisory form (Security tab), or contact us through https://ant0.link.
