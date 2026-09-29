import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

// OpenAI strict structured outputs (used by `codex exec --output-schema`) accept only these keywords.
const SUPPORTED = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "description", "title",
  "$ref", "$defs", "definitions", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minItems", "maxItems",
]);

type Node = Record<string, unknown>;

export function strictSchemaProblems(node: unknown, at = "$"): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [`${at}: not a schema object`];
  const schema = node as Node;
  const problems: string[] = [];
  for (const key of Object.keys(schema)) if (!SUPPORTED.has(key)) problems.push(`${at}: unsupported keyword ${key}`);
  if (!("type" in schema) && !("anyOf" in schema) && !("$ref" in schema)) problems.push(`${at}: missing type`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) problems.push(`${at}: object without additionalProperties: false`);
    const properties = (schema.properties ?? {}) as Node;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, child] of Object.entries(properties)) {
      if (!required.has(name)) problems.push(`${at}.${name}: property not in required`);
      problems.push(...strictSchemaProblems(child, `${at}.${name}`));
    }
  }
  if (schema.items !== undefined) problems.push(...strictSchemaProblems(schema.items, `${at}[]`));
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((child, index) => problems.push(...strictSchemaProblems(child, `${at}.anyOf[${index}]`)));
  for (const defs of [schema.$defs, schema.definitions]) {
    if (defs && typeof defs === "object") for (const [name, child] of Object.entries(defs)) problems.push(...strictSchemaProblems(child, `${at}#${name}`));
  }
  return problems;
}

const dir = join(import.meta.dirname, "..", "schemas");
const files = readdirSync(dir).filter((file) => file.endsWith(".json"));

describe("Codex output schemas meet OpenAI strict structured-output rules", () => {
  it("finds schemas", () => expect(files.length).toBeGreaterThan(0));
  it.each(files)("%s", (file) => {
    expect(strictSchemaProblems(JSON.parse(readFileSync(join(dir, file), "utf8")))).toEqual([]);
  });
  it("rejects the old retro kind node and length bounds", () => {
    const old = { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { const: "owner-proposal" }, text: { type: "string", minLength: 1 } } };
    expect(strictSchemaProblems(old)).toEqual(["$.kind: missing type", "$.text: unsupported keyword minLength"]);
    expect(strictSchemaProblems({ type: "object", properties: { a: { type: "string" } } })).toEqual(["$: object without additionalProperties: false", "$.a: property not in required"]);
  });
  it("limits backlog output to revision-checked edits and requires a problem, value and acceptance criteria", () => {
    const validate = new Ajv2020().compile(JSON.parse(readFileSync(join(dir, "backlog.json"), "utf8")));
    const ticket = { id: "ticket-one", title: "Keep context", problem: "Context is lost between sprints.", value: "The owner repeats less work.", acceptanceCriteria: ["Context survives a restart."], status: "open", dependsOn: [], research: [] };
    const edit = { expectedRevision: "a".repeat(40), ticketChanges: [{ action: "create", ticket }], candidateChanges: [] };
    expect(validate(edit)).toBe(true);
    for (const extra of [{ mission: "Agent-picked mission" }, { autoMode: true }, { standingPolicy: {} }]) expect(validate({ ...edit, ...extra })).toBe(false);
    expect(validate({ ...edit, expectedRevision: "" })).toBe(false);
    for (const patch of [{ problem: " " }, { value: "" }, { acceptanceCriteria: [] }, { createdBySeatId: "seat-lead" }]) {
      expect(validate({ ...edit, ticketChanges: [{ action: "create", ticket: { ...ticket, ...patch } }] })).toBe(false);
    }
  });
});
