import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Omnist",
  description: "One data model, many formats: read, validate, and write JSON, YAML, TOML, XML, and OML.",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,

  ignoreDeadLinks: [
    /\/api\/index\.html$/,
    /\/api\/index$/,
    /\/api\//,
  ],

  head: [
    ["link", { rel: "icon", href: "/logo.svg", type: "image/svg+xml" }],
  ],

  themeConfig: {
    logo: "/logo.svg",

    search: {
      provider: "local",
    },

    nav: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "Guide", link: "/guide" },
      { text: "API", link: "/api" },
      { text: "TypeDoc", link: "/api/index.html", target: "_blank" },
      { text: "CLI", link: "/cli" },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "User guide", link: "/guide" },
          { text: "A real-life example", link: "/example" },
        ],
      },
      {
        text: "The model",
        items: [
          { text: "Schema model & OSD", link: "/schema" },
          { text: "Glossary", link: "/glossary" },
        ],
      },
      {
        text: "Formats",
        items: [
          { text: "Overview", link: "/formats/overview" },
          { text: "OML", link: "/formats/oml" },
          { text: "JSON", link: "/formats/json" },
          { text: "YAML", link: "/formats/yaml" },
          { text: "TOML", link: "/formats/toml" },
          { text: "XML", link: "/formats/xml" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API reference", link: "/api" },
          { text: "TypeDoc API", link: "/api/index.html", target: "_blank" },
          { text: "CLI", link: "/cli" },
        ],
      },
      {
        text: "Project",
        items: [
          { text: "Testing", link: "/testing" },
          { text: "Performance", link: "/performance" },
          { text: "Python parity", link: "/python-parity" },
          { text: "Repo layout", link: "/layout" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/omnist-dev/omnist-ts" },
    ],
  },
});
