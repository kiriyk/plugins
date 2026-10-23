'use strict';
const fs=require('node:fs'),path=require('node:path'),acorn=require('acorn'),{execFileSync}=require('node:child_process');
const file=path.join(__dirname,'../ai-picks.js');
acorn.parse(fs.readFileSync(file,'utf8'),{ecmaVersion:5});
execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
console.log('ES5 and JavaScript syntax checks passed.');
