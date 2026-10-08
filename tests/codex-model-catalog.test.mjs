import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-model-catalog-"));
const fake = join(directory, "fake.mjs");
const trace = join(directory, "trace.jsonl");
await writeFile(fake, `import {createInterface} from "node:readline";
import {appendFileSync} from "node:fs";
const send = value => console.log(JSON.stringify(value));
let waiting;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); appendFileSync(process.env.CATALOG_TRACE,JSON.stringify(m)+"\\n");
 if(m.method==="initialize") send({id:m.id,result:{}});
 if(m.method==="model/list") {
  if(process.env.CATALOG_MODE==="error") { send({id:m.id,error:{message:"secret upstream detail"}}); continue; }
  if(!m.params.cursor) { waiting=m.id; send({id:99,method:"item/commandExecution/requestApproval",params:{}}); }
  else send({id:m.id,result:{data:[{model:"custom/new",displayName:"New",description:"New model",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],nextCursor:null}});
 }
 if(m.id===99 && m.error) send({id:waiting,result:{data:[{model:"gpt/example",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"medium"},{reasoningEffort:"ultra"}]}],nextCursor:"page-2"}});
}
`);
process.env.TASKCENTER_CODEX_COMMAND = process.execPath;
process.env.TASKCENTER_CODEX_PREFIX_ARGS = JSON.stringify([fake]);
process.env.CATALOG_TRACE = trace;
test.after(() => rm(directory, { recursive: true, force: true }));

test("完整目录翻页、并发去重和缓存，只查询 model/list，不启动任务或放行审批", async () => {
  const { codexModelCatalog } = await import("../scripts/harnesses/codex-model-catalog.mjs?success");
  const first = codexModelCatalog(); const concurrent = codexModelCatalog();
  assert.equal(first, concurrent);
  const catalog = await first;
  assert.equal(catalog.status, "succeeded");
  assert.deepEqual(catalog.models.map(model => model.id), ["gpt/example", "custom/new"]);
  assert.deepEqual(catalog.models[0].reasoning_efforts, ["low", "medium"]);
  assert.equal(catalog.models[1].runtime_model, "custom/new");
  assert.deepEqual(await codexModelCatalog(), catalog);
  const messages = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(messages.filter(message => message.method).map(message => message.method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.equal(messages.find(message => message.id === 99).error.code, -32601);
});

test("读取失败和缺少 Codex 时返回明确不可用状态，绝不泄漏上游信息或伪造目录", async () => {
  process.env.CATALOG_MODE = "error";
  const { codexModelCatalog } = await import("../scripts/harnesses/codex-model-catalog.mjs?error");
  const unavailable = await codexModelCatalog();
  assert.equal(unavailable.status, "unavailable"); assert.deepEqual(unavailable.models, []);
  assert.equal(JSON.stringify(unavailable).includes("secret upstream detail"), false);
  process.env.TASKCENTER_CODEX_COMMAND = join(directory, "not-installed");
  const missing = await import("../scripts/harnesses/codex-model-catalog.mjs?missing");
  assert.equal((await missing.codexModelCatalog()).status, "unavailable");
});
