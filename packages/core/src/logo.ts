// Logos are inlined into the website and served as standalone SVG files, so
// they may only use plain drawing markup. Anything that can run script or
// load other resources (script, foreignObject, animation, on* handlers,
// external hrefs) is rejected rather than cleaned up.

const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "use",
  "symbol",
  "title",
  "desc",
  "text",
  "tspan",
  "image",
  "style",
  "sodipodi:namedview",
]);

const ATTRIBUTES = new Set([
  "xmlns",
  "xmlns:xlink",
  "xmlns:svg",
  "xmlns:inkscape",
  "xmlns:sodipodi",
  "xml:space",
  "version",
  "id",
  "class",
  "style",
  "type",
  "role",
  "aria-label",
  "aria-hidden",
  "focusable",
  "data-name",
  "viewBox",
  "preserveAspectRatio",
  "enable-background",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "dx",
  "dy",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "d",
  "points",
  "transform",
  "href",
  "xlink:href",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "color",
  "display",
  "visibility",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "shape-rendering",
  "vector-effect",
  "paint-order",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "pagecolor",
  "bordercolor",
  "borderopacity",
]);

const TOKEN =
  /([^<]+)|(<\?xml[^<>?]*\?>)|(<!DOCTYPE svg[^<>[\]]*>)|(<!--(?:(?!--)[^<>])*-->)|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[A-Za-z][\w:.-]*\s*=\s*(?:"[^"<&]*"|'[^'<&]*'))*)\s*(\/?)>/y;
const ATTRIBUTE = /([A-Za-z][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const HREF = /^(#[\w.:-]+|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*)$/;

export function logoErrors(svg: string) {
  const errors: string[] = [];
  const stack: string[] = [];
  let root = "";
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < svg.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(svg);
    if (!match) {
      errors.push(`unsupported markup at ${JSON.stringify(svg.slice(at, at + 40))}`);
      break;
    }
    const [, text, , , , close, open, attributes, selfClosing] = match;
    if (text !== undefined) {
      if (text.includes("&")) errors.push("entities are not allowed");
      if (stack.at(-1) === "style") errors.push(...cssErrors(text));
      continue;
    }
    if (close) {
      if (stack.pop() !== close) errors.push(`unexpected </${close}>`);
      continue;
    }
    if (!open) continue;
    if (!root) root = open;
    if (!ELEMENTS.has(open)) errors.push(`<${open}> is not allowed`);
    for (const attribute of attributes!.matchAll(ATTRIBUTE)) {
      errors.push(...attributeErrors(open, attribute[1]!, attribute[2] ?? attribute[3]!));
    }
    if (!selfClosing) stack.push(open);
  }
  if (root !== "svg") errors.push("root element must be <svg>");
  if (stack.length > 0) errors.push(`unclosed <${stack.at(-1)}>`);
  return errors;
}

function attributeErrors(element: string, name: string, value: string) {
  if (!ATTRIBUTES.has(name) && !/^(inkscape|sodipodi):/.test(name)) {
    return [`attribute ${name} on <${element}> is not allowed`];
  }
  if ((name === "href" || name === "xlink:href") && !HREF.test(value.trim())) {
    return [`${name} must point to #id or an inline image`];
  }
  if (name === "style") return cssErrors(value);
  return urlErrors(value);
}

function cssErrors(css: string) {
  if (/[@\\]/.test(css)) return ["CSS at-rules and escapes are not allowed"];
  return urlErrors(css);
}

function urlErrors(value: string) {
  return /url\(\s*(?!['"]?#)/i.test(value) ? ["url() may only reference #id"] : [];
}
