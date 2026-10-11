const http=require('http'),fs=require('fs'),path=require('path');
const DB=path.join(__dirname,'signups.csv'),html=fs.readFileSync(path.join(__dirname,'index.html'));
if(!fs.existsSync(DB))fs.writeFileSync(DB,'email,signed_up_at\n');
http.createServer((q,s)=>{
 if(q.method==='POST'&&q.url==='/api/subscribe'){let b='';q.on('data',c=>{b+=c;if(b.length>2000)q.destroy()});q.on('end',()=>{let e='';try{e=String(JSON.parse(b).email||'').trim().toLowerCase()}catch{}
  if(!/^[^\s@,"]+@[^\s@,"]+\.[^\s@,"]+$/.test(e)||e.length>254){s.writeHead(400,{'Content-Type':'application/json'});return s.end('{"error":"Please enter a valid email."}')}
  fs.appendFileSync(DB,`${e},${new Date().toISOString()}\n`);s.writeHead(200,{'Content-Type':'application/json'});s.end('{"ok":true}')});return}
 if(q.method==='GET'&&q.url==='/api/count'){const n=fs.readFileSync(DB,'utf8').trim().split('\n').length-1;s.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return s.end(JSON.stringify({count:n}))}
 if(q.method==='GET'&&(q.url==='/'||q.url.startsWith('/?'))){s.writeHead(200,{'Content-Type':'text/html'});return s.end(html)}
 s.writeHead(404);s.end('not found')}).listen(8787,'127.0.0.1');
