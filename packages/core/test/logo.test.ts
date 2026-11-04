import { expect, test } from "bun:test";

import { logoErrors } from "../src/logo.js";

const svg = (body: string, attributes = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attributes}>${body}</svg>`;

test("accepts plain drawing markup", () => {
  expect(logoErrors(svg(`<path d="M0 0h24v24H0z" fill="currentColor"/>`))).toEqual([]);
  expect(
    logoErrors(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- source: example.com -->\n` +
        svg(
          `<defs><clipPath id="a"><rect width="24" height="24"/></clipPath></defs>` +
            `<g clip-path="url(#a)" style="fill:currentColor"><circle cx="12" cy="12" r="6"/></g>` +
            `<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="24" height="24"/>`,
          ` xmlns:xlink="http://www.w3.org/1999/xlink"`,
        ),
    ),
  ).toEqual([]);
});

test("rejects script-capable content", () => {
  const unsafe = [
    svg(`<script>alert(1)</script>`),
    svg(`<SCRIPT>alert(1)</SCRIPT>`),
    svg(`<path d="M0 0"/>`, ` onload="alert(1)"`),
    svg(`<path d="M0 0" ONCLICK="alert(1)"/>`),
    `<svg/onload=alert(1)>`,
    svg(`<a href="javascript:alert(1)"><path d="M0 0"/></a>`),
    svg(`<use href="javascript:alert(1)"/>`),
    svg(`<use xlink:href="https://evil.example/x.svg#a"/>`),
    svg(`<image href="data:image/svg+xml;base64,PHN2Zz4="/>`),
    svg(`<foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>`),
    svg(`<set attributeName="href" to="javascript:alert(1)"/>`),
    svg(`<![CDATA[<script>alert(1)</script>]]>`),
    svg(`<!--><script>alert(1)</script>-->`),
    svg(`<path d="M0 0" fill="url(https://evil.example/x)"/>`),
    svg(`<style>@import "https://evil.example/x.css";</style>`),
    svg(`<path d="M0 0" style="fill:u&#114;l(https://evil.example/x)"/>`),
    svg(`<title>&lt;script&gt;</title>`),
  ];
  for (const logo of unsafe) expect(logoErrors(logo)).not.toEqual([]);
});
