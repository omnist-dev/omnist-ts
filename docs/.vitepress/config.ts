import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Omnist",
  description: "One data model, many formats: read, validate, and write JSON, YAML, TOML, XML, and OML.",
  base: "/omnist-ts/",
  cleanUrls: true,
  lastUpdated: true,

  // design/model.md and design/openness.md are carried over close to
  // verbatim from the Python port (see docs/design/*.md's file header) and
  // still link to two pages this port hasn't ported yet: a schema-directed
  // deserialization writeup and the docs/paper/ PDF. Ignore those two
  // specific dead links rather than either breaking the build or hand-
  // editing formally-shared spec text; revisit once deserialization.md
  // lands (materialize() is already ported and exported -- src/deserialize.ts).
  ignoreDeadLinks: [
    /\/deserialization$/,
    /\/docs\/paper$/,
  ],

  themeConfig: {
    search: {
      provider: "local",
    },

    nav: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "Guide", link: "/guide" },
      { text: "API", link: "/api" },
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
          { text: "CLI", link: "/cli" },
        ],
      },
      {
        text: "Design specs",
        items: [
          { text: "Model spec", link: "/design/model" },
          { text: "OML-Core grammar", link: "/design/oml-grammar" },
          { text: "OSD grammar", link: "/design/schema-osd-grammar" },
          { text: "The any type", link: "/design/any-type-spec" },
          { text: "Openness", link: "/design/openness" },
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
