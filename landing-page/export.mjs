import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(directory, "../release-output/movibox-landing/MoviBox.html");
const mimeTypes = { ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2" };
const embedded = new Map();

async function embedAsset(asset) {
  if (!embedded.has(asset)) {
    const buffer = await readFile(path.join(directory, asset));
    embedded.set(
      asset,
      `data:${mimeTypes[path.extname(asset)]};base64,${buffer.toString("base64")}`,
    );
  }
  return embedded.get(asset);
}

let html = await readFile(path.join(directory, "index.html"), "utf8");
let css = await readFile(path.join(directory, "styles.css"), "utf8");
const script = await readFile(path.join(directory, "script.js"), "utf8");
const icons = await readFile(path.join(directory, "assets/icons.svg"), "utf8");
const licenses = await Promise.all(
  ["manrope-OFL.txt", "lucide-LICENSE.txt"].map((name) =>
    readFile(path.join(directory, "assets", name), "utf8"),
  ),
);
html = html.replace(
  "</head>",
  `<!-- Bundled font and icon licenses:\n${licenses.join("\n\n")} -->\n</head>`,
);

css = css.replace(
  'url("assets/manrope.woff2")',
  `url("${await embedAsset("assets/manrope.woff2")}")`,
);
html = html.replace(/<link\s+rel="stylesheet"\s+href="styles.css"\s*\/>/, `<style>${css}</style>`);
html = html.replace(/<script\s+src="script.js"\s+defer><\/script>/, "");
html = html.replace(
  "<body>",
  `<body>\n${icons.replace("<svg ", '<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden" ')}`,
);
html = html.replaceAll("assets/icons.svg#", "#");

const assets = [...new Set(html.match(/(?<=["\s])assets\/[a-z0-9.-]+\.(?:webp|png|woff2)/g) ?? [])];
for (const asset of assets) {
  const dataUrl = await embedAsset(asset);
  html = html.replaceAll(`"${asset}`, `"${dataUrl}`).replaceAll(` ${asset}`, ` ${dataUrl}`);
}
html = html.replace("</body>", `<script>${script}</script>\n</body>`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`Standalone HTML exported: ${output}`);
