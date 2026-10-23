"""No-account OpenCode contract check against a local deterministic model endpoint.
Exercises the real CLI/server/tools/event stream/persisted continuation, not model quality.
"""
import json, os, pathlib, selectors, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

out = pathlib.Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
home = out / 'private-home'
work = home / 'work'
work.mkdir(parents=True, exist_ok=True)
requests = []
class Model(BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_POST(self):
  body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  requests.append({'model': body.get('model'), 'messages': len(body.get('messages', []))})
  messages = body.get('messages', [])
  tool_done = any(m.get('role') == 'tool' for m in messages)
  resumed = any('RESUME_CHECK' in str(m.get('content','')) for m in messages)
  if not tool_done:
   delta = {'role':'assistant','tool_calls':[{'index':0,'id':'fixture_tool_1','type':'function','function':{'name':'bash','arguments':json.dumps({'command':'printf HARNESS_TOOL_OK','description':'Print fixture token'})}}]}
   reason='tool_calls'
  else:
   delta={'role':'assistant','content':'RESUME_OK' if resumed else 'HARNESS_RUNTIME_OK'}
   reason='stop'
  if body.get('stream'):
   self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
   for part, finish in [(delta,None),({},reason)]:
    self.wfile.write(('data: '+json.dumps({'id':'fixture-completion','object':'chat.completion.chunk','created':int(time.time()),'model':'test','choices':[{'index':0,'delta':part,'finish_reason':finish}]})+'\n\n').encode())
    self.wfile.flush()
   self.wfile.write(b'data: [DONE]\n\n')
  else:
   self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
   self.wfile.write(json.dumps({'id':'fixture-completion','object':'chat.completion','choices':[{'index':0,'message':delta,'finish_reason':reason}],'usage':{'prompt_tokens':10,'completion_tokens':10}}).encode())
model = ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=model.serve_forever,daemon=True).start()
config={'$schema':'https://opencode.ai/config.json','enabled_providers':['fixture'],'model':'fixture/test','small_model':'fixture/test','provider':{'fixture':{'npm':'@ai-sdk/openai-compatible','name':'Fixture only','options':{'baseURL':f'http://127.0.0.1:{model.server_port}/v1','apiKey':'synthetic-fixture-key'},'models':{'test':{'name':'Local deterministic test','tool_call':True,'limit':{'context':32000,'output':2000}}}}}}
config_path=home/'opencode.json'; config_path.write_text(json.dumps(config))
env={'PATH':os.environ['PATH'],'HOME':str(home),'XDG_CONFIG_HOME':str(home/'config'),'XDG_DATA_HOME':str(home/'data'),'XDG_STATE_HOME':str(home/'state'),'XDG_CACHE_HOME':str(home/'cache'),'OPENCODE_CONFIG':str(config_path),'OPENCODE_DISABLE_DEFAULT_PLUGINS':'true','OPENCODE_DISABLE_AUTOUPDATE':'true'}
process=subprocess.Popen([sys.argv[2],'serve','--hostname','127.0.0.1','--port','0'],cwd=work,env=env,stdout=subprocess.PIPE,stderr=(out/'server-stderr.log').open('w'),text=True)
try:
 url=None
 selector = selectors.DefaultSelector()
 selector.register(process.stdout, selectors.EVENT_READ)
 deadline = time.monotonic() + 30
 while time.monotonic() < deadline:
  if not selector.select(timeout=1): continue
  line = process.stdout.readline()
  if not line: break
  with (out/'server-stdout.log').open('a') as f: f.write(line)
  if 'server listening on' in line: url=line.split('server listening on',1)[1].strip(); break
 selector.close()
 if not url: raise RuntimeError('OpenCode did not announce its server within 30 seconds')
 def api(path, data=None):
  req=urllib.request.Request(url+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
  return json.load(urllib.request.urlopen(req,timeout=60))
 health=api('/global/health'); assert health['healthy']
 events=[]
 def stream():
  try:
   with urllib.request.urlopen(url+'/event',timeout=90) as response:
    for line in response:
     if line.startswith(b'data: '): events.append(json.loads(line[6:]))
  except Exception: pass
 threading.Thread(target=stream,daemon=True).start()
 session=api('/session',{'title':'Harness contract fixture','permission':[{'permission':'*','pattern':'*','action':'allow'}]})
 result=api('/session/'+session['id']+'/message',{'model':{'providerID':'fixture','modelID':'test'},'parts':[{'type':'text','text':'Run the fixture command and return HARNESS_RUNTIME_OK'}]})
 assert 'HARNESS_RUNTIME_OK' in json.dumps(result),result
 history=api('/session/'+session['id']+'/message')
 assert 'HARNESS_TOOL_OK' in json.dumps(history),history
 # Retrieve the native identity again and continue through a fresh HTTP request.
 reopened=api('/session/'+session['id']); assert reopened['id']==session['id']
 resumed=api('/session/'+session['id']+'/message',{'model':{'providerID':'fixture','modelID':'test'},'parts':[{'type':'text','text':'RESUME_CHECK'}]})
 assert 'RESUME_OK' in json.dumps(resumed),resumed
 assert any(e.get('type')=='message.part.delta' for e in events), [e.get('type') for e in events]
 receipt={'version':health['version'],'sessionId':session['id'],'launch':True,'nativeTool':True,'stream':True,'sameSessionContinuation':True,'model':'local deterministic fixture','modelRequests':requests,'eventTypes':sorted({e.get('type','') for e in events}),'limits':'Native API contract with synthetic model, not installed app acceptance or model quality.'}
 # Optional real adapter check against this same isolated server and local model.
 if len(sys.argv) > 3:
  adapter_env = {**os.environ, 'OPENCODE_FIXTURE_URL':url, 'OPENCODE_FIXTURE_DIRECTORY':str(work)}
  subprocess.run([sys.argv[3], 'node_modules/vite-plus/bin/vp', 'test', 'run', 'apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.live.test.ts'], env=adapter_env, timeout=120, check=True)
  receipt['appAdapter'] = True
 (out/'runtime.json').write_text(json.dumps(receipt,indent=2)); print(json.dumps(receipt,indent=2))
finally:
 process.terminate()
 try: process.wait(timeout=10)
 except subprocess.TimeoutExpired: process.kill(); process.wait()
 model.shutdown()
