import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';

// Test-client proof keys live only in memory. This matches the supported
// /oauth/token ES256 DPoP exchange; it never reads native provider credentials.
export function createProofSigner(){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const {kty,crv,x,y}=publicKey.export({format:'jwk'});const jwk={kty,crv,x,y};
  return function proof(method,url,accessToken){
    const u=new URL(url);assert.equal(u.protocol,'https:');assert.equal(u.username,'');assert.equal(u.password,'');
    u.search='';u.hash='';
    const payload={htm:method.toUpperCase(),htu:u.href,jti:randomUUID(),iat:Math.floor(Date.now()/1000)};
    if(accessToken)payload.ath=createHash('sha256').update(accessToken).digest('base64url');
    const encoded=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
    const input=encoded({typ:'dpop+jwt',alg:'ES256',jwk})+'.'+encoded(payload);
    const signature=sign('sha256',Buffer.from(input),{key:privateKey,dsaEncoding:'ieee-p1363'});
    // Noble's P-256 verifier rejects high-S signatures; use canonical low-S.
    const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const s=BigInt('0x'+signature.subarray(32).toString('hex'));
    if(s>order/2n)Buffer.from((order-s).toString(16).padStart(64,'0'),'hex').copy(signature,32);
    return input+'.'+signature.toString('base64url');
  };
}
