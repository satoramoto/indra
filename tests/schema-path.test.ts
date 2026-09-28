import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { schemaPathOf } from "../src/reload.js";

describe("schemaPathOf", () => {
  const root = "/opt/indra";

  it("finds schemas at the app root from a bundle under builds/<id>/", () => {
    const bundle = pathToFileURL(`${root}/builds/abc123/cli.js`).href;
    expect(schemaPathOf(bundle, "brief.json")).toBe(`${root}/schemas/brief.json`);
  });

  it("finds schemas at the app root from dist/ and src/", () => {
    expect(schemaPathOf(pathToFileURL(`${root}/dist/cli.js`).href, "review.json")).toBe(`${root}/schemas/review.json`);
    expect(schemaPathOf(pathToFileURL(`${root}/src/planning-bridge.ts`).href, "proposal.json")).toBe(`${root}/schemas/proposal.json`);
  });
});
