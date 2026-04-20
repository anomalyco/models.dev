const LOGO_THEME_MARKER = "models-dev-logo-theme";
const LOGO_THEME_STYLE = `<style id="${LOGO_THEME_MARKER}">:root{color:#666}@media (prefers-color-scheme: dark){:root{color:#AAA}}</style>`;

export function normalizeLogoSvg(svgText: string) {
  if (svgText.includes(LOGO_THEME_MARKER)) {
    return svgText;
  }

  return svgText.replace(/<svg\b[^>]*>/i, (svgTag) => {
    const themedTag = svgTag.includes("fill=")
      ? svgTag
      : svgTag.replace("<svg", '<svg fill="currentColor"');

    return `${themedTag}${LOGO_THEME_STYLE}`;
  });
}
