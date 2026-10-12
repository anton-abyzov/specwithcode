import assert from 'node:assert/strict';
import {createHash,createPublicKey,verify} from 'node:crypto';
import test from 'node:test';
import {createProofSigner} from './dpop-proof.mjs';
const decode=v=>JSON.parse(Buffer.from(v,'base64url'));
test('bootstrap and resource proofs have valid public ES256 signatures, distinct IDs and token hashes',()=>{
  const proof=createProofSigner(),a=proof('post','https://desk.example.test/oauth/token'),b=proof('get','https://desk.example.test/api/studio/capacity?ignored=1#ignored','synthetic-test-token');
  const [header,payload,signature]=b.split('.'),h=decode(header),p=decode(payload),initial=decode(a.split('.')[1]);
  assert.equal(h.typ,'dpop+jwt');assert.equal(h.alg,'ES256');assert.equal(h.jwk.d,undefined);
  assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:createPublicKey({key:h.jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
  assert.equal(p.htm,'GET');assert.equal(p.htu,'https://desk.example.test/api/studio/capacity');
  assert.equal(p.ath,createHash('sha256').update('synthetic-test-token').digest('base64url'));assert.equal(initial.ath,undefined);assert.notEqual(p.jti,initial.jti);
});
test('proof signer rejects insecure or userinfo endpoints',()=>{
  const proof=createProofSigner();for(const url of ['http://desk.example.test','https://user:pass@desk.example.test'])assert.throws(()=>proof('GET',url));
});
test('signatures are canonical low-S for the server verifier',()=>{
  const proof=createProofSigner(),order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  for(let i=0;i<10;i++){const s=Buffer.from(proof('GET','https://desk.example.test/api').split('.')[2],'base64url');assert.ok(BigInt('0x'+s.subarray(32).toString('hex'))<=order/2n);}
});
