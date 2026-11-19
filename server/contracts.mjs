import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const read = (name) => readFileSync(new URL('../contracts/' + name, import.meta.url), 'utf8');
export const api = YAML.parse(read('api.yaml'));
export const intentSchema = JSON.parse(read('intent.schema.json'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
// Component references keep their original JSON pointers and the relative intent-schema URI.
ajv.addSchema(intentSchema, 'intent.schema.json');
export const compile = (schema) => ajv.compile({ components: api.components, ...schema });
export const validIntent = ajv.getSchema(intentSchema.$id);
export const requests = Object.fromEntries(
  Object.entries(api.paths).map(([path, ops]) => [
    path,
    compile(ops.post.requestBody.content['application/json'].schema),
  ]),
);
export const validList = compile({
  type: 'object',
  additionalProperties: false,
  required: ['session_id'],
  properties: Object.fromEntries(
    api.paths['/intents'].get.parameters.map((p) => [p.name, p.schema]),
  ),
});
export const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApiError extends Error {
  constructor(code, details = {}) {
    super(code.replaceAll('_', ' '));
    const { http, agent_hint } = api['x-error-codes'][code];
    this.status = http;
    this.body = {
      ok: false,
      simulated: true,
      error: { code, message: this.message, agent_hint, ...details },
    };
  }
}
export function requireRule(condition, code, details) {
  if (!condition) throw new ApiError(code, details);
}
