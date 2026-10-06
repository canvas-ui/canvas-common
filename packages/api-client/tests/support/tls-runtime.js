import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { createTlsTransport, loadTls, normalizeTls, resolveTls } from '../../src/tls.js';
import { CanvasApiClient } from '../../src/client.js';
const dir = process.env.CANVAS_TLS_FIXTURE;
const url = process.env.CANVAS_TLS_URL;
const files = {certFile:join(dir,'client.chain.crt'),keyFile:join(dir,'client.key')};
assert.throws(()=>normalizeTls({certFile:files.certFile}),/both/);
assert.throws(()=>resolveTls(files,{CANVAS_TLS_KEY:files.keyFile}),/both/);
assert.throws(()=>loadTls(url,{...files,certFile:join(dir,'expired.crt')}),/expired/);
assert.throws(()=>loadTls('http://example.com',files),/HTTPS/);
assert.throws(()=>loadTls(url,{...files,keyFile:join(dir,'other.key')}),/do not match/);
assert.throws(()=>loadTls(url,{...files,keyFile:join(dir,'encrypted.key')}),/Encrypted/);
assert.throws(()=>loadTls(url,{...files,certFile:join(dir,'missing.crt')}),/Cannot load/);
writeFileSync(join(dir,'broken.crt'),'bad certificate');
assert.throws(()=>loadTls(url,{...files,certFile:join(dir,'broken.crt')}),/PEM/);
const transport = createTlsTransport(url,files);
if(process.env.CANVAS_TLS_EXPECT_UNTRUSTED) {
    try { await assert.rejects(transport.fetch(`${url}/rest/v2/ping`)); } finally { await transport.dispose(); }
    console.log('Untrusted server rejected');process.exit(0);
}
const client = new CanvasApiClient({baseUrl:url,fetch:transport.fetch});
try {
    const login = await client.auth.login({email:'test@example.com',password:'test'});
    assert.equal(login.token,'canvas-test-token');
    const reply = await client.get('/ping',{headers:{Authorization:`Bearer ${login.token}`}});
    assert.match(reply.cn,/CN=Canvas client/); assert.equal(reply.token,'Bearer canvas-test-token');
    const redirected = await transport.fetch(`${url}/redirect`); assert.equal(redirected.status,200);
    await assert.rejects(transport.fetch(`${url}/outside`),/cross-origin/);
    await assert.rejects(transport.fetch('https://localhost:1/private'),/different origin/);
    const rogue=createTlsTransport(url,{certFile:join(dir,'rogue.crt'),keyFile:join(dir,'rogue.key')});
    try {assert.equal((await rogue.fetch(`${url}/rest/v2/ping`)).status,400);}finally{await rogue.dispose();}
    const abort=new AbortController();abort.abort();await assert.rejects(transport.fetch(`${url}/rest/v2/ping`,{signal:abort.signal}));
    const missing = await fetch(`${url}/rest/v2/ping`); assert.equal(missing.status,400);
    const socket = io(url,{...transport.socketOptions,auth:{token:login.token},transports:transport.socketOptions.transports,reconnection:false});
    try {
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Socket handshake timed out')),5000);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('connect_error',e=>{clearTimeout(timer);reject(e);});});
        const ack = await socket.timeout(5000).emitWithAck('echo','test');
        assert.equal(ack.value,'test'); assert.match(ack.cn,/CN=Canvas client/);
    } finally {socket.close();}
    const upload = new ReadableStream({start(c){c.enqueue(new Uint8Array(128*1024));c.close();}});
    const body = await (await transport.fetch(`${url}/upload`,{method:'PUT',body:upload,duplex:'half'})).json();
    assert.equal(body.payload.bytes,128*1024);
    const other = createTlsTransport(url,{certFile:join(dir,'other.chain.crt'),keyFile:join(dir,'other.key')});
    try {const r=await (await other.fetch(`${url}/rest/v2/ping`)).json();assert.match(r.payload.cn,/CN=Other client/);} finally {await other.dispose();}
    const ec = createTlsTransport(url,{certFile:join(dir,'ec.chain.crt'),keyFile:join(dir,'ec.key')});
    try {const r=await (await ec.fetch(`${url}/rest/v2/ping`)).json();assert.match(r.payload.cn,/CN=EC client/);} finally {await ec.dispose();}
    console.log('TLS runtime passed: validation, login, token, streaming, redirects, isolated identities, Socket.IO');
} finally {await transport.dispose();}
await assert.rejects(transport.fetch(`${url}/rest/v2/ping`),/closed/);
