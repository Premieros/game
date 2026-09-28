const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_RACERS = 10;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const WORLD_W = 1600;
const WORLD_H = 1000;
const TRACK_HALF_WIDTH = 135;

const waypoints = [
  [265, 480], [300, 300], [470, 195], [730, 155], [1045, 190],
  [1285, 320], [1350, 500], [1280, 695], [1050, 820], [760, 850],
  [480, 805], [300, 680]
];

const pickupSpawns = [
  [360, 285], [610, 165], [940, 178], [1230, 290], [1345, 520],
  [1200, 735], [900, 835], [590, 830], [350, 720], [260, 525]
];

const colors = ['#ff4d4d','#4da6ff','#ffd24d','#6be585','#c97bff','#ff8f4d','#4de1d2','#f04d9f','#b9e64d','#e6e6e6'];
const rooms = new Map();
let nextHumanId = 1;
let nextProjectileId = 1;
let quickRoomSeq = 1;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist2(ax, ay, bx, by) { const dx=ax-bx, dy=ay-by; return dx*dx+dy*dy; }
function angleDiff(a,b){ return ((b-a+Math.PI*3)%(Math.PI*2))-Math.PI; }
function normalizeRoom(raw) {
  const s = String(raw || 'QUICK').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return s || 'QUICK';
}
function randomPower(){ const r=Math.random(); return r<0.58?'rocket':r<0.82?'nitro':'shield'; }
function spawnForSlot(i) {
  const base = waypoints[0], next = waypoints[1];
  const ang = Math.atan2(next[1]-base[1], next[0]-base[0]);
  const row = Math.floor(i/2), side = i%2 ? 1 : -1;
  return {
    x: base[0] - Math.cos(ang)*row*46 + Math.cos(ang+Math.PI/2)*side*34,
    y: base[1] - Math.sin(ang)*row*46 + Math.sin(ang+Math.PI/2)*side*34,
    angle: ang
  };
}
function makeRacer(slot, bot=true) {
  const s = spawnForSlot(slot);
  return {
    slot, id: bot ? `bot-${slot}` : null, name: bot ? `BOT ${slot+1}` : '', bot,
    x:s.x, y:s.y, angle:s.angle, speed:0, lap:0, wp:1, score:0,
    finished:false, finishTime:null, item:null, shieldUntil:0, stunUntil:0, nitroUntil:0,
    color:colors[slot%colors.length], input:{throttle:false, brake:false, left:false, right:false, use:false},
    lastUse:false
  };
}
function createRoom(code) {
  const room = {
    code, racers:Array.from({length:MAX_RACERS},(_,i)=>makeRacer(i,true)),
    clients:new Map(), projectiles:[],
    pickups:pickupSpawns.map((p,i)=>({id:i,x:p[0],y:p[1],active:true,respawnAt:0})),
    startedAt:Date.now()
  };
  rooms.set(code, room);
  return room;
}
function chooseRoom(raw) {
  const requested=normalizeRoom(raw);
  if(requested!=='QUICK') return rooms.get(requested)||createRoom(requested);
  for(const room of rooms.values()){
    if(room.code.startsWith('QK') && room.clients.size<MAX_RACERS) return room;
  }
  return createRoom(`QK${String(quickRoomSeq++).padStart(4,'0')}`);
}
function resetRacer(r) {
  const s = spawnForSlot(r.slot);
  r.x=s.x; r.y=s.y; r.angle=s.angle; r.speed=0; r.lap=0; r.wp=1; r.score=0;
  r.finished=false; r.finishTime=null; r.item=null; r.shieldUntil=0; r.stunUntil=0; r.nitroUntil=0;
}
function replaceBotWithHuman(room, ws, name) {
  const slot = room.racers.findIndex(r=>r.bot);
  if (slot < 0) return null;
  const r=room.racers[slot];
  r.bot=false; r.id=`p${nextHumanId++}`; r.name=String(name||`Player ${slot+1}`).slice(0,16);
  r.input={throttle:false,brake:false,left:false,right:false,use:false}; r.lastUse=false;
  resetRacer(r);
  room.clients.set(ws, r.slot);
  return r;
}
function restoreBot(room, slot) {
  const old=room.racers[slot];
  const bot=makeRacer(slot,true);
  bot.x=old.x; bot.y=old.y; bot.angle=old.angle; bot.speed=old.speed; bot.lap=old.lap; bot.wp=old.wp;
  room.racers[slot]=bot;
}
function trackDistance(x,y) {
  let best=Infinity;
  for(let i=0;i<waypoints.length;i++){
    const a=waypoints[i], b=waypoints[(i+1)%waypoints.length];
    const vx=b[0]-a[0], vy=b[1]-a[1], wx=x-a[0], wy=y-a[1];
    const vv=vx*vx+vy*vy; const t=clamp((wx*vx+wy*vy)/vv,0,1);
    const px=a[0]+vx*t, py=a[1]+vy*t;
    best=Math.min(best, Math.hypot(x-px,y-py));
  }
  return best;
}
function aiInput(r, room) {
  const target=waypoints[r.wp%waypoints.length];
  const desired=Math.atan2(target[1]-r.y,target[0]-r.x);
  const d=angleDiff(r.angle,desired);
  r.input.left=d<-0.07; r.input.right=d>0.07; r.input.throttle=true;
  r.input.brake=Math.abs(d)>1.15 && r.speed>150;
  if(r.item==='rocket'){
    const ahead=room.racers.some(o=>o!==r && dist2(r.x,r.y,o.x,o.y)<340*340 &&
      Math.abs(angleDiff(r.angle,Math.atan2(o.y-r.y,o.x-r.x)))<0.7);
    r.input.use=ahead && Math.random()<0.18;
  } else if(r.item==='nitro') r.input.use=(Math.abs(d)<0.25 && Math.random()<0.06);
  else if(r.item==='shield') r.input.use=(room.projectiles.some(p=>p.owner!==r.slot && dist2(r.x,r.y,p.x,p.y)<260*260) && Math.random()<0.3);
}
function fireRocket(room,r,now){
  room.projectiles.push({id:nextProjectileId++,owner:r.slot,x:r.x+Math.cos(r.angle)*32,y:r.y+Math.sin(r.angle)*32,angle:r.angle,speed:520,expires:now+2600});
}
function useItem(room,r,now){
  if(!r.item) return;
  if(r.item==='rocket') fireRocket(room,r,now);
  if(r.item==='nitro') r.nitroUntil=now+1600;
  if(r.item==='shield') r.shieldUntil=now+2600;
  r.item=null;
}
function updateRacer(room,r,now){
  if(r.finished) return;
  if(r.bot) aiInput(r,room,now);
  const stunned=now<r.stunUntil;
  const onTrack=trackDistance(r.x,r.y)<=TRACK_HALF_WIDTH;
  const maxSpeed=(now<r.nitroUntil?410:300)*(onTrack?1:0.55);
  if(!stunned){
    if(r.input.throttle) r.speed+=280*DT; else r.speed-=80*DT;
    if(r.input.brake) r.speed-=360*DT;
    const steering=(0.95+Math.min(Math.abs(r.speed)/200,1.2))*2.0*DT;
    if(r.input.left) r.angle-=steering;
    if(r.input.right) r.angle+=steering;
  } else { r.angle += 4.8*DT; r.speed*=0.985; }
  if(now<r.nitroUntil) r.speed+=220*DT;
  r.speed=clamp(r.speed,-80,maxSpeed);
  r.speed*=0.992;
  r.x+=Math.cos(r.angle)*r.speed*DT;
  r.y+=Math.sin(r.angle)*r.speed*DT;
  r.x=clamp(r.x,30,WORLD_W-30); r.y=clamp(r.y,30,WORLD_H-30);

  if(r.input.use && !r.lastUse) useItem(room,r,now);
  r.lastUse=r.input.use;

  const wp=waypoints[r.wp%waypoints.length];
  if(dist2(r.x,r.y,wp[0],wp[1])<105*105){
    r.wp=(r.wp+1)%waypoints.length;
    if(r.wp===1){
      r.lap++;
      if(r.lap>=3){ r.finished=true; r.finishTime=now-room.startedAt; r.speed*=0.4; }
    }
  }

  if(!r.item){
    for(const p of room.pickups){
      if(p.active && dist2(r.x,r.y,p.x,p.y)<42*42){
        r.item=randomPower(); p.active=false; p.respawnAt=now+5000; break;
      }
    }
  }
}
function resolveCarCollisions(room){
  for(let i=0;i<room.racers.length;i++)for(let j=i+1;j<room.racers.length;j++){
    const a=room.racers[i],b=room.racers[j];if(a.finished||b.finished)continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);
    if(d>0&&d<35){
      const push=(35-d)/2,nx=dx/d,ny=dy/d;
      a.x-=nx*push;a.y-=ny*push;b.x+=nx*push;b.y+=ny*push;a.speed*=0.97;b.speed*=0.97;
    }
  }
}
function updateProjectiles(room,now){
  for(const p of room.projectiles){
    let best=null,bestD=550*550;
    for(const r of room.racers){
      if(r.slot===p.owner||r.finished) continue;
      const d=dist2(p.x,p.y,r.x,r.y);
      if(d<bestD){
        const ad=Math.abs(angleDiff(p.angle,Math.atan2(r.y-p.y,r.x-p.x)));
        if(ad<0.9){best=r;bestD=d;}
      }
    }
    if(best){
      const desired=Math.atan2(best.y-p.y,best.x-p.x);
      p.angle+=clamp(angleDiff(p.angle,desired),-1.8*DT,1.8*DT);
    }
    p.x+=Math.cos(p.angle)*p.speed*DT; p.y+=Math.sin(p.angle)*p.speed*DT;
    for(const r of room.racers){
      if(r.slot===p.owner||r.finished) continue;
      if(dist2(p.x,p.y,r.x,r.y)<30*30){
        if(now<r.shieldUntil) r.shieldUntil=0;
        else { r.stunUntil=now+900; r.speed*=0.45; }
        p.expires=0; break;
      }
    }
  }
  room.projectiles=room.projectiles.filter(p=>p.expires>now && p.x>-50&&p.x<WORLD_W+50&&p.y>-50&&p.y<WORLD_H+50);
}
function raceProgress(r){
  const target=waypoints[r.wp%waypoints.length];
  const prev=waypoints[(r.wp-1+waypoints.length)%waypoints.length];
  const seg=Math.hypot(target[0]-prev[0],target[1]-prev[1]);
  const remaining=Math.hypot(target[0]-r.x,target[1]-r.y);
  const frac=clamp(1-remaining/Math.max(seg,1),0,1);
  return r.lap*waypoints.length + ((r.wp-1+waypoints.length)%waypoints.length)+frac;
}
function snapshot(room,now){
  const order=[...room.racers].sort((a,b)=>{
    if(a.finished&&b.finished) return a.finishTime-b.finishTime;
    if(a.finished) return -1; if(b.finished) return 1;
    return raceProgress(b)-raceProgress(a);
  });
  const rank=new Map(order.map((r,i)=>[r.slot,i+1]));
  return {
    type:'state', now, room:room.code,
    world:{w:WORLD_W,h:WORLD_H,trackHalf:TRACK_HALF_WIDTH,waypoints,pickupSpawns},
    racers:room.racers.map(r=>({
      slot:r.slot,id:r.id,name:r.name,bot:r.bot,x:r.x,y:r.y,angle:r.angle,speed:r.speed,
      lap:r.lap,wp:r.wp,item:r.item,shield:now<r.shieldUntil,stunned:now<r.stunUntil,
      nitro:now<r.nitroUntil,color:r.color,finished:r.finished,finishTime:r.finishTime,rank:rank.get(r.slot)
    })),
    projectiles:room.projectiles.map(p=>({id:p.id,owner:p.owner,x:p.x,y:p.y,angle:p.angle})),
    pickups:room.pickups.map(p=>({id:p.id,x:p.x,y:p.y,active:p.active}))
  };
}
function tick(){
  const now=Date.now();
  for(const [code,room] of rooms){
    for(const p of room.pickups) if(!p.active&&now>=p.respawnAt) p.active=true;
    for(const r of room.racers) updateRacer(room,r,now);
    resolveCarCollisions(room);
    updateProjectiles(room,now);
    if(room.clients.size){
      const msg=JSON.stringify(snapshot(room,now));
      for(const client of room.clients.keys()) if(!client.closed) client.send(msg);
    } else if(now-room.startedAt>60000){ rooms.delete(code); }
  }
}
setInterval(tick,1000/TICK_RATE);

