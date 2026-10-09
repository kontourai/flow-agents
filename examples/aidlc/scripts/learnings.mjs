import fs from 'node:fs';
import path from 'node:path';
import {digest} from './compile.mjs';

/** Durable provenance capture. Knowledge Kit adoption is a separate public import. */
export function createLearningCapture({controllerRoot}) {
  const root=path.join(controllerRoot,'learnings');fs.mkdirSync(root,{recursive:true,mode:0o700});
  return {async capture(input){
    if(typeof input.text!=='string'||digest(input.text)!==input.digest)throw new Error('Learning source digest mismatch');
    const id=digest(input),file=path.join(root,`${id}.json`),record={schema:'kontour.learning-source',version:'1.0',...input};
    if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==JSON.stringify(record)+'\n')throw new Error('Learning source record changed');}
    else fs.writeFileSync(file,JSON.stringify(record)+'\n',{flag:'wx',mode:0o600});
    return {reference:`sha256:${id}`,file,source_digest:input.digest,knowledge_adoption:'not_imported'};
  }};
}
