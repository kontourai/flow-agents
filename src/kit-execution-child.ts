import {pathToFileURL} from 'node:url';
const [modulePath,exportName,serialized,deliveryId]=process.argv.slice(2);
const abort=new AbortController();process.on('message',message=>{if((message as {kind?:string})?.kind==='cancel')abort.abort();});

/** Sending is asynchronous. Flush and observe the parent's correlated ACK
 * before disconnecting; ACK confirms transport, never process completion. */
function sendOutcome(outcome:Record<string,unknown>):Promise<void>{
 return new Promise((resolve,reject)=>{
  if(!process.send||!process.connected||!deliveryId){reject(new Error('Kit result IPC is disconnected'));return;}
  let flushed=false,acknowledged=false,settled=false;
  const finish=(error?:Error)=>{if(settled||!error&&(!flushed||!acknowledged))return;settled=true;process.off('message',ack);process.off('disconnect',disconnected);if(error)reject(error);else resolve();};
  const ack=(message:unknown)=>{const value=message as Record<string,unknown>|null;if(value?.kind==='outcome-ack'&&value.deliveryId===deliveryId&&Object.keys(value).length===2){acknowledged=true;finish();}};
  const disconnected=()=>finish(new Error('Kit result IPC disconnected before acknowledgement'));
  process.on('message',ack);process.once('disconnect',disconnected);
  try{process.send({...outcome,deliveryId},error=>{if(error)finish(error);else{flushed=true;finish();}});}catch(error){finish(error as Error);}
 });
}
try{
 if(!modulePath||!exportName||!serialized)throw new Error('Missing isolated kit entry arguments');
 const args=JSON.parse(serialized);
 const entry=await import(pathToFileURL(modulePath).href);
 if(typeof entry[exportName]!=='function')throw new Error('Declared execution export must be a function');
 let outcome:Record<string,unknown>;
 try{outcome={kind:'result',result:await entry[exportName]({...args,signal:abort.signal})};}
 catch(error){outcome={kind:'error',message:error instanceof Error?error.message:String(error)};process.exitCode=1;}
 await sendOutcome(outcome);
}catch(error){process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
if(process.connected)process.disconnect?.();
