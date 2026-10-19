import { createOpenAPI } from 'fumadocs-openapi/server';

// The live schema, which api/openapi.py serves. Read at build time only.
// shortcut: the docs show whatever production serves at build time, so a
// schema change ships to the docs on the next docs build, not with the API.
export const SCHEMA_URL = 'https://oceanofjobs.com/api/openapi.json';

export const openapi = createOpenAPI({ input: [SCHEMA_URL] });
