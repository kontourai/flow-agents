import {pathToFileURL} from 'node:url';
const [modulePath,exportName,serialized]=process.argv.slice(2);
try{
 if(!modulePath||!exportName||!serialized)throw new Error('Missing isolated kit entry arguments');
 const entry=await import(pathToFileURL(modulePath).href);
 if(typeof entry[exportName]!=='function')throw new Error('Declared execution export must be a function');
 const result=await entry[exportName](JSON.parse(serialized));
 process.send?.({kind:'result',result});
}catch(error){process.send?.({kind:'error',message:(error as Error).message});process.exitCode=1;}
process.disconnect?.();
