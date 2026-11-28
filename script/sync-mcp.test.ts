import { expect, test } from "bun:test";
import { iranRouterServer } from "./sync-mcp";

const hub = "https://iranrouter.net/mcp";

test("maps an IranRouter marketplace provider onto one hub remote", () => {
  const record = iranRouterServer(
    {
      slug: "digikala",
      name: "دیجیکالا",
      name_en: "Digikala",
      description: "جستجوی کالا",
      description_en: "Search Digikala products.",
      website_url: "https://www.digikala.com",
      tools: [
        {
          name: "dk_search",
          title: "جستجو",
          title_en: "Search",
          description_en: "Search products",
        },
        { name: " " },
      ],
    },
    hub,
    "https://iranrouter.net/images/mcp/digikala.png",
  );

  expect(record).toMatchObject({
    name: "net.iranrouter/digikala",
    title: "Digikala",
    description: "Search Digikala products.",
    origin: "iranrouter",
    listing: "https://iranrouter.net/marketplace/digikala",
    website: "https://www.digikala.com",
    icon: "https://iranrouter.net/images/mcp/digikala.png",
    remotes: [{ type: "streamable-http", url: hub }],
    tools: [{ name: "dk_search", title: "Search", description: "Search products" }],
  });
  expect(record?.aliases).toContain("دیجیکالا");
});

test("rejects a provider that is not a single marketplace slug", () => {
  expect(iranRouterServer({ slug: "Digikala", name_en: "Digikala", description_en: "Shop" }, hub)).toBeUndefined();
  expect(iranRouterServer({ slug: "shop/extra", name_en: "Shop", description_en: "Shop" }, hub)).toBeUndefined();
  expect(
    iranRouterServer({ slug: "digikala", name_en: "Digikala", description_en: "Shop" }, "http://iranrouter.net/mcp"),
  ).toBeUndefined();
});
