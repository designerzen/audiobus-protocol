// Builds the GitHub Pages site described by api/site.json. Run `npm run build:site`.
// The site keeps the repository layout (dist/, examples/, api/), so pages link the same way
// locally and when deployed.
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { Marked } from "marked"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const site = JSON.parse(await readFile(join(here, "site.json"), "utf8"))
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const out = join(root, site.output)
// Build inputs are not published.
const PRIVATE = new Set(["build.mjs", "site.json", "tsconfig.json", "remote-control.ts"])
const MERMAID = `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs"
mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" })
</script>
`

try {
	await access(join(root, "dist", "index.js"))
} catch {
	throw new Error("dist/index.js is missing; run `npm run build` first")
}

const escape = (text) =>
	String(text).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
	)
// GitHub-compatible heading anchors, so links such as `protocol.md#pairing-codes-sdk-03` work.
const slug = (text) =>
	text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s/g, "-")

function markdown() {
	const marked = new Marked({ gfm: true })
	marked.use({
		renderer: {
			heading({ tokens, depth }) {
				const html = this.parser.parseInline(tokens)
				const id = slug(html)
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`
			},
			// Diagrams render in the browser, as they do on GitHub.
			code({ text, lang }) {
				return lang === "mermaid" ? `<pre class="mermaid">${escape(text)}</pre>\n` : false
			}
		},
		walkTokens(token) {
			if (token.type !== "link" || /^[a-z]+:|^#/i.test(token.href)) return
			// Markdown pages become HTML pages; links to other files stay as served files.
			token.href = token.href
				.replace(/(^|\/)README\.md(#|$)/, "$1index.html$2")
				.replace(/\.md(#|$)/, ".html$1")
		}
	})
	return marked
}

function page({ title, description, body, output }) {
	// Path from this page back to the site root.
	const up = "../".repeat(output.split("/").length - 1)
	const nav = site.navigation
		.map(
			({ href, label }) =>
				`<a href="${up}${href}"${href === output ? ' aria-current="page"' : ""}>${escape(label)}</a>`
		)
		.join("")
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="stylesheet" href="${up}api/site.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="${up}index.html">${escape(site.title)}</a>
  <nav>${nav}<a href="${site.repository}">GitHub</a></nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">audiobus-protocol ${escape(pkg.version)} · wire protocol version 1 · <a href="${site.repository}">Source</a></footer>
${body.includes('class="mermaid"') ? MERMAID : ""}</body>
</html>
`
}

function demos() {
	const { title, lede, sections } = site.demos
	const cards = (items) =>
		items
			.map(
				({ title, description, href, source }) => `  <li>
    <h3>${escape(title)}</h3>
    <p>${escape(description)}</p>
    <a href="${escape(href)}">Open</a>${source ? ` · <a href="${site.repository}/blob/main/${escape(source)}">Source</a>` : ""}
  </li>`
			)
			.join("\n")
	return [
		`<h1>${escape(title)}</h1>`,
		`<p class="lede">${escape(lede)}</p>`,
		...sections.map(
			({ id, title, intro, demos }) =>
				`<h2 id="${escape(id)}">${escape(title)}</h2>\n${intro ? `<p>${escape(intro)}</p>\n` : ""}<ul class="cards">\n${cards(demos)}\n</ul>`
		)
	].join("\n")
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const folder of site.copy) {
	await cp(join(root, folder), join(out, folder), {
		recursive: true,
		filter: (path) => !(folder === relative(root, here) && PRIVATE.has(basename(path)))
	})
}
// Serve files as they are; no Jekyll processing.
await writeFile(join(out, ".nojekyll"), "")

for (const { source, output, lede } of site.pages) {
	const text = await readFile(join(root, source), "utf8")
	const title = text.match(/^#\s+(.+)$/m)?.[1] ?? site.title
	const intro = lede
		? `<p class="lede">${escape(pkg.description)}. <a href="${site.demos.output}">Try the demos</a>.</p>\n`
		: ""
	await mkdir(dirname(join(out, output)), { recursive: true })
	await writeFile(
		join(out, output),
		page({
			title: title === site.title ? title : `${title} · ${site.title}`,
			description: lede ? pkg.description : title,
			output,
			body: intro + markdown().parse(text)
		})
	)
}
await writeFile(
	join(out, site.demos.output),
	page({
		title: `${site.demos.title} · ${site.title}`,
		description: site.demos.lede,
		output: site.demos.output,
		body: demos()
	})
)
console.log(`Site written to ${out}`)
