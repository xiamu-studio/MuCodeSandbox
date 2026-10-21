// Local synthetic TLS material and compiled fixture, never part of a release.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {localFixtures} from './windows/local-fixtures.ts';
const directory=path.resolve('.mu-data/windows-clean-host-assets','network-'+randomUUID());
await mkdir(directory,{recursive:true});
const fixture=await localFixtures(directory,process.env.MU_OPENSSL_PATH??'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
await fixture.close();
const source=await readFile('scripts/windows/local-fixtures.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText.replace("../../server/process.ts","../../server/process.js");
assert.ok(!code.includes('process.ts'));
await writeFile(path.join(directory,'local-fixtures.js'),code);
const files=['fixture-key.pem','fixture-cert.pem','local-fixtures.js'];
const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex')])));
await writeFile('.mu-data/windows-run/clean-host-network-inputs.json',JSON.stringify({directory,hashes},null,2));
console.log('Prepared local-only TLS receivers; no external destination can be opened by this fixture.');
