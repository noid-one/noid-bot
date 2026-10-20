# noid docs site

The docs site for https://noid-one.github.io/noid-bot/docs/ (not published yet). It renders the repository's `docs/**/*.md`, `SECURITY.md`, and `CONTRIBUTING.md` where they are, with [Starlight](https://starlight.astro.build): there is no copy of any page here. Pi reads the same files, so they stay plain Markdown, without front matter.

This folder has its own dependencies. Install them here, never at the repository's root:

```sh
cd docs-site
npm ci
npm run dev -- --host 127.0.0.1 --port 4321   # http://127.0.0.1:4321/noid-bot/docs/
npm run build                                 # into dist/
npm run check                                 # as CI builds it, with every check
```

## How it works

- `src/repo-docs.mjs` loads the pages. A page's title is its `# H1`, and its address is its path: `docs/extensions/tools.md` is `/noid-bot/docs/extensions/tools/`, `docs/index.md` is `/start/`. A relative link to a page goes to that page on the site; a link to anything else (code, an example) goes to GitHub, at the commit the site was built from.
- Each build checks every relative link and anchor of every page, as GitHub makes anchors, and fails with the list of problems. It also checks that the reference pages and `types/pocket.d.ts` give each member the same Since line, that the tutorial's code is the tested example, and that `docs/` has no symbolic links (`src/reference-check.mjs`, `src/repo-docs.mjs`).
- `src/sidebar.mjs` is the sidebar. A new page must be added there, or the build fails.
- A reference member's line `Since 0.14.0 · Stable` shows as two tags.
- `src/pages/index.astro` is the home page, the one page that is not in `docs/`.
- The build puts a copy of `types/pocket.d.ts` at `/noid-bot/docs/pocket.d.ts`.

## Publishing

The site is not published yet: Pi Pocket's Pages workflows were left out of noid. Build and check it locally as above.
