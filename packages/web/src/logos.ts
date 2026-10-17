import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

export interface LogoSprite {
  path: string;
  svg: string;
  href(id: string): string;
  inline(id: string, className: string): string;
}

const root = path.join(import.meta.dir, "..", "..", "..");

export const ProviderLogoSprite = createSprite("providers");
export const LabLogoSprite = createSprite("labs");

// Each directory's logos become <symbol>s in one content-hashed file for index
// tables, while detail pages with only a few logos can inline them directly.
function createSprite(directory: "providers" | "labs"): LogoSprite {
  const ids = readdirSync(path.join(root, directory))
    .filter((id) => existsSync(path.join(root, directory, id, "logo.svg")))
    .sort();
  const entries = new Map<string, string>([
    ["default", parseLogo("default", path.join(root, "providers", "logo.svg"))],
    ...ids.map((id): [string, string] => [
      id,
      parseLogo(id, path.join(root, directory, id, "logo.svg")),
    ]),
  ]);
  const symbols = [...entries].map(([id, logo]) => `<symbol id="logo-${id}" ${logo}</symbol>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`;
  const hash = createHash("sha256").update(svg).digest("hex").slice(0, 10);
  const spritePath = `/sprites/${directory}.${hash}.svg`;

  return {
    path: spritePath,
    svg,
    href: (id) => `${spritePath}#logo-${entries.has(id) ? id : "default"}`,
    inline: (id, className) =>
      `<svg class="${className}" width="16" height="16" aria-hidden="true" focusable="false" ${entries.get(id) ?? entries.get("default")!}</svg>`,
  };
}

function parseLogo(id: string, file: string) {
  const prefix = `logo-${id}-`;
  let svg = readFileSync(file, "utf8")
    .replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<metadata[\s\S]*?<\/metadata>/gi, "")
    // Editor metadata needs namespaces that the sprite doesn't declare.
    .replace(/<sodipodi:namedview\b[^>]*?(?:\/>|>[\s\S]*?<\/sodipodi:namedview>)/g, "")
    .replace(/\s(?:inkscape|sodipodi):[\w-]+="[^"]*"/g, "")
    .replace(/\sxlink:href=/g, " href=")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s(fill|stroke)="(?!none|currentColor)[^"]*"/gi, ' $1="currentColor"');

  // Logos share one document, so internal ids need unique names; drop unused ones.
  for (const [, name] of svg.matchAll(/\sid="([^"]+)"/g)) {
    if (!svg.includes(`#${name}`)) {
      svg = svg.replaceAll(` id="${name}"`, "");
      continue;
    }
    svg = svg
      .replaceAll(`id="${name}"`, `id="${prefix}${name}"`)
      .replaceAll(`url(#${name})`, `url(#${prefix}${name})`)
      .replaceAll(`href="#${name}"`, `href="#${prefix}${name}"`);
  }
  // WebKit and Firefox don't apply the sprite's own <style> through <use>, so
  // class rules become style attributes.
  for (const [, css] of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const [, name, declarations] of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      svg = svg.replaceAll(`class="${name}"`, `style="${declarations.trim()}"`);
    }
  }
  svg = svg.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  const [, attributes = "", content = ""] = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/) ?? [];
  const viewBox = rootViewBox(attributes);
  // Round path coordinates to 1/1000 of the logo's size, far below a pixel at
  // the size logos are drawn. Logos that scale their paths keep two more digits.
  const size = Math.max(...viewBox.split(/[\s,]+/).slice(2).map(Number));
  const digits =
    Math.max(0, Math.ceil(Math.log10(1000 / size))) + (/scale\(|matrix\(/.test(svg) ? 2 : 0);
  const body = content.replace(
    /\s(d|points)="([^"]*)"/g,
    (_, name: string, value: string) => ` ${name}="${roundNumbers(value, digits)}"`,
  );
  const kept = attributes
    .replace(
      /\s(?:xmlns(?::\w+)?|xml:space|width|height|viewBox|version|id|class|style|x|y|role|aria-label|enable-background)="[^"]*"/g,
      "",
    )
    .trim();

  return `viewBox="${viewBox}"${kept ? ` ${kept}` : ""}>${body}`;
}

function rootViewBox(attributes: string) {
  const viewBox = attributes.match(/\sviewBox="([^"]+)"/)?.[1];
  if (viewBox) return viewBox.trim();
  const width = attributes.match(/\swidth="([\d.]+)/)?.[1] ?? "24";
  const height = attributes.match(/\sheight="([\d.]+)/)?.[1] ?? "24";
  return `0 0 ${width} ${height}`;
}

function roundNumbers(value: string, digits: number) {
  return value
    .replace(/-?(?:\d+\.\d+|\.\d+)(?:e[-+]?\d+)?/gi, (number, offset: number, source: string) => {
      const rounded = Number(Number(number).toFixed(digits))
        .toString()
        .replace(/^(-?)0\./, "$1.");
      // "1.03.41" and "1-.4" rely on "." and "-" to split numbers; keep them apart.
      const before = /^\d/.test(rounded) && /[\d.]/.test(source[offset - 1] ?? "") ? " " : "";
      const after = !rounded.includes(".") && source[offset + number.length] === "." ? " " : "";
      return before + rounded + after;
    })
    .replace(/\s+/g, " ")
    .trim();
}
