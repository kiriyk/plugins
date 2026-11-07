'use strict';
require('./stage-eval.cjs').run('extract').catch(e=>{console.error(e.message);process.exitCode=1});
