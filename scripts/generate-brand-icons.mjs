import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const source = await readFile(new URL("../public/brand/movibox.svg", import.meta.url), "utf8");
const artwork = source.slice(source.indexOf("<g "), source.lastIndexOf("</svg>"));
await mkdir(new URL("../design/branding/", import.meta.url), { recursive: true });
for (const [theme, surface, mark] of [
  ["dark", "#18191c", "#f2f3f4"],
  ["light", "#f4f5f6", "#202124"],
]) {
  const colored = artwork.replace(/fill:rgb\([^)]+\)/g, `fill:${mark}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="${surface}"/><svg x="64" y="64" width="896" height="896" viewBox="0 0 1080 1080">${colored}</svg></svg>`;
  await writeFile(new URL(`../design/branding/dock-${theme}.svg`, import.meta.url), svg);
  await writeFile(
    new URL(`../src-tauri/icons/dock-${theme}.png`, import.meta.url),
    new Resvg(svg).render().asPng(),
  );
}
