import fs from 'node:fs';
import path from 'node:path';
import { digest } from './compile.mjs';

/** Actual workspace bytes; runtime/control files never become model source. */
export function snapshotWorkspace(root, { paths: selected } = {}) {
  root=fs.realpathSync(root);const files=[];let bytes=0;
  function visit(file,rel){const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error(`Source symlink is unsupported: ${rel}`);
    if(stat.isDirectory()){for(const name of fs.readdirSync(file).sort()){if(['.git','node_modules','.aidlc','.flow','.kontourai'].includes(name))continue;visit(path.join(file,name),rel?`${rel}/${name}`:name);}return;}
    if(!stat.isFile()||stat.size>16*1024*1024||files.length>=10000)throw new Error('Source snapshot exceeds finite file budget');
    if(selected&&!selected.some(p=>rel===p||rel.startsWith(p+'/')))return;
    const content=fs.readFileSync(file);bytes+=content.length;if(bytes>128*1024*1024)throw new Error('Source snapshot exceeds byte budget');
    const after=fs.lstatSync(file);if(after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error('Source changed while observed');
    files.push({path:rel,digest:digest(content),bytes:content.length});}
  visit(root,'');return {source_digest:digest(files),files};
}

