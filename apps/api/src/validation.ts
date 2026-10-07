import { Ajv, type Options } from "ajv";
import addFormats from "ajv-formats";
import type { FastifySchemaCompiler } from "fastify";

// Fastify's defaults, except that request bodies are never coerced. Its default
// `coerceTypes: "array"` would turn a figure's `null` (for example `laneCenters`) into `[0]`
// and change the scientific document it validates. Query strings and path parameters arrive
// as text, so they keep coercion.
const shared: Options = {
  useDefaults: true,
  removeAdditional: false,
  addUsedSchema: false,
  allErrors: false,
};
const coercing = new Ajv({ ...shared, coerceTypes: "array" });
const exact = new Ajv({ ...shared, coerceTypes: false });
addFormats(coercing);
addFormats(exact);

export const validatorCompiler: FastifySchemaCompiler<object> = ({ schema, httpPart }) =>
  (httpPart === "body" ? exact : coercing).compile(schema);
