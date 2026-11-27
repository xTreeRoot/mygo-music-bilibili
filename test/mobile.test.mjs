// Regress portable login, legacy storage and media behavior without real accounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
let sequence=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const response=data=>({ok:true,status:200,headers:{getSetCookie:()=>[]},json:async()=>({code:0,data})});
async function fixture(run,{storage=new Map(),platform='android',fetch}={}){
 const previous={host:globalThis.host,fetch:globalThis.fetch};
 globalThis.host={platform,t:v=>v,signInPrompt:()=>{},crypto:{md5:v=>createHash('md5').update(v).digest('hex')},
  storage:{get:k=>structuredClone(storage.get(k)),set:(k,v)=>storage.set(k,structuredClone(v)),remove:k=>storage.delete(k)}};
 globalThis.fetch=fetch;
 try{const plugin=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#mobile-${++sequence}`);await run(plugin,storage);}
 finally{Object.assign(globalThis,previous);}
}
for(const platform of ['darwin','ios','android']){
 test(`${platform}: old local preferences migrate once and logout keeps credentials`,async()=>{
  const old={cookie:'SESSDATA=fixture; DedeUserID=123; bili_jct=csrf',enabled:false};
  await fixture(async(plugin,storage)=>{
   assert.deepEqual(storage.get('session'),{cookie:old.cookie,active:false});
   assert.equal(await plugin.account(),null);
   assert.equal((await plugin.signIn()).id,'123');
   plugin.signOut();assert.deepEqual(storage.get('session'),{cookie:old.cookie,active:false});
   assert.deepEqual(storage.get('legacy.preferences'),old);
  },{platform,storage:new Map([['legacy.preferences',old]]),fetch:async()=>response({isLogin:true,mid:123,uname:'fixture'})});
 });
}
for(const stage of ['headers','body']){
 test(`cancel ${stage} settles login even if the transport ignores abort`,{timeout:1500},async()=>{
  const entered=deferred(),late=deferred();
  const saved={cookie:'SESSDATA=fixture; DedeUserID=123; bili_jct=csrf',active:false};
  await fixture(async(plugin,storage)=>{
   const pending=assert.rejects(plugin.signIn(),/cancel/i);await entered.promise;
   plugin.cancelSignIn();await pending;
   late.resolve(stage==='headers'?response({isLogin:true,mid:123}):{code:0,data:{isLogin:true,mid:123}});
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(await plugin.account(),null);assert.deepEqual(storage.get('session'),saved);
  },{storage:new Map([['session',saved]]),fetch:async()=>{
   entered.resolve();if(stage==='headers')return late.promise;
   return {ok:true,status:200,json:()=>late.promise};
  }});
 });
}
test('nested legacy preferences from the Android migrator become a plugin session',async()=>{
 await fixture(async(plugin,storage)=>{
  assert.deepEqual(storage.get('session'),{cookie:'SESSDATA=nested',active:false});
  assert.equal(await plugin.account(),null);
 },{storage:new Map([['legacy',{preferences:{cookie:'SESSDATA=nested',enabled:false}}]])});
});
test('legacy import never overrides a current session',async()=>{
 const saved={cookie:'SESSDATA=new',active:false};
 await fixture(async(_plugin,storage)=>assert.deepEqual(storage.get('session'),saved),{storage:new Map([['session',saved],['legacy.preferences',{cookie:'old',enabled:true}]])});
});
test('cookie validation rejects mismatched account identity',async()=>{
 const saved={cookie:'SESSDATA=fixture; DedeUserID=123; bili_jct=csrf',active:false};
 await fixture(async(plugin,storage)=>{await assert.rejects(plugin.signIn(),error=>error.code==='invalid');assert.deepEqual(storage.get('session'),saved);},
 {storage:new Map([['session',saved]]),fetch:async()=>response({isLogin:true,mid:456})});
});
test('standard and lossless media use actual formats and never send account cookies to CDN',async()=>{
 await fixture(async(plugin)=>{
  const standard=await plugin.stream({id:'BV123',quality:'standard'});assert.equal(standard.url,'https://media.bilivideo.com/low.m4a');assert.equal(standard.type,'m4a');
  const lossless=await plugin.stream({id:'BV123',quality:'lossless'});assert.equal(lossless.type,'flac');assert.equal(lossless.headers.Cookie,undefined);
 },{fetch:async(address)=>{
  const path=new URL(address).pathname;
  if(path==='/x/web-interface/view')return response({aid:1,cid:2});
  if(path==='/x/web-interface/nav')return response({wbi_img:{img_url:`https://i.example/${'a'.repeat(32)}.png`,sub_url:`https://i.example/${'b'.repeat(32)}.png`}});
  if(path==='/x/player/wbi/playurl')return response({dash:{audio:[{base_url:'https://media.bilivideo.com/high.m4a',mime_type:'audio/mp4',bandwidth:192000},{base_url:'https://media.bilivideo.com/low.m4a',mime_type:'audio/mp4',bandwidth:64000},{base_url:'https://media.bilivideo.com/lossless.flac',mime_type:'audio/flac',bandwidth:900000}]}});
  assert.fail(path);
 }});
});

test('like status keeps requested multipart IDs while sharing the BV cache', async()=>{
 let queries=0;
 await fixture(async plugin=>{
  const first=await plugin.isLiked({ids:['BV123:9','BV123:10']});
  assert.deepEqual(first,{'BV123:9':true,'BV123:10':true});
  assert.deepEqual(await plugin.isLiked({ids:['BV123:11']}),{'BV123:11':true});
  assert.equal(queries,1);
 },{storage:new Map([['session',{cookie:'SESSDATA=fixture; bili_jct=csrf',active:true}]]),fetch:async address=>{
  const path=new URL(address).pathname;
  if(path==='/x/web-interface/view')return response({aid:1,cid:2});
  if(path==='/x/web-interface/archive/relation'){queries++;return response({like:true});}
  assert.fail(path);
 }});
});

test('adding to a platform folder validates ownership and uses the archive favorite contract',async()=>{
 const writes=[];
 await fixture(async plugin=>{
  await plugin.addToPlaylist({id:'42',trackIds:['BV123:9','BV123:10']});
  assert.equal(writes.length,1);
  assert.deepEqual(Object.fromEntries(writes[0]),{rid:'7',type:'2',add_media_ids:'42',csrf:'csrf'});
  await assert.rejects(plugin.addToPlaylist({id:'99',trackIds:['BV123']}),/own favorite/);
  assert.equal(writes.length,1);
 },{storage:new Map([['session',{cookie:'SESSDATA=fixture; bili_jct=csrf',active:true}]]),fetch:async(address,options)=>{
  const path=new URL(address).pathname;
  if(path==='/x/web-interface/nav')return response({isLogin:true,mid:123,uname:'fixture'});
  if(path==='/x/v3/fav/folder/created/list-all')return response({list:[{id:42,title:'Music'}]});
  if(path==='/x/v3/fav/folder/info')return response({id:42,title:'Music'});
  if(path==='/x/web-interface/view')return response({aid:7,cid:2});
  if(path==='/x/v3/fav/resource/deal'){writes.push(new URLSearchParams(options.body));return response({});}
  assert.fail(path);
 }});
});
