/**
 * Minimal, dependency-free JSON-Schema validator.
 *
 * Supports exactly the draft-07 subset used by the Knowledge Kit graph schemas
 * (schemas/knowledge/*.schema.json): type, required, properties,
 * additionalProperties:false, enum, const, items, minLength, minItems, integer,
 * and local `$ref` into `#/$defs/*`. It is intentionally NOT a general validator
 * — it exists so health reports and conformance tests can assert schema validity
 * without pulling an external dependency (the same zero-dep discipline the
 * decision-registry validator follows).
 *
 * @module providers/lib/schema-validate
 */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object") return typeOf(value) === "object";
  if (type === "array") return Array.isArray(value);
  return typeOf(value) === type;
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref (only local #/ refs): ${ref}`);
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const part of parts) {
    node = node && node[part];
  }
  if (!node) throw new Error(`Unresolved $ref: ${ref}`);
  return node;
}

function validateNode(value, schema, root, pathStr, errors) {
  if (schema.$ref) {
    return validateNode(value, resolveRef(schema.$ref, root), root, pathStr, errors);
  }

  if ("const" in schema) {
    if (value !== schema.const) {
      errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${pathStr}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join("|")}, got ${typeOf(value)}`);
      return; // further checks assume the type held
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${pathStr}: array shorter than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, root, `${pathStr}[${i}]`, errors));
    }
  }

  if (typeOf(value) === "object") {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${pathStr}: missing required property '${req}'`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathStr}: unexpected property '${key}'`);
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) {
        validateNode(value[key], propSchema, root, `${pathStr}/${key}`, errors);
      }
    }
  }
}

/**
 * Validate `value` against `schema`.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Assert validity, throwing a descriptive error when invalid. Handy in tests.
 */
export function assertValid(value, schema, label = "value") {
  const { valid, errors } = validate(value, schema);
  if (!valid) {
    const err = new Error(`${label} failed schema validation:\n  ${errors.join("\n  ")}`);
    err.code = "SCHEMA_INVALID";
    err.errors = errors;
    throw err;
  }
}
