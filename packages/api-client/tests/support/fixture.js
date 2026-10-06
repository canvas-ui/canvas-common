import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { once } from 'node:events';

export function certificates() {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-mtls-'));
    const openssl = args => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.crt','-days','2','-subj','/CN=Canvas test root']);
    for (const [name, subject, extensions, issuer] of [
        ['issuer','Canvas test issuer','basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign','root'],
        ['server','localhost','basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth','root'],
        ['client','Canvas client','basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth','issuer'],
        ['other','Other client','basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth','issuer'],
    ]) {
        openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=${subject}`]);
        writeFileSync(join(dir,`${name}.ext`),extensions);
        openssl(['x509','-req','-in',`${name}.csr`,'-CA',`${issuer}.crt`,'-CAkey',`${issuer}.key`,'-CAcreateserial','-days','1','-out',`${name}.crt`,'-extfile',`${name}.ext`]);
        chmodSync(join(dir,`${name}.key`),0o600);
    }
    openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','rogue.key','-out','rogue.crt','-days','1','-subj','/CN=Untrusted client']);
    openssl(['x509','-req','-in','client.csr','-CA','issuer.crt','-CAkey','issuer.key','-CAcreateserial','-days','0','-out','expired.crt','-extfile','client.ext']);
    openssl(['genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out','ec.key']);
    openssl(['req','-new','-key','ec.key','-out','ec.csr','-subj','/CN=EC client']);
    openssl(['x509','-req','-in','ec.csr','-CA','issuer.crt','-CAkey','issuer.key','-CAcreateserial','-days','1','-out','ec.crt','-extfile','client.ext']);
    openssl(['pkcs8','-topk8','-in','client.key','-out','encrypted.key','-passout','pass:test-only']);
    for (const name of ['client','other','ec']) writeFileSync(join(dir,`${name}.chain.crt`), readFileSync(join(dir,`${name}.crt`)) + readFileSync(join(dir,'issuer.crt')).toString());
    return dir;
}
const freePort = async () => { const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening'); const port = server.address().port; await new Promise(r => server.close(r)); return port; };
export async function nginxFixture(dir) {
    const requests = [];
    const upstream = createServer(async (req,res) => {
        const parts = []; for await (const part of req) parts.push(part);
        requests.push({ url:req.url, method:req.method, cn:req.headers['x-ssl-client-cn'], token:req.headers.authorization, body:Buffer.concat(parts).toString() });
        if (req.url === '/native-page') {
            res.setHeader('content-type','text/html');
            res.end(`<!doctype html><title>Canvas native TLS smoke test</title><script src="/socket.io/socket.io.js"></script><script>
            (async()=>{try {
                const login=await (await fetch('/rest/v2/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test@example.com',password:'test'})})).json();
                const token=login.payload.token;
                const result=await (await fetch('/rest/v2/ping',{headers:{Authorization:'Bearer '+token}})).json();
                if(!result.payload.cn.includes('Canvas client')||result.payload.token!=='Bearer '+token)throw Error('Identity or token missing');
                const upload=await (await fetch('/upload',{method:'PUT',body:new Uint8Array(131072)})).json();
                if(upload.payload.bytes!==131072)throw Error('Upload truncated');
                await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('GET','/xhr');xhr.onload=()=>xhr.status===200?resolve():reject(Error('XHR rejected'));xhr.onerror=reject;xhr.send();});
                const sock=io(location.origin,{transports:['websocket'],auth:{token},reconnection:false});
                await new Promise((resolve,reject)=>{sock.once('connect',resolve);sock.once('connect_error',reject);});
                const ack=await sock.timeout(5000).emitWithAck('echo','native');if(!ack.cn.includes('Canvas client'))throw Error('WS identity missing');sock.close();
                // The alternate hostname has no configured client identity.
                let rejected=false;try {await fetch(location.origin.replace('127.0.0.1','localhost')+'/no-identity');}catch{rejected=true;}
                if(!rejected)throw Error('Unconfigured origin received a certificate');
                await fetch('/native-result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ok:true})}); location.href='canvas-tls-result://complete';
            }catch(e){await fetch('/native-result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ok:false,error:String(e)})});location.href='canvas-tls-result://complete';}})();
            </script>`);return;
        }
        if (req.url === '/redirect') { res.writeHead(302,{location:'/rest/v2/ping'}); res.end(); return; }
        if (req.url === '/outside') { res.writeHead(302,{location:'https://localhost:1/private'}); res.end(); return; }
        if (req.url === '/rest/v2/auth/login') {
            res.setHeader('content-type','application/json'); res.end(JSON.stringify({status:'success',payload:{token:'canvas-test-token'}})); return;
        }
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({status:'success',payload:{cn:req.headers['x-ssl-client-cn'], token:req.headers.authorization || null, bytes:Buffer.concat(parts).length}}));
    });
    const socket = new Server(upstream,{transports:['websocket']});
    socket.use((client,next)=>next(client.handshake.auth.token === 'canvas-test-token' ? undefined : new Error('Canvas token required')));
    socket.on('connection', client => client.on('echo',(value,ack)=>ack({value,cn:client.handshake.headers['x-ssl-client-cn']})));
    upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
    const port = await freePort();
    const path = name => join(dir,name).replace(/\\/g,'/');
    writeFileSync(join(dir,'nginx.conf'),`pid "${path('nginx.pid')}";\nerror_log "${path('nginx.log')}";\nevents {}\nhttp { access_log off; client_body_temp_path "${path('body')}"; proxy_temp_path "${path('proxy')}"; map $http_upgrade $connection_upgrade { default upgrade; '' close; } server { listen 127.0.0.1:${port} ssl; ssl_certificate "${path('server.crt')}"; ssl_certificate_key "${path('server.key')}"; ssl_client_certificate "${path('root.crt')}"; ssl_verify_client on; ssl_verify_depth 2; location / { proxy_pass http://127.0.0.1:${upstream.address().port}; proxy_http_version 1.1; proxy_request_buffering off; proxy_buffering off; proxy_set_header X-SSL-Client-CN $ssl_client_s_dn; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; } } }`);
    const nginx = spawn('nginx',['-p',dir,'-c',join(dir,'nginx.conf'),'-g','daemon off;'],{stdio:['ignore','ignore','pipe']});
    let errors = ''; nginx.stderr.on('data',d=>errors+=d);
    for (let i=0;i<100;i++) {
        if (nginx.exitCode !== null) throw new Error(`nginx failed: ${errors}`);
        try { const response = await fetch(`http://127.0.0.1:${port}`); if(response.status) break; } catch { await new Promise(r=>setTimeout(r,20)); }
    }
    return {url:`https://127.0.0.1:${port}`, requests, close:async()=>{ nginx.kill('SIGTERM'); await once(nginx,'exit'); socket.disconnectSockets(true); upstream.closeAllConnections(); await new Promise(r=>socket.close(r)); }};
}
