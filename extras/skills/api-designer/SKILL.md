---
name: api-designer
description: Designs or reviews REST, GraphQL and JSON-RPC APIs: resources, schemas, errors, pagination, versioning; outputs an OpenAPI/SDL contract and checks it.
---
# Workflow: API Design

1. **Understand the consumers and operations:** who calls it, which use cases, read/write ratio. Read the existing API first and match its naming, casing, auth and error style.
2. **Pick the style** (keep the project's if one exists): REST for resource CRUD, GraphQL for client-shaped queries, JSON-RPC for command-style internal calls.
3. **Design the contract:**
   - REST: plural nouns, HTTP verbs with correct semantics (GET safe, PUT/DELETE idempotent), status codes (201 + Location, 204, 400 vs 422, 401 vs 403, 404, 409, 429), `Idempotency-Key` for unsafe retried POSTs.
   - Lists: cursor pagination (`limit`, `cursor`, `next_cursor`), explicit filter/sort params, a maximum page size.
   - Errors: one machine-readable shape everywhere, e.g. `{ "error": { "code", "message", "details", "request_id" } }`.
   - GraphQL: nullable-by-design fields, connection types for lists, input types for mutations, errors as typed payloads where the client must react.
   - Versioning: additive changes only inside a version; say how breaking changes are introduced (path or header) and deprecated (`Deprecation`/`Sunset` headers or `@deprecated`).
4. **Write the spec** as OpenAPI 3.1 YAML (or GraphQL SDL / JSON-RPC method table) into the path the user names or `docs/api/`.
5. **Validate:** lint with the tool the project already has (`npx @redocly/cli lint`, `spectral lint`, `graphql-inspector`) if available; otherwise re-read the spec against the checklist: every operation has success + error responses, schemas are reused via `$ref`, every field has a type and description, examples parse.
6. **Report:** the contract location, decisions and trade-offs, breaking-change risks versus the current API.

Rules: never put secrets in examples; never design an endpoint that returns unbounded lists; call out authentication/authorization for every operation.
