import assert from 'node:assert/strict';

// Only the two observed native shell envelopes are allowed. The literal read
// stays identical; no command parsing, substitutions, redirects or expansions.
export function isExactMarkerRead(command){
  return command==="/bin/zsh -c 'cat marker.txt'"||command==="/bin/zsh -lc 'cat marker.txt'";
}

// A repeated observation of the first request is not another permission click.
export function markerApprovalAction(approvedRequestId,requestId){
  assert.ok(typeof requestId==='string'&&requestId.length>0);
  if(approvedRequestId===undefined)return 'approve';
  assert.equal(approvedRequestId,requestId,'A second separate native request is outside this one-shot fixture');
  return 'wait';
}

// Approval stays one-shot and confined to the read authorized for this fixture.
export function validateMarkerApproval({request,command,projection,projectId,metadata,baselineHash}){
  assert.equal(request.kind,'command');assert.equal(request.status,'pending');
  assert.equal(request.responseCapability.type,'live');
  assert.equal(isExactMarkerRead(command),true);
  assert.equal(projection.thread.projectId,projectId);
  assert.equal(projection.thread.runtimeMode,'approval-required');
  assert.equal(projection.thread.providerInstanceId,'codex');
  assert.equal(metadata.routeVerified,true);assert.equal(metadata.ownedGitCommonDirVerified,true);
  assert.equal(metadata.nativeExecution.modelProvider,'openai');
  assert.equal(metadata.nativeExecution.cwd,projection.thread.worktreePath);
  assert.equal(metadata.projectRootHash,baselineHash);assert.equal(metadata.workspaceHash,baselineHash);
  assert.equal(metadata.trackedChanges,0);assert.equal(metadata.projectRootTrackedChanges,0);
}
