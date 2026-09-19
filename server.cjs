const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.PORT || 4178);
const HOST = process.env.RENDER || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
const publicHost = process.env.RENDER_EXTERNAL_HOSTNAME || '';
const LIMIT = 10 * 1024 * 1024;

function publicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) ||
    (a===172&&b>=16&&b<=31) || (a===192&&(b===168||b===0)) ||
    (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)));
}

async function retrieve(raw, signal, redirects=0) {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80','443'].includes(url.port))) throw Error('公開されている http / https の画像URLを指定してください。');
  const addresses = await dns.lookup(url.hostname,{all:true,family:4});
  if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw Error('公開されている画像URLを指定してください。');
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).get(url,{
      signal,
      lookup:(_host,options,cb)=>options.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4),
      headers:{'User-Agent':'Mozilla/5.0 OripaPOPStudio/1.0','Accept':'image/png,image/jpeg,image/webp','Referer':url.origin+'/'},
    },res=>{
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (redirects>=4 || !res.headers.location) return reject(Error('画像URLの転送が多すぎます。'));
        try {resolve(retrieve(new URL(res.headers.location,url).href,signal,redirects+1));} catch(error) {reject(error);}return;
      }
      if (res.statusCode!==200) {res.resume();return reject(Error('配信元から画像を取得できませんでした（HTTP '+res.statusCode+'）。'));}
      const type=(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if (!['image/png','image/jpeg','image/webp','application/octet-stream'].includes(type)) {
        res.resume();return reject(Error('画像そのもののURLを指定してください。対応形式はPNG・JPEG・WebPです。'));
      }
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>LIMIT){reject(Error('画像は10MB以下にしてください。'));res.destroy();}else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{
        const data=Buffer.concat(chunks);
        const mime=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
          data[0]===255&&data[1]===216&&data[2]===255?'image/jpeg':
          data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'?'image/webp':null;
        if(!mime)return reject(Error('PNG・JPEG・WebPの画像URLを指定してください。'));
        resolve({data,mime});
      });
    });
    request.on('error',reject);
  });
}

function createServer() {
  let activeDownloads = 0;
  return http.createServer(async(req,res)=>{
    const hosts=['127.0.0.1:'+PORT,'localhost:'+PORT,publicHost].filter(Boolean);
    if (req.url!=='/health' && !hosts.includes(req.headers.host)) {res.writeHead(403);res.end();return;}
    const origin=req.headers.origin;
    const origins=['http://127.0.0.1:'+PORT,'http://localhost:'+PORT,...(publicHost?['https://'+publicHost]:['null'])];
    if (origin && !origins.includes(origin)) {res.writeHead(403);res.end();return;}
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET');res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);res.end();return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    const url=new URL(req.url,'http://127.0.0.1:'+PORT);
    if(url.pathname==='/api/image'){
      if(activeDownloads>=6){res.writeHead(429,{'Content-Type':'application/json; charset=utf-8','Retry-After':'5'});res.end(JSON.stringify({error:'画像取得が混み合っています。少し待ってから再試行してください。'}));return;}
      activeDownloads++;
      try {
        const result=await retrieve(url.searchParams.get('url'),AbortSignal.timeout(20000));
        res.writeHead(200,{'Content-Type':result.mime});res.end(result.data);
      } catch(error) {
        res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({error:error.name==='AbortError'||error.name==='TimeoutError'?'画像の取得がタイムアウトしました。':error.message}));
      } finally {activeDownloads--;}
    } else if(url.pathname==='/health'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
    } else if(url.pathname==='/'||url.pathname==='/index.html'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);
    } else {res.writeHead(404);res.end();}
  });
}
if(require.main===module)createServer().listen(PORT,HOST,()=>console.log('Oripa POP Studio listening on '+HOST+':'+PORT));
module.exports={createServer,publicAddress,retrieve};
