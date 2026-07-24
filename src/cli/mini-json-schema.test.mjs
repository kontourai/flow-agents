import assert from "node:assert/strict";
import test from "node:test";

import { validateSchemaValue } from "../../build/src/lib/mini-json-schema.js";

const carrierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["identity"],
  properties: {
    identity: { $ref: "#/$defs/identity" },
  },
  $defs: {
    identity: {
      type: "string",
      minLength: 1,
      maxLength: 8,
      pattern: "^[a-z0-9-]+$",
    },
  },
};

const rootSchema = {
  type: "object",
  additionalProperties: false,
  required: ["carrier"],
  properties: {
    carrier: { $ref: "carrier.schema.json" },
  },
};

test("validateSchemaValue resolves registered external schemas and their internal refs", () => {
  const issues = [];
  validateSchemaValue(
    "fixture.json",
    { carrier: { identity: "actor-1" } },
    rootSchema,
    "fixture",
    issues,
    rootSchema,
    { "carrier.schema.json": carrierSchema },
  );
  assert.deepEqual(issues, []);
});

test("validateSchemaValue validates values through registered external schemas", () => {
  const issues = [];
  validateSchemaValue(
    "fixture.json",
    { carrier: { identity: "" } },
    rootSchema,
    "fixture",
    issues,
    rootSchema,
    { "carrier.schema.json": carrierSchema },
  );
  assert.deepEqual(issues, [
    {
      path: "fixture.json",
      message: "fixture.carrier.identity must not be empty",
    },
    {
      path: "fixture.json",
      message: "fixture.carrier.identity must match pattern ^[a-z0-9-]+$",
    },
  ]);
});

test("validateSchemaValue enforces external string bounds and patterns", () => {
  for (const [identity, expected] of [
    ["identity-too-long", "must contain at most 8 characters"],
    ["BAD", "must match pattern ^[a-z0-9-]+$"],
  ]) {
    const issues = [];
    validateSchemaValue(
      "fixture.json",
      { carrier: { identity } },
      rootSchema,
      "fixture",
      issues,
      rootSchema,
      { "carrier.schema.json": carrierSchema },
    );
    assert.match(issues.map((issue) => issue.message).join("\n"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("validateSchemaValue rejects unregistered external schema refs", () => {
  const issues = [];
  validateSchemaValue("fixture.json", { carrier: { identity: "actor-1" } }, rootSchema, "fixture", issues);
  assert.deepEqual(issues, [
    {
      path: "fixture.json",
      message: "fixture.carrier has unsupported schema ref carrier.schema.json",
    },
  ]);
});
