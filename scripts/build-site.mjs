// Builds the GitHub Pages site into _site/: rendered docs, the built SDK and runnable examples.
// Run `npm run build` first; `npm run build:site` does both.
import { cp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const repository = "https://github.com/designerzen/audiobus-protocol";

try {
  await access(join(root, "dist", "index.js"));
} catch {
  throw new Error("dist/index.js is missing; run `npm run build` first");
}

const escape = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// GitHub-compatible heading anchors, so links such as `protocol.md#pairing-codes-sdk-03` keep working.
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

function renderer() {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth: level }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${level}>\n`;
      },
    },
    walkTokens(token) {
      if (token.type !== "link" || /^[a-z]+:|^#/i.test(token.href)) return;
      // Markdown pages become HTML pages; links to source files stay as served files.
      // Relative paths stay valid because docs/ and examples/ keep their layout on the site.
      token.href = token.href.replace(/(^|\/)README\.md(#|$)/, "$1index.html$2").replace(/\.md(#|$)/, ".html$1");
    },
  });
  return marked;
}

function page({ title, description, body, depth = "", current }) {
  const nav = [
    ["index.html", "Overview"],
    ["demos.html", "Demos"],
    ["docs/protocol.html", "Wire protocol"],
    ["docs/integration.html", "Integration"],
  ]
    .map(
      ([href, label]) =>
        `<a href="${depth}${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="stylesheet" href="${depth}site.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="${depth}index.html">audioBus Protocol</a>
  <nav>${nav}<a href="${repository}">GitHub</a></nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">audiobus-protocol ${escape(pkg.version)} · wire protocol version 1 · <a href="${repository}">Source</a></footer>
</body>
</html>
`;
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "docs"), { recursive: true });
await cp(join(root, "dist"), join(out, "dist"), { recursive: true });
await cp(join(root, "examples"), join(out, "examples"), { recursive: true });
await cp(join(root, "site"), out, { recursive: true });
// Serve files as-is; no Jekyll processing.
await writeFile(join(out, ".nojekyll"), "");

const demos = await readFile(join(root, "site", "demos.fragment.html"), "utf8");
await rm(join(out, "demos.fragment.html"));

const readme = await readFile(join(root, "README.md"), "utf8");
await writeFile(
  join(out, "index.html"),
  page({
    title: "audioBus Protocol",
    description: pkg.description,
    current: "index.html",
    body: `<p class="lede">${escape(pkg.description)}. <a href="demos.html">Try the demos</a>.</p>\n${renderer().parse(readme)}`,
  }),
);
await writeFile(
  join(out, "demos.html"),
  page({ title: "Demos · audioBus Protocol", description: "Runnable audioBus Protocol demos", current: "demos.html", body: demos }),
);
for (const name of ["protocol", "integration"]) {
  const markdown = await readFile(join(root, "docs", `${name}.md`), "utf8");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? name;
  await writeFile(
    join(out, "docs", `${name}.html`),
    page({
      title: `${title} · audioBus Protocol`,
      description: title,
      depth: "../",
      current: `docs/${name}.html`,
      body: renderer().parse(markdown),
    }),
  );
}
console.log(`Site written to ${out}`);
