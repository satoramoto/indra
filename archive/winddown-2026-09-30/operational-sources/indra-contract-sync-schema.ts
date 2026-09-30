import { readFileSync, writeFileSync } from 'node:fs';
import { CEREMONY_SCHEMA_DEFS } from '/Users/ryan/.codex/worktrees/indra-remodel-contract/indra/src/ceremony.ts';
const root = '/Users/ryan/.codex/worktrees/indra-remodel-contract/indra';
const file = `${root}/schema/v1/state.schema.json`;
const schema = JSON.parse(readFileSync(file,'utf8'));
Object.assign(schema.$defs, CEREMONY_SCHEMA_DEFS);
writeFileSync(file,JSON.stringify(schema,null,2)+'\n');
