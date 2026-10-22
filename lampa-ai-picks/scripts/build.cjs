'use strict';
const path=require('node:path'),fs=require('node:fs'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..');
esbuild.buildSync({entryPoints:[path.join(root,'src/index.js')],outfile:path.join(root,'ai-picks.js'),bundle:true,format:'iife',
    target:'es5',platform:'browser',charset:'utf8',legalComments:'inline',
    define:{__AIP_CSS__:JSON.stringify(fs.readFileSync(path.join(root,'src/styles.css'),'utf8'))},
    banner:{js:'/* AI Picks 0.1.0 | Lampa 3.3.8 | Configure RouterAI in Lampa settings. */'}});
