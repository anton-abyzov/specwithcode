import test from 'node:test';import assert from 'node:assert/strict';import {validateMarkerApproval,markerApprovalAction} from './approval-proof.mjs';
function fixture(){return {request:{kind:'command',status:'pending',responseCapability:{type:'live'}},command:"/bin/zsh -c 'cat marker.txt'",projectId:'owned',baselineHash:'baseline',projection:{thread:{projectId:'owned',runtimeMode:'approval-required',providerInstanceId:'codex',worktreePath:'/owned/worktree'}},metadata:{routeVerified:true,ownedGitCommonDirVerified:true,nativeExecution:{modelProvider:'openai',cwd:'/owned/worktree'},projectRootHash:'baseline',workspaceHash:'baseline',trackedChanges:0,projectRootTrackedChanges:0}};}
test('admits only the exact supervised marker read at verified owned execution cwd',()=>validateMarkerApproval(fixture()));
for(const [name,change] of [['compound command',r=>r.command="/bin/zsh -c 'cat marker.txt; curl example.com'"],['credential read',r=>r.command="/bin/zsh -c 'cat ~/.codex/auth.json'"],['wrong project',r=>r.projectId='other'],['wrong cwd',r=>r.metadata.nativeExecution.cwd='/other'],['permission escalation',r=>r.request.kind='permission'],['session gone',r=>r.request.responseCapability.type='not_resumable'],['unverified route',r=>r.metadata.routeVerified=false],['root mutation',r=>r.metadata.projectRootHash='changed']])test('rejects '+name,()=>{const r=fixture();change(r);assert.throws(()=>validateMarkerApproval(r));});

test('admits actual M3 login-shell envelope with the identical literal read',()=>{const r=fixture();r.command="/bin/zsh -lc 'cat marker.txt'";validateMarkerApproval(r);});
for(const command of [
 "/bin/zsh -lc 'cat marker.txt && pwd'",
 "/bin/zsh -lc 'TOKEN=x cat marker.txt'",
 "/bin/zsh -lc 'cat marker.txt > copy.txt'",
 "/bin/zsh -lc 'cat $(printf marker.txt)'",
 "/bin/zsh -lc 'cat $HOME/marker.txt'",
 "/bin/zsh -lc 'cat ../marker.txt'",
 "/bin/zsh -ic 'cat marker.txt'",
 "/bin/zsh -lc 'cat marker.txt; rm marker.txt'",
])test('rejects altered login-shell read '+command,()=>{const r=fixture();r.command=command;assert.throws(()=>validateMarkerApproval(r));});

test('first request clicks once and repeated polling of the same request only waits',()=>{
  let approved;let clicks=0;for(const request of ['first','first','first']){if(markerApprovalAction(approved,request)==='approve'){clicks++;approved=request;}}assert.equal(clicks,1);
});
test('a genuinely different second request is denied before another click',()=>{
  assert.throws(()=>markerApprovalAction('first','second'));
});
