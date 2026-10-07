// Prints the OpenAPI document generated from the Fastify routes as YAML.
// Regenerate the snapshot with `corepack pnpm openapi` (see CLAUDE.md).
import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import { buildApp } from "../src/index.ts";

const repository = new InMemoryFigLabRepository();
const app = await buildApp({
  repository,
  store: new FakeObjectStore(),
  principal: await repository.bootstrapSingleUser(),
});
await app.ready();
process.stdout.write(app.swagger({ yaml: true }));
await app.close();
