Licence texts for packages that an inlined dependency (the MCP SDK) already compiled into its own
dist files. `scripts/build-mcpb.mjs` finds them from the dist source maps and copies these files
into `THIRD_PARTY_NOTICES`; the build fails if one is missing. Each folder is `<name>@<version>`
with the package's own LICENSE file and `spdx.txt`.
