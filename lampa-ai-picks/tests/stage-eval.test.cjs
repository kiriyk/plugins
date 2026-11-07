'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{execFileSync,spawnSync}=require('node:child_process'),path=require('node:path');
const cwd=path.resolve(__dirname,'..');
test('stage comparison replays recorded provider bodies without credentials and keeps fixed splits',()=>{
 for(const mode of ['extract','ranking']){
  const report=JSON.parse(execFileSync(process.execPath,['scripts/compare-'+mode+'.cjs'],{cwd,encoding:'utf8',env:{...process.env,ROUTERAI_APIKEY:'',ROUTERAI_MODEL:''}}));
  assert.equal(report.live,false);assert.equal(report.cases,20);assert.equal(report.primary.calls,20);assert.equal(report.specialized.calls,20);
  assert.equal(report.splits.development.primary.calls,10);assert.equal(report.splits.holdout.specialized.calls,10);
  assert.equal(report.specialized.tmdbResolution,null);
 }
});
test('live evaluation refuses missing explicit credentials and baseline before requests',()=>{
 const run=spawnSync(process.execPath,['scripts/compare-extract.cjs','--live'],{cwd,encoding:'utf8',env:{...process.env,ROUTERAI_APIKEY:'',ROUTERAI_MODEL:''}});
 assert.equal(run.status,1);assert.match(run.stderr,/requires ROUTERAI_APIKEY/);assert.equal(run.stdout,'');
});
