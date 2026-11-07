'use strict';
require('./stage-eval.cjs').run('ranking').catch(e=>{console.error(e.message);process.exitCode=1});
