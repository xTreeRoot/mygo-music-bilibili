// Explicit anonymous read-only smoke check; never reads a user's account or local app data.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const saved=new Map();let ready=false;
const network=globalThis.fetch;
globalThis.fetch=(url,options={})=>network(url,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(15000)].filter(Boolean))});
globalThis.host={platform:'android',t:v=>v,crypto:{md5:v=>createHash('md5').update(v).digest('hex')},storage:{get:k=>saved.get(k),set:(k,v)=>saved.set(k,v),remove:k=>saved.delete(k)},signInPrompt:p=>{if(p.qr){ready=true;queueMicrotask(()=>plugin.cancelSignIn());}}};
const plugin=await import('../index.js');
let failures=0;
const check=async(name,run)=>{try{await run();console.log('PASS',name);}catch(error){failures++;console.log('FAIL',name,String(error.message).replace(/https?:\/\/\S+/g,'[URL]'));}};
await check('public home',async()=>assert.ok((await plugin.home()).sections.some(s=>s.tracks?.length)));
let id='BV12BHV6gEdo';
await check('public search and next page',async()=>{
 const first=await plugin.search({query:'音乐',kind:'tracks',offset:0});assert.ok(first.tracks.length);id=first.tracks[0].id;
 const second=await plugin.search({query:'音乐',kind:'tracks',offset:20});assert.ok(second.tracks.length);assert.notEqual(first.tracks[0].id,second.tracks[0].id);
});
await check('audio resource and actual bytes',async()=>{
 const media=await plugin.stream({id,quality:'standard'});
 assert.ok(media.url);assert.equal(media.headers.Cookie,undefined);
 const response=await fetch(media.url,{headers:{...media.headers,Range:'bytes=0-8191'}});assert.ok(response.ok);
 const reader=response.body.getReader();const {value}=await reader.read();await reader.cancel();assert.ok(value?.length);
});
await check('video resource',async()=>assert.ok((await plugin.video({id})).url));
await check('public comments',async()=>assert.ok(Array.isArray((await plugin.comments({trackId:id,offset:0})).comments)));
await check('official QR preparation and cancellation',async()=>{
 await assert.rejects(plugin.signIn(),error=>ready&&/cancel/i.test(error.message));assert.equal(saved.has('session'),false);
});
process.exitCode=failures?1:0;
