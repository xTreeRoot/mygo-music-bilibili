# Read-only host snapshots; native libraries and synthetic account state stay in a temporary directory.
import argparse,base64,ctypes,hashlib,json,pathlib,re,subprocess,tempfile,urllib.parse
parser=argparse.ArgumentParser(description='Run the release bundle in MB iOS/Android native QuickJS without touching apps or devices.')
parser.add_argument('--mb',required=True,type=pathlib.Path,help='Read-only local MB repository containing ios and android refs')
parser.add_argument('--ref',default='HEAD',help='Committed MB source revision; resolved once for both platforms')
options=parser.parse_args()
plugin=pathlib.Path(__file__).resolve().parent.parent
workspace=tempfile.TemporaryDirectory(prefix='bilibili-native-')
root=pathlib.Path(workspace.name)
revision=subprocess.check_output(['git','rev-parse',options.ref],cwd=options.mb,text=True).strip()
snapshots={platform:revision for platform in ['ios','android']}
for platform,revision in snapshots.items():
 paths=subprocess.check_output(['git','ls-tree','-r','--name-only',revision,'ios/Sources/MBJavaScript'],cwd=options.mb,text=True).splitlines()
 paths+=['ios/Sources/MBFoundation/Resources/PluginBootstrap.js']
 for name in paths:
  target=root/'runtime'/platform/name
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(subprocess.check_output(['git','show',revision+':'+name],cwd=options.mb))
 directory=root/'runtime'/platform/'ios/Sources/MBJavaScript'
 command=['clang','-shared','-fPIC','-O2','-DCONFIG_VERSION="2026-06-04"','-I'+str(directory/'include'),str(directory/'MBJavaScript.c')]+[str(directory/'vendor'/name) for name in ['quickjs.c','dtoa.c','libregexp.c','libunicode.c','cutils.c']]+['-o',str(root/'runtime'/(platform+'.dylib'))]
 subprocess.run(command,check=True,capture_output=True)
 print('Snapshot',platform,revision)
