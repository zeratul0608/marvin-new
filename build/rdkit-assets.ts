import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import type {Plugin} from 'vite';
const require=createRequire(import.meta.url),directory=dirname(require.resolve('@rdkit/rdkit'));
const version='2026.9.1',folder=`rdkit-${version}`;
const files={'RDKit_minimal.js':'text/javascript; charset=utf-8','RDKit_minimal.wasm':'application/wasm','LICENSE.txt':'text/plain; charset=utf-8'};
const bytes=(file:string)=>readFile(file==='LICENSE.txt'?resolve(directory,'../../../..','licenses/RDKit.BSD-3-Clause.txt'):resolve(directory,file));

export function rdkitAssets():Plugin{
  let prefix='assets/';
  return {name:'molecule-rdkit-assets',
    configResolved(config){prefix=config.build.lib?'':`${config.build.assetsDir}/`;},
    configureServer(server){server.middlewares.use(async(req,res,next)=>{
      const path=new URL(req.url??'/','http://localhost').pathname,match=path.match(new RegExp(`/${folder}/([^/]+)$`));
      if(!match||!Object.hasOwn(files,match[1])){next();return;}
      try{res.setHeader('Content-Type',files[match[1] as keyof typeof files]);res.setHeader('Cache-Control','no-cache');res.end(await bytes(match[1]));}catch(error){next(error);}
    });},
    async generateBundle(){for(const name of Object.keys(files))this.emitFile({type:'asset',fileName:`${prefix}${folder}/${name}`,source:await bytes(name)});},
  };
}
