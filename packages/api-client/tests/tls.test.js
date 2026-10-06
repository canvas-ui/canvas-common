import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certificates, nginxFixture } from './support/fixture.js';

test('Node and Bun authenticate through nginx without weakening server verification', async () => {
    const dir=certificates(); const fixture=await nginxFixture(dir);
    try {
        for(const trust of [true,false]) for(const runtime of [process.execPath,...(process.env.CANVAS_TEST_BUN ? [process.env.CANVAS_TEST_BUN] : [])]) {
            const child=spawn(runtime,[fileURLToPath(new URL('./support/tls-runtime.js',import.meta.url))],{
                env:{...process.env,NODE_EXTRA_CA_CERTS:trust?join(dir,'root.crt'):'',CANVAS_TLS_EXPECT_UNTRUSTED:trust?'':'1',CANVAS_TLS_FIXTURE:dir,CANVAS_TLS_URL:fixture.url},stdio:['ignore','pipe','pipe'],
            });
            let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
            const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
            assert.equal(exit,0,`${runtime}: ${output}`);
        }
        assert.ok(fixture.requests.some(r=>r.url==='/upload'&&r.body.length===128*1024));
        assert.ok(fixture.requests.every(r=>/CN=(Canvas client|Other client|EC client)/.test(r.cn)));
    } finally {await fixture.close();rmSync(dir,{recursive:true,force:true});}
});
