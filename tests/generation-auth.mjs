import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDeviceCode, credentialsFromTokens, OAUTH_SCOPE } from '../plugins/claude/kabo-alpha/scripts/lib/credentials.js';

test('Generation adds video only by explicit consent and keeps the default device flow scope', async t => {
  const prior = globalThis.fetch, scopes=[];
  globalThis.fetch = async (_url, init) => {
    scopes.push(JSON.parse(init.body).scope);
    return Response.json({ device_code:'test-device', user_code:'TEST-CODE' });
  };
  t.after(()=>{globalThis.fetch=prior;});
  await requestDeviceCode('https://example.test/device');
  await requestDeviceCode('https://example.test/device',undefined,{video:true});
  assert.deepEqual(scopes,[OAUTH_SCOPE,`${OAUTH_SCOPE} video`]);
});
test('Missing token response scope preserves requested or previously granted video scope', () => {
  const input={endpoint:'https://example.test',issuer:'https://example.test',tokenEndpoint:'https://example.test/token',tokens:{access_token:'unit-test',refresh_token:'unit-test-refresh'},requestedScope:`${OAUTH_SCOPE} video`};
  assert.equal(credentialsFromTokens(input).scope,`${OAUTH_SCOPE} video`);
  assert.equal(credentialsFromTokens({...input,requestedScope:OAUTH_SCOPE,previous:{scope:`${OAUTH_SCOPE} video`}}).scope,`${OAUTH_SCOPE} video`);
  assert.equal(credentialsFromTokens({...input,tokens:{...input.tokens,scope:OAUTH_SCOPE}}).scope,OAUTH_SCOPE);
});
