import test from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRepository} from './repository.mjs';
import {configureSettlementCallbacks, pollSettlementCallbacks} from './settlement-callbacks.mjs';

test('only calls for newly settled positions after opt-in, once per event', async t => {
  for (const [key,value] of Object.entries({TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'fixture',TWILIO_FROM_NUMBER:'+12025550101',SETTLEMENT_CALLBACK_TO:'+12025550102'})) {
    const old=process.env[key];process.env[key]=value;
    t.after(()=>{if(old===undefined) delete process.env[key];else process.env[key]=old;});
  }
  const repo=new SQLiteRepository(':memory:');t.after(()=>repo.close());
  let calls=0,reads=0;
  const row={instrumentSymbol:'ABC',outcome:'yes',payout:'2.00',contractMetadata:{eventName:'A & B'}};
  const read=async()=>{reads++;return [{...row,settledAt:'2000-01-01T00:00:00Z'},{...row,settledAt:'2099-01-01T00:00:00Z'}];};
  const send=async(_url,init)=>{calls++;assert.match(init.body.get('Twiml'),/A &amp; B/);return new Response(null,{status:201});};
  await pollSettlementCallbacks(repo,read,send);
  assert.equal(reads,0);
  assert.equal(configureSettlementCallbacks(repo,'POST',{enabled:true}).enabled,true);
  await Promise.all([pollSettlementCallbacks(repo,read,send),pollSettlementCallbacks(repo,read,send)]);
  assert.equal(calls,1);
  configureSettlementCallbacks(repo,'POST',{enabled:false});
  await pollSettlementCallbacks(repo,read,send);
  assert.equal(reads,2);
});
