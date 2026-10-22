#!/usr/bin/env node
import fs from 'node:fs';
import { validateMediaGtoolOwnerDispositions } from './lib/media-gtool-owner-dispositions.mjs';
const read=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
const projection=read('docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json');
const decision=read('docs/implementation/MEDIA-GTOOL-OWNER-EXECUTION-DISPOSITIONS.v1.json');
const output=validateMediaGtoolOwnerDispositions(decision,projection);
console.log(JSON.stringify(output,null,2));
if(output.structuralStatus!=='PASS')process.exitCode=1;
