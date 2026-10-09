// Trusted host-only credential broker. Workers receive a short-lived, model-bound capability.
// No OAuth refresh, no secret logging, no arbitrary upstream URL, no credential mount in a worker.
import http from 'node:http';
import {openProviderBudget} from './provider-budget.mjs';
import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
const same=(left,right)=>{const a=Buffer.from(left??''),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};
const serialize=value=>JSON.stringify(value);
export async function startProviderProxy({authFile,model,reasoningEffort=null,upstreamOrigin,fetchImpl=fetch,bindHost='0.0.0.0',port=0,maxRequests=128,ledgerFile=null,requestBindingDigest=null,initializeLedger=false}) {
 if(typeof model!=='string'||!model)throw new Error('model required');
 if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>10000)throw new Error('finite provider request budget required');
 const auth=JSON.parse(await readFile(authFile,'utf8'));
 const apiKey=typeof auth.OPENAI_API_KEY==='string'?auth.OPENAI_API_KEY:null;
 const access=apiKey??auth.tokens?.access_token;
 if(typeof access!=='string'||!access)throw new Error('provider credential unavailable');
 const origin=upstreamOrigin??(apiKey?'https://api.openai.com/v1':'https://chatgpt.com/backend-api/codex');
 // Tests may inject fetch, but production never forwards to a caller-controlled host.
 if(!['https://api.openai.com/v1','https://chatgpt.com/backend-api/codex'].includes(origin))throw new Error('upstream origin not allowed');
 const budget=ledgerFile?openProviderBudget({ledgerFile,requestBindingDigest,model,reasoningEffort,upstreamOrigin:origin,maxRequests,initializeLedger}):null;
 const capability=randomBytes(32).toString('hex');let active=true,received=0,forwarded=0,refused=0;
 const evidence=[];const controllers=new Set();const transportMode=fetchImpl===fetch?'live':'mocked-test-only';
 const server=http.createServer(async(req,res)=>{
  const reject=(code)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Provider capability request refused'}}));};
  if(!active||!same(req.headers.authorization,`Bearer ${capability}`)){reject(401);return;}
  if(req.method!=='POST'||!['/responses','/responses/compact'].includes(req.url)){reject(403);return;}
  received++;
  let bytes=Buffer.alloc(0);const controller=new AbortController();controllers.add(controller);
  try {
   for await(const chunk of req){bytes=Buffer.concat([bytes,chunk]);if(bytes.length>16*1024*1024)throw new Error('request too large');}
   const body=JSON.parse(bytes);if(body.model!==model){refused++;reject(403);return;}if(reasoningEffort&&body.reasoning?.effort!==reasoningEffort){refused++;reject(403);return;}if(budget?!budget.reserve():forwarded>=maxRequests){refused++;reject(429);return;}forwarded++;
   // Forward the canonical re-serialization, not the original bytes: duplicate
   // JSON keys must not let authorization read one value while the upstream
   // receives another. The observation still digests the exact worker bytes.
   const canonical=Buffer.from(serialize(body));
   const headers={'content-type':'application/json','authorization':`Bearer ${access}`};
   if(!apiKey&&auth.tokens?.account_id)headers['chatgpt-account-id']=auth.tokens.account_id;
   for(const name of ['accept','openai-beta','originator','session_id','version','x-codex-turn-state'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
   let responseUsage=null,reportedModel=null,eventBuffer='';
   function observeEvent(text){try{const e=JSON.parse(text);const r=e.type==='response.completed'?e.response:e.object==='response'?e:null;const u=r?.usage;if(r?.model)reportedModel=r.model;if(u&&['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0))responseUsage={input_tokens:u.input_tokens,output_tokens:u.output_tokens,cached_input_tokens:u.input_tokens_details?.cached_tokens??null};}catch{}}
   const response=await fetchImpl(`${origin}${req.url}`,{method:'POST',headers,body:canonical,signal:controller.signal,redirect:'error'});
   const texts=[];function visit(value){if(Array.isArray(value)){for(const child of value)visit(child);}else if(value&&typeof value==='object'){if(value.type==='input_text'&&typeof value.text==='string')texts.push(`sha256:${createHash('sha256').update(value.text).digest('hex')}`);for(const child of Object.values(value))if(typeof child==='object')visit(child);}}visit(body.input);if(typeof body.input==='string')texts.push(`sha256:${createHash('sha256').update(body.input).digest('hex')}`);
   const observation={input_text_digests:texts,request_digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,forwarded_request_digest:`sha256:${createHash('sha256').update(canonical).digest('hex')}`,operation:req.url,model,reasoning_effort:body.reasoning?.effort??null,upstream_origin:origin,status:response.status,provider_identity_basis:'host-observed-request-to-allowlisted-openai-endpoint',server_model_identity:'unverified',transport_mode:transportMode,response_usage:null,reported_model:null};evidence.push(observation);
   const responseHeaders={};for(const name of ['content-type','x-request-id','openai-processing-ms']){const value=response.headers.get(name);if(value)responseHeaders[name]=value;}
   res.writeHead(response.status,responseHeaders);
   // Keep enough tail to redact a credential even when it crosses stream chunks.
   const decoder=new TextDecoder();let pending='';const keep=Math.max(access.length-1,0);
   const scrub=text=>text.split(access).join('[redacted-host-credential]');
   if(response.body)for await(const chunk of response.body){if(!active)break;const decoded=decoder.decode(chunk,{stream:true});eventBuffer+=decoded;if(eventBuffer.length>4*1024*1024)eventBuffer='';let boundary;while((boundary=eventBuffer.indexOf('\n\n'))>=0){const event=eventBuffer.slice(0,boundary);eventBuffer=eventBuffer.slice(boundary+2);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)observeEvent(data);}pending=scrub(pending+decoded);const count=Math.max(0,pending.length-keep);if(count){res.write(pending.slice(0,count));pending=pending.slice(count);}}
   const tail=decoder.decode();eventBuffer+=tail;if(eventBuffer.trim())observeEvent(eventBuffer.trim());observation.response_usage=responseUsage;observation.reported_model=reportedModel;res.end(scrub(pending+tail));
  }catch{if(!res.headersSent)reject(502);else res.end();}
  finally{controllers.delete(controller);}
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bindHost,resolve);});}catch(error){budget?.close();throw error;}
 const actualPort=server.address().port;
 return {baseUrl:`http://host.docker.internal:${actualPort}`,capability,model,evidence,transport_mode:transportMode,get counters(){return {received,forwarded,refused,max_requests:maxRequests,total_forwarded:budget?.reservedRequests??forwarded};},async close(){active=false;for(const c of controllers)c.abort();server.closeAllConnections();try{await new Promise(resolve=>server.close(resolve));}finally{budget?.close();}}};
}