lyric='[00:01.00]中文歌词🎵'
class Runtime:
 def __init__(self,platform):
  self.lib=ctypes.CDLL(str(root/'runtime'/(platform+'.dylib')))
  self.storage={};self.prompts=[];self.requests=[];self.events={};self.clock=0
  self.callback=ctypes.CFUNCTYPE(ctypes.c_void_p,ctypes.c_void_p,ctypes.c_char_p,ctypes.c_char_p)(self.host)
  self.lib.mbjs_create.argtypes=[type(self.callback),ctypes.c_void_p,ctypes.c_size_t];self.lib.mbjs_create.restype=ctypes.c_void_p
  self.lib.mbjs_evaluate.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int,ctypes.c_int]
  self.lib.mbjs_start.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int]
  self.lib.mbjs_settle.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_char_p,ctypes.c_int]
  for name in ['mbjs_take_event','mbjs_result']:
   getattr(self.lib,name).argtypes=[ctypes.c_void_p];getattr(self.lib,name).restype=ctypes.c_void_p
  self.lib.mbjs_free_string.argtypes=[ctypes.c_void_p];self.lib.mbjs_destroy.argtypes=[ctypes.c_void_p]
  self.libc=ctypes.CDLL(None);self.libc.strdup.argtypes=[ctypes.c_char_p];self.libc.strdup.restype=ctypes.c_void_p
  self.pointer=self.lib.mbjs_create(self.callback,None,256<<20)
  bootstrap=(root/'runtime'/platform/'ios/Sources/MBFoundation/Resources/PluginBootstrap.js').read_text()
  if platform=='android':bootstrap=bootstrap.replace('platform: "ios", arch: "arm64"','platform: "android", arch: "arm64"')
  self.finish(self.lib.mbjs_evaluate(self.pointer,bootstrap.encode(),b'host.js',0,100))
  self.finish(self.lib.mbjs_evaluate(self.pointer,(plugin/'index.js').read_bytes(),b'plugin.js',1,500))
 def text(self,name):
  ptr=getattr(self.lib,name)(self.pointer)
  if not ptr:return None
  value=ctypes.string_at(ptr).decode();self.lib.mbjs_free_string(ptr);return value
 def host(self,_opaque,operation,arguments):
  try:
   op=operation.decode();a=json.loads(arguments)
   if op=='storage.get':v=self.storage.get(a[0])
   elif op=='storage.set':self.storage[a[0]]=a[1];v=None
   elif op=='storage.remove':self.storage.pop(a[0],None);v=None
   elif op=='t':v=a[0]
   elif op=='setting':v=''
   elif op=='language':v='zh-CN'
   elif op=='console':v=None
   elif op=='prompt':self.prompts.append(a[0]);v=None
   elif op=='md5':v=hashlib.md5(a[0].encode()).hexdigest()
   elif op=='base64.decode':v=base64.b64decode(a[0]).decode('latin1')
   elif op=='base64.encode':v=base64.b64encode(a[0].encode('latin1')).decode()
   elif op=='url':
    u=urllib.parse.urlsplit(urllib.parse.urljoin(a[1],a[0]) if len(a)>1 else a[0]);v={'href':u.geturl(),'protocol':u.scheme+':','host':u.netloc,'hostname':u.hostname or '', 'pathname':u.path or '/', 'search':'?'+u.query if u.query else '', 'hash':'#'+u.fragment if u.fragment else ''}
   else:raise ValueError('Unexpected operation '+op)
   out={'value':v}
  except Exception as e:out={'error':str(e)}
  return self.libc.strdup(json.dumps(out,ensure_ascii=False).encode())
 def response(self,event):
  address=event['url'];self.requests.append(event)
  path=urllib.parse.urlsplit(address).path;query=urllib.parse.parse_qs(urllib.parse.urlsplit(address).query)
  data={};headers={};cookies=[];code=0
  if path=='/x/web-interface/nav':
   data={'isLogin':bool(event.get('headers',{}).get('cookie') or event.get('headers',{}).get('Cookie')),'mid':123,'uname':'测试账号','wbi_img':{'img_url':'https://i.example/'+'a'*32+'.png','sub_url':'https://i.example/'+'b'*32+'.png'}}
  elif path=='/x/web-interface/wbi/search/type':
   page=int(query.get('page',['1'])[0]);data={'result':[{'bvid':'BV'+str(page),'title':'视频','duration':123,'owner':{'mid':7,'name':'作者'},'pic':'https://i0.hdslb.com/cover.jpg','dimension':{'width':1080,'height':1920}}],'numPages':2}
  elif path=='/x/web-interface/view':data={'aid':123,'cid':8,'bvid':'BV1','title':'视频','dimension':{'width':1080,'height':1920}}
  elif path=='/x/player/wbi/playurl':data={'dash':{'audio':[{'base_url':'https://media.bilivideo.com/audio.m4a','mime_type':'audio/mp4','bandwidth':128000}],'video':[{'base_url':'https://media.bilivideo.com/video.m4s','codecid':7,'height':720}]}}
  elif path=='/x/player/wbi/v2':data={'subtitle':{'subtitles':[{'lan':'zh-CN','subtitle_url':'https://aisubtitle.hdslb.com/fixture.json'}]}}
  elif path=='/fixture.json':data={'body':[{'from':1,'to':2,'content':'中文歌词🎵'}]}
  elif path=='/x/passport-login/web/qrcode/generate':data={'url':'https://account.bilibili.com/scan','qrcode_key':'fixture'}
  elif path=='/x/passport-login/web/qrcode/poll':
   data={'code':0};cookies=['SESSDATA=fixture; Path=/','DedeUserID=123; Path=/','bili_jct=csrf; Path=/']
  else:raise ValueError('Unexpected API '+path)
  result=data if path=='/fixture.json' else {'code':code,'data':data}
  raw=json.dumps(result,ensure_ascii=False).encode()
  return {'status':200,'url':address,'headers':headers,'setCookies':cookies,'body':raw.decode(),'base64':base64.b64encode(raw).decode()}
 def finish(self,status):
  # Network fixtures finish immediately; timers advance only when no fetch is
  # pending. Drain cancel events before selecting a timer, as the host does.
  for _ in range(150):
   while True:
    raw=self.text('mbjs_take_event')
    if raw is None:break
    event=json.loads(raw)
    if event['kind']=='cancel':self.events.pop(event['request'],None)
    else:
     if event['kind']=='timer':event['due']=self.clock+event['delay']
     self.events[event['id']]=event
   if status<0:raise RuntimeError(self.text('mbjs_result'))
   if status==1:return json.loads(self.text('mbjs_result'))
   fetches=[e for e in self.events.values() if e['kind']=='fetch']
   if fetches:event=fetches[0];value=self.response(event)
   else:
    timers=[e for e in self.events.values() if e['kind']=='timer']
    if not timers:raise RuntimeError('Pending call without a host event')
    event=min(timers,key=lambda e:e['due']);self.clock=event['due'];value=None
   self.events.pop(event['id'])
   status=self.lib.mbjs_settle(self.pointer,event['id'],1,json.dumps(value,ensure_ascii=False).encode(),100)
  raise RuntimeError('Too many events')
 def call(self,name,args=None):return self.finish(self.lib.mbjs_start(self.pointer,name.encode(),json.dumps(args or {},ensure_ascii=False).encode(),100))
 def close(self):self.lib.mbjs_destroy(self.pointer)
for platform in ['ios','android']:
 r=Runtime(platform)
 try:
  one=r.call('search',{'query':'视频','kind':'tracks','offset':0});two=r.call('search',{'query':'视频','kind':'tracks','offset':20})
  assert one['tracks'][0]['id']=='BV1' and two['tracks'][0]['id']=='BV2'
  assert one['tracks'][0]['duration']==123000 and one['more']
  assert one['tracks'][0]['video']=={'width':1080,'height':1920}
  assert r.call('lyrics',{'id':'BV1'})['lines'][0]=={'start':1000,'end':2000,'text':'中文歌词🎵'}
  audio=r.call('stream',{'id':'BV1','quality':'standard'});assert audio['type']=='m4a'
  assert 'Cookie' not in audio['headers']
  assert r.call('video',{'id':'BV1'})['type']=='mp4'
  profile=r.call('signIn');assert profile['id']=='123' and any(p.get('qr') for p in r.prompts)
  r.call('signOut');assert r.call('account') is None
  saved=dict(r.storage['session']);assert saved['active'] is False and saved['cookie']
  count=len(r.prompts);assert r.call('signIn')['id']=='123' and len(r.prompts)==count
  print('PASS',platform,'native QuickJS: paging/portrait geometry/UTF-8 captions/audio/video/QR/retained session')
 finally:r.close()