function mime(file){
  const ext=path.extname(file).toLowerCase();
  return ({
    '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml',
    '.json':'application/json; charset=utf-8'
  })[ext]||'application/octet-stream';
}
const server=http.createServer((req,res)=>{
  if(req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,rooms:rooms.size}));
  }
  let reqPath=decodeURIComponent(req.url.split('?')[0]);
  if(reqPath==='/') reqPath='/index.html';
  const file=path.normalize(path.join(PUBLIC,reqPath));
  if(!file.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');}
    else {res.writeHead(200,{'Content-Type':mime(file),'Cache-Control':'no-store'});res.end(data);}
  });
});
function wsFrame(text){
  const payload=Buffer.from(text);
  let head;
  if(payload.length<126){head=Buffer.alloc(2);head[0]=0x81;head[1]=payload.length;}
  else if(payload.length<65536){head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(payload.length,2);}
  else {head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2);}
  return Buffer.concat([head,payload]);
}
function makeClient(socket){
  return {
    socket,closed:false,buffer:Buffer.alloc(0),
    send(text){if(!this.closed)socket.write(wsFrame(text));},
    close(){this.closed=true;try{socket.end();}catch{}}
  };
}
function parseWsFrames(client,chunk,onText){
  client.buffer=Buffer.concat([client.buffer,chunk]);
  while(client.buffer.length>=2){
    const b0=client.buffer[0], b1=client.buffer[1];
    const opcode=b0&0x0f; const masked=!!(b1&0x80); let len=b1&0x7f; let off=2;
    if(len===126){if(client.buffer.length<4)return;len=client.buffer.readUInt16BE(2);off=4;}
    else if(len===127){
      if(client.buffer.length<10)return;
      const big=client.buffer.readBigUInt64BE(2);
      if(big>BigInt(1e7)){client.close();return;}
      len=Number(big);off=10;
    }
    const maskLen=masked?4:0;
    if(client.buffer.length<off+maskLen+len)return;
    let payload=client.buffer.subarray(off+maskLen,off+maskLen+len);
    if(masked){
      const mask=client.buffer.subarray(off,off+4);const out=Buffer.alloc(len);
      for(let i=0;i<len;i++)out[i]=payload[i]^mask[i%4];
      payload=out;
    }
    client.buffer=client.buffer.subarray(off+maskLen+len);
    if(opcode===0x8){client.close();return;}
    if(opcode===0x9){
      const pong=Buffer.from(wsFrame(payload.toString()));pong[0]=0x8A;client.socket.write(pong);continue;
    }
    if(opcode===0x1)onText(payload.toString('utf8'));
  }
}
server.on('upgrade',(req,socket)=>{
  if(req.url!=='/ws'){socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const client=makeClient(socket);let joinedRoom=null;
  function handleMessage(text){
    let m;try{m=JSON.parse(text);}catch{return;}
    if(m.type==='join'){
      const room=chooseRoom(m.room);
      const racer=replaceBotWithHuman(room,client,m.name);
      if(!racer){client.send(JSON.stringify({type:'error',message:'الغرفة ممتلئة'}));return;}
      joinedRoom=room;
      client.send(JSON.stringify({type:'joined',slot:racer.slot,id:racer.id,room:room.code,max:MAX_RACERS}));
    } else if(m.type==='input'&&joinedRoom){
      const slot=joinedRoom.clients.get(client);const r=joinedRoom.racers[slot];
      if(r&&!r.bot){
        r.input.throttle=!!m.throttle;r.input.brake=!!m.brake;
        r.input.left=!!m.left;r.input.right=!!m.right;r.input.use=!!m.use;
      }
    }
  }
  socket.on('data',chunk=>parseWsFrames(client,chunk,handleMessage));
  const cleanup=()=>{
    if(client.closed)return;
    client.closed=true;
    if(joinedRoom){
      const slot=joinedRoom.clients.get(client);
      joinedRoom.clients.delete(client);
      if(slot!==undefined)restoreBot(joinedRoom,slot);
    }
  };
  socket.on('close',cleanup);socket.on('end',cleanup);socket.on('error',cleanup);
});
server.listen(PORT,()=>console.log(`BlastKart running on http://localhost:${PORT}`));
