// Run against an isolated frontend; all Control API requests are mocked.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright TASKCENTER_PREVIEW_URL=http://127.0.0.1:4318 node tests/task-detail-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
const browser = await chromium.launch({headless:true,channel:'chrome'});
try {
const page = await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let mode='hold';const held=[];
const runtimeRun = {id:'run-a',delegateSessionId:'session-a',executorModel:'requested-model',evidence:[JSON.stringify({delegation_id:'run-a',sessionId:'session-a',requested_model:'requested-model',reportedModels:['reported-model'],requested_effort:'medium',effective_effort:'low'})]};
const tasks=[{id:'a',title:'任务甲',goal:'目标甲',status:'planned',routing:{selectedExecutorModel:'routed-model',preferredExecutorModel:'requested-model',reasoningEffort:'medium'},cliRuns:[runtimeRun],evidence:[],tests:[]},{id:'b',title:'任务乙',goal:'目标乙',status:'planned',evidence:[]}];
await page.route('**/api/control/**',async route=>{
 const u=new URL(route.request().url());
 if(u.pathname==='/api/control/tasks'){await route.fulfill({json:{tasks,total:2,totalPages:1,actionCounts:{},projects:[]}});return;}
 const match=u.pathname.match(/\/tasks\/([ab])(\/events)?$/);
 if(!match){await route.fulfill({json:{}});return;}
 const [,id,event]=match;
 const send=async()=>{try{await route.fulfill({json:event?{events:mode==='empty'?[]:[{type:'tool.call',tool_name:'Bash',command:'SECRET_COMMAND',tool_input:{token:'SECRET_TOKEN'},output:'SECRET_OUTPUT',recorded_at:'2026-09-20T00:00:00Z'}]}:{task:tasks.find(x=>x.id===id)}})}catch{}};
 if(mode==='hold'){held.push(send);return;}
 if(mode==='fail' || (mode==='detail-fail' && !event) || (mode==='event-fail' && event)){await route.fulfill({status:503,json:{error:'模拟读取失败'}});return;}
 if(mode==='wrong-id' && !event){await route.fulfill({json:{task:tasks.find(x=>x.id!==id)}});return;}
 if(mode==='null-event' && event){await route.fulfill({json:{events:[null]}});return;}
 if(mode==='invalid-json'){await route.fulfill({contentType:'application/json',body:'{'});return;}
 if(mode==='malformed'){await route.fulfill({json:{}});return;}
 await send();
});
const detail=page.getByRole('complementary',{name:'任务详情'});
const text=()=>detail.innerText();
const eventually=async(fn)=>{for(let i=0;i<80;i++){if(await fn())return;await page.waitForTimeout(100);}throw new Error('condition timed out: '+await text());};
await page.goto(`${process.env.TASKCENTER_PREVIEW_URL || 'http://127.0.0.1:4318'}/tasks?task=a`);
await eventually(async()=>/正在加载/.test(await text()));
mode='ok';while(held.length)await held.shift()();
await eventually(async()=>(await text()).includes('目标甲'));
await page.getByRole('button',{name:'调度',exact:true}).click();assert.match(await text(),/routed-model/);assert.match(await text(),/reported-model/);assert.match(await text(),/客户端报告/);assert.doesNotMatch(await text(),/实际模型/);
await page.getByRole('button',{name:'活动',exact:true}).click();await eventually(async()=>/Bash/.test(await text()));assert.doesNotMatch(await text(),/SECRET_/);assert.match(await text(),/未记录/);
await page.getByRole('button',{name:'概览',exact:true}).click();
mode='hold';await page.getByRole('button',{name:'刷新',exact:true}).click();
await page.waitForTimeout(200);assert.match(await text(),/目标甲/,'refresh keeps previous content');
mode='ok';while(held.length)await held.shift()();
mode='fail';await page.getByRole('button',{name:'刷新',exact:true}).click();
await eventually(async()=>/读取失败/.test(await text()));assert.match(await text(),/目标甲/);
assert.match(await text(),/上次|数据|观测/);
mode='malformed';await page.getByRole('button',{name:'刷新',exact:true}).click();
await eventually(async()=>/无效/.test(await text()));assert.match(await text(),/目标甲/,'malformed response preserves successful data');
mode='invalid-json';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/JSON/.test(await text()));assert.match(await text(),/目标甲/);
mode='wrong-id';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(200);assert.match(await text(),/目标甲/);assert.doesNotMatch(await text(),/目标乙/);
await page.getByRole('button',{name:'活动',exact:true}).click();assert.match(await text(),/tool.call|Bash/,'malformed events preserve previous activity');
mode='event-fail';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/读取失败/.test(await text()));assert.match(await text(),/Bash/);
await page.getByRole('button',{name:'概览',exact:true}).click();assert.match(await text(),/目标甲/);assert.doesNotMatch(await text(),/模拟读取失败/,'activity failure must not mark detail failed');
mode='detail-fail';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/读取失败/.test(await text()));await page.getByRole('button',{name:'活动',exact:true}).click();assert.match(await text(),/Bash/);assert.doesNotMatch(await text(),/模拟读取失败/,'detail failure must not mark activity failed');
mode='null-event';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(200);assert.match(await text(),/tool.call|Bash/);
mode='empty';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/暂无活动/.test(await text()));
mode='fail';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/读取失败/.test(await text()));assert.match(await text(),/暂无活动/);assert.match(await text(),/上次成功/);
mode='hold';await page.getByRole('button',{name:'任务乙',exact:true}).click();await eventually(async()=>/正在加载/.test(await text()));assert.doesNotMatch(await text(),/目标甲|模拟读取失败/);
mode='fail';await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/读取失败/.test(await text()));assert.doesNotMatch(await text(),/目标甲|1970|分钟前的数据/);
mode='ok';while(held.length)await held.shift()();await page.waitForTimeout(100);assert.doesNotMatch(await text(),/目标甲|目标乙/,'aborted late responses cannot overwrite failed current request');
await page.getByRole('button',{name:'刷新',exact:true}).click();await eventually(async()=>/目标乙/.test(await text()));
await page.getByRole('button',{name:'证据',exact:true}).click();assert.match(await text(),/尚未提交证据/);assert.match(await text(),/未记录/);
mode='fail';await page.reload();await eventually(async()=>/读取失败/.test(await text()));assert.doesNotMatch(await text(),/1970|目标甲|目标乙|分钟前的数据/);
if(process.env.TASKCENTER_SCREENSHOT) await page.screenshot({path:process.env.TASKCENTER_SCREENSHOT,fullPage:true});
assert.deepEqual(errors,[]);console.log('PASS U1/U2 browser: routed/reported separation, safe activity, pending, refresh retention, failure/malformed retention, empty, task switch, missing evidence');
} finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
