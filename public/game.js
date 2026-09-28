const canvas = document.getElementById('game');
const menu = document.getElementById('menu'), hud = document.getElementById('hud'), mobile = document.getElementById('mobile');
const rankEl = document.getElementById('rank'), lapEl = document.getElementById('lap'), itemEl = document.getElementById('item'), roomLabel = document.getElementById('roomLabel'), leaderboard = document.getElementById('leaderboard');
const nameEl = document.getElementById('name'), roomEl = document.getElementById('room'), privateBox = document.getElementById('privateBox'), toast = document.getElementById('toast');

let ws = null, mySlot = null, state = null, joined = false;
const input = { throttle:false, brake:false, left:false, right:false, use:false };
let lastInput = '';

// ---------- WebGL setup ----------
const gl = canvas.getContext('webgl', { antialias:true, alpha:false, premultipliedAlpha:false });
if (!gl) {
  document.body.innerHTML = '<div style="padding:40px;color:white;font-family:system-ui">متصفحك لا يدعم WebGL. افتح اللعبة بآخر إصدار من Chrome أو Edge.</div>';
  throw new Error('WebGL unavailable');
}

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main(){
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  gl_Position = uProj * uView * world;
}`;
const FS = `
precision mediump float;
uniform vec4 uColor;
uniform vec3 uCamPos;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main(){
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(-0.45, 0.95, 0.35));
  float diffuse = max(dot(N, L), 0.0);
  float light = 0.42 + diffuse * 0.70;
  vec3 col = uColor.rgb * light;
  float d = distance(uCamPos, vWorldPos);
  float fog = smoothstep(720.0, 1550.0, d);
  vec3 sky = vec3(0.62, 0.83, 0.96);
  gl_FragColor = vec4(mix(col, sky, fog), uColor.a);
}`;

function compile(type, src){
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(program);
if(!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);

const loc = {
  pos: gl.getAttribLocation(program, 'aPos'),
  normal: gl.getAttribLocation(program, 'aNormal'),
  proj: gl.getUniformLocation(program, 'uProj'),
  view: gl.getUniformLocation(program, 'uView'),
  model: gl.getUniformLocation(program, 'uModel'),
  color: gl.getUniformLocation(program, 'uColor'),
  cam: gl.getUniformLocation(program, 'uCamPos')
};

gl.enable(gl.DEPTH_TEST);
gl.enable(gl.CULL_FACE);
gl.cullFace(gl.BACK);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(0.62, 0.83, 0.96, 1);

function makeMesh(pos, normals, indices){
  const mesh = { count:indices.length };
  mesh.pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
  mesh.nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  mesh.ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  return mesh;
}

// Unit cube centered at origin.
const cubePos = [
  // front (+z)
  -.5,-.5,.5,  .5,-.5,.5,  .5,.5,.5,  -.5,.5,.5,
  // back (-z)
  .5,-.5,-.5, -.5,-.5,-.5, -.5,.5,-.5, .5,.5,-.5,
  // right (+x)
  .5,-.5,.5, .5,-.5,-.5, .5,.5,-.5, .5,.5,.5,
  // left (-x)
  -.5,-.5,-.5, -.5,-.5,.5, -.5,.5,.5, -.5,.5,-.5,
  // top
  -.5,.5,.5, .5,.5,.5, .5,.5,-.5, -.5,.5,-.5,
  // bottom
  -.5,-.5,-.5, .5,-.5,-.5, .5,-.5,.5, -.5,-.5,.5
];
const cubeNorm = [
  0,0,1,0,0,1,0,0,1,0,0,1,
  0,0,-1,0,0,-1,0,0,-1,0,0,-1,
  1,0,0,1,0,0,1,0,0,1,0,0,
  -1,0,0,-1,0,0,-1,0,0,-1,0,0,
  0,1,0,0,1,0,0,1,0,0,1,0,
  0,-1,0,0,-1,0,0,-1,0,0,-1,0
];
const cubeIdx=[]; for(let f=0;f<6;f++){const o=f*4;cubeIdx.push(o,o+1,o+2,o,o+2,o+3)}
const cubeMesh = makeMesh(cubePos, cubeNorm, cubeIdx);

function hexToColor(hex, alpha=1){
  const h = (hex||'#ffffff').replace('#','');
  const n = parseInt(h.length===3 ? h.split('').map(c=>c+c).join('') : h, 16);
  return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255, alpha];
}
function shade(hex, f){ const c=hexToColor(hex); return [Math.min(1,c[0]*f),Math.min(1,c[1]*f),Math.min(1,c[2]*f),1]; }

// ---------- matrix helpers (column-major) ----------
function perspective(fovy, aspect, near, far){
  const f = 1/Math.tan(fovy/2), nf=1/(near-far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
function normalize3(v){ const l=Math.hypot(v[0],v[1],v[2])||1; return [v[0]/l,v[1]/l,v[2]/l]; }
function cross(a,b){ return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function lookAt(eye, target, up=[0,1,0]){
  const z=normalize3([eye[0]-target[0],eye[1]-target[1],eye[2]-target[2]]);
  const x=normalize3(cross(up,z)); const y=cross(z,x);
  return new Float32Array([
    x[0],y[0],z[0],0,
    x[1],y[1],z[1],0,
    x[2],y[2],z[2],0,
    -dot(x,eye),-dot(y,eye),-dot(z,eye),1
  ]);
}
function trs(tx,ty,tz, ry=0, sx=1,sy=1,sz=1){
  const c=Math.cos(ry), s=Math.sin(ry);
  return new Float32Array([
    c*sx,0,-s*sx,0,
    0,sy,0,0,
    s*sz,0,c*sz,0,
    tx,ty,tz,1
  ]);
}
function drawMesh(mesh, model, color){
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pb); gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos,3,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nb); gl.enableVertexAttribArray(loc.normal); gl.vertexAttribPointer(loc.normal,3,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
  gl.uniformMatrix4fv(loc.model,false,model); gl.uniform4fv(loc.color,color);
  gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);
}
function box(x,y,z,sx,sy,sz,ry,color){ drawMesh(cubeMesh,trs(x,y,z,ry,sx,sy,sz),color); }

let trackMesh = null, trackKey = '';
function buildStrip(points, halfWidth){
  const pos=[], normals=[], idx=[];
  const n=points.length;
  for(let i=0;i<n;i++){
    const prev=points[(i-1+n)%n], next=points[(i+1)%n];
    const tx=next[0]-prev[0], tz=next[1]-prev[1]; const l=Math.hypot(tx,tz)||1;
    const nx=-tz/l, nz=tx/l;
    pos.push(points[i][0]+nx*halfWidth,0.15,points[i][1]+nz*halfWidth);
    pos.push(points[i][0]-nx*halfWidth,0.15,points[i][1]-nz*halfWidth);
    normals.push(0,1,0,0,1,0);
  }
  for(let i=0;i<n;i++){ const a=i*2,b=i*2+1,c=((i+1)%n)*2,d=((i+1)%n)*2+1; idx.push(a,b,c,b,d,c); }
  return makeMesh(pos,normals,idx);
}

const propTrees = [
  [120,110],[245,120],[415,85],[620,70],[860,70],[1110,95],[1430,145],
  [1490,340],[1510,600],[1430,850],[1220,930],[960,950],[690,950],[410,930],[140,850],[95,650],[90,360],
  [520,430],[790,420],[1050,465],[920,650],[610,650]
];
const rocks = [[180,230],[1450,250],[1380,760],[1120,930],[360,910],[150,730],[760,80],[1180,120]];

function drawTrack(world){
  const key=JSON.stringify(world.waypoints)+world.trackHalf;
  if(!trackMesh || key!==trackKey){ trackMesh=buildStrip(world.waypoints,world.trackHalf); trackKey=key; }
  // grass base
  box(world.w/2,-6,world.h/2,world.w+500,12,world.h+500,0,[0.12,0.42,0.20,1]);
  // road strip
  drawMesh(trackMesh,trs(0,0,0),[0.19,0.22,0.25,1]);

  // curb blocks along both sides
  const pts=world.waypoints;
  for(let i=0;i<pts.length;i++){
    const a=pts[i], b=pts[(i+1)%pts.length];
    const dx=b[0]-a[0], dz=b[1]-a[1], len=Math.hypot(dx,dz), ang=Math.atan2(dz,dx);
    const nx=-dz/len,nz=dx/len; const step=54;
    for(let d=0, j=0; d<len; d+=step,j++){
      const t=(d+step*.5)/len; if(t>1) break;
      const cx=a[0]+dx*t, cz=a[1]+dz*t;
      const col=(j+i)%2 ? [0.93,0.12,0.10,1] : [0.96,0.96,0.93,1];
      box(cx+nx*(world.trackHalf+6),2.1,cz+nz*(world.trackHalf+6),Math.min(step-4,len-d),4,12,-ang,col);
      box(cx-nx*(world.trackHalf+6),2.1,cz-nz*(world.trackHalf+6),Math.min(step-4,len-d),4,12,-ang,col);
    }
  }

  // Start/finish checker stripe
  const a=pts[0], b=pts[1], ang=Math.atan2(b[1]-a[1],b[0]-a[0]);
  const nx=-Math.sin(ang), nz=Math.cos(ang);
  for(let k=-5;k<=5;k++){
    const col=(k&1)?[0.04,0.04,0.05,1]:[0.96,0.96,0.96,1];
    box(a[0]+nx*k*23,1.2,a[1]+nz*k*23,18,2.5,23,-ang,col);
  }

  // scenery
  for(const [x,z] of propTrees){
    box(x,22,z,12,44,12,0,[0.37,0.20,0.08,1]);
    box(x,58,z,42,42,42,.25,[0.10,0.48,0.17,1]);
    box(x+14,72,z-6,28,28,28,-.35,[0.16,0.60,0.23,1]);
  }
  for(const [x,z] of rocks){ box(x,10,z,34,22,30,.35,[0.40,0.39,0.37,1]); }

  // distant blocky cliffs for depth
  const cliffs=[[40,120,80,140],[1550,160,110,180],[1510,900,130,210],[80,930,100,170],[800,-80,150,110]];
  for(const [x,z,h,w] of cliffs){
    box(x,h/2-1,z,w,h,90,.15,[0.43,0.32,0.20,1]);
    box(x,h+18,z,w*.55,38,75,-.18,[0.23,0.49,0.20,1]);
  }
}

function drawKart(r, me){
  const x=r.x,z=r.y, yaw=-r.angle;
  const color=hexToColor(r.color||'#ff5533');
  const dark=shade(r.color||'#ff5533',.62);
  // shadow
  box(x,1.1,z,46,.8,30,yaw,[0,0,0,.28]);
  // main chassis
  box(x,12,z,46,13,28,yaw,color);
  box(x+Math.cos(r.angle)*9,21,z+Math.sin(r.angle)*9,24,15,20,yaw,dark);
  // nose
  box(x+Math.cos(r.angle)*24,10,z+Math.sin(r.angle)*24,18,8,22,yaw,color);
  // spoiler
  box(x-Math.cos(r.angle)*25,24,z-Math.sin(r.angle)*25,8,5,36,yaw,dark);
  // seat / driver helmet
  box(x-Math.cos(r.angle)*2,32,z-Math.sin(r.angle)*2,15,14,15,yaw,[0.95,0.78,0.28,1]);
  box(x+Math.cos(r.angle)*5,40,z+Math.sin(r.angle)*5,13,13,13,yaw,[0.98,0.58,0.18,1]);
  // wheels
  const fx=Math.cos(r.angle), fz=Math.sin(r.angle), rx=-fz, rz=fx;
  for(const f of [-15,17]) for(const side of [-1,1]){
    box(x+fx*f+rx*18*side,8,z+fz*f+rz*18*side,11,12,8,yaw,[0.035,0.04,0.045,1]);
  }
  if(r.nitro){
    for(const side of [-1,1]) box(x-fx*34+rx*7*side,9,z-fz*34+rz*7*side,16,5,5,yaw,[0.15,0.78,1,0.9]);
  }
  if(r.shield){
    // translucent protective box/shell
    box(x,23,z,62,50,46,yaw,[0.20,0.72,1,0.18]);
  }
  if(r.stunned){
    box(x,54,z,28,3,28,performance.now()/220,[1,0.75,0.08,.85]);
  }
  if(me){
    // small white antenna marker to make your kart obvious
    box(x,56,z,3,20,3,0,[1,1,1,.9]);
  }
}

function drawPickup(p){
  if(!p.active)return;
  const t=performance.now()/750; const y=18+Math.sin(t+p.id)*5;
  box(p.x,y,p.y,24,24,24,t,[1.0,0.67,0.05,1]);
  box(p.x,y,p.y,28,4,28,-t,[1,0.95,0.36,.45]);
}
function drawRocket(p){
  const yaw=-p.angle, fx=Math.cos(p.angle),fz=Math.sin(p.angle);
  box(p.x,14,p.y,30,8,8,yaw,[0.94,0.08,0.08,1]);
  box(p.x-fx*18,14,p.y-fz*18,12,5,5,yaw,[1,0.65,0.05,.9]);
}

function fit(){
  const dpr=Math.min(devicePixelRatio||1,1.75);
  const w=Math.max(1,Math.floor(innerWidth*dpr)), h=Math.max(1,Math.floor(innerHeight*dpr));
  if(canvas.width!==w||canvas.height!==h){ canvas.width=w;canvas.height=h; }
  gl.viewport(0,0,w,h);
}
addEventListener('resize',fit); fit();

// ---------- UI/network ----------
function showToast(t){toast.textContent=t;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1500)}
function connect(room){
  if(ws)try{ws.close()}catch{}
  const proto=location.protocol==='https:'?'wss':'ws'; ws=new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen=()=>ws.send(JSON.stringify({type:'join',room,name:nameEl.value||'Player'}));
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='joined'){mySlot=m.slot;joined=true;menu.classList.add('hidden');hud.classList.remove('hidden');mobile.classList.remove('hidden');roomLabel.textContent=`Room ${m.room}`;showToast('3D Race! الأماكن الفارغة Bots');}else if(m.type==='state'){state=m;}else if(m.type==='error'){showToast(m.message)}};
  ws.onclose=()=>{if(joined){joined=false;showToast('انقطع الاتصال — أعد تحميل الصفحة')}};
}
document.getElementById('solo').onclick=()=>connect('SOLO'+Math.random().toString(36).slice(2,8).toUpperCase());
document.getElementById('quick').onclick=()=>connect('QUICK');
document.getElementById('private').onclick=()=>privateBox.classList.toggle('hidden');
document.getElementById('joinRoom').onclick=()=>connect(roomEl.value||Math.random().toString(36).slice(2,7).toUpperCase());
function setKey(k,v){
  if(k==='ArrowUp'||k==='KeyW')input.throttle=v;
  if(k==='ArrowDown'||k==='KeyS')input.brake=v;
  if(k==='ArrowLeft'||k==='KeyA')input.left=v;
  if(k==='ArrowRight'||k==='KeyD')input.right=v;
  if(k==='Space')input.use=v;
}
addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();setKey(e.code,true)});
addEventListener('keyup',e=>setKey(e.code,false));
document.querySelectorAll('#mobile button').forEach(b=>{const k=b.dataset.key;b.addEventListener('pointerdown',e=>{e.preventDefault();input[k]=true});for(const ev of ['pointerup','pointercancel','pointerleave'])b.addEventListener(ev,e=>{e.preventDefault();input[k]=false})});
setInterval(()=>{if(ws&&ws.readyState===1&&joined){const s=JSON.stringify(input);if(s!==lastInput||input.use){ws.send(JSON.stringify({type:'input',...input}));lastInput=s}}},40);

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function updateHud(me){
  rankEl.textContent=`${me.rank}/10`;lapEl.textContent=`لفة ${Math.min(me.lap+1,3)}/3`;
  const labels={rocket:'🚀 صاروخ',nitro:'⚡ نيترو',shield:'🛡️ درع'};itemEl.textContent=me.item?labels[me.item]:'التقط صندوق سلاح';
  leaderboard.innerHTML=[...state.racers].sort((a,b)=>a.rank-b.rank).slice(0,6).map(r=>`<div class="lead ${r.slot===mySlot?'me':''} ${r.bot?'bot':''}"><span>${r.rank}. ${escapeHtml(r.name)}${r.bot?' 🤖':''}</span><span>${r.finished?'🏁':`L${Math.min(r.lap+1,3)}`}</span></div>`).join('');
}

const cam={x:0,y:95,z:0,ready:false};
function render(){
  requestAnimationFrame(render); fit();
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  if(!state)return;
  const me=state.racers.find(r=>r.slot===mySlot); if(!me)return;
  updateHud(me);

  const fx=Math.cos(me.angle),fz=Math.sin(me.angle);
  const desired={x:me.x-fx*145,y:92,z:me.y-fz*145};
  if(!cam.ready){Object.assign(cam,desired,{ready:true});}
  cam.x+=(desired.x-cam.x)*.10; cam.y+=(desired.y-cam.y)*.10; cam.z+=(desired.z-cam.z)*.10;
  const target=[me.x+fx*50,18,me.y+fz*50];
  const proj=perspective(Math.PI/3,canvas.width/canvas.height,.5,2200);
  const view=lookAt([cam.x,cam.y,cam.z],target,[0,1,0]);
  gl.uniformMatrix4fv(loc.proj,false,proj);gl.uniformMatrix4fv(loc.view,false,view);gl.uniform3f(loc.cam,cam.x,cam.y,cam.z);

  drawTrack(state.world);
  state.pickups.forEach(drawPickup);
  state.projectiles.forEach(drawRocket);
  // Draw cars furthest first isn't required with depth buffer, but transparent shield is nicer last.
  state.racers.forEach(r=>drawKart(r,r.slot===mySlot));

  if(me.finished && !document.getElementById('finishCard')){
    const card=document.createElement('div');card.id='finishCard';card.className='finishCard';card.innerHTML=`<b>🏁 المركز ${me.rank}</b><span>انتهى السباق</span>`;document.body.appendChild(card);
  }
}
render();

// Demo shortcut for screenshots/tests.
const qp=new URLSearchParams(location.search);if(qp.get('auto')==='1'){if(qp.get('name'))nameEl.value=qp.get('name');setTimeout(()=>connect(qp.get('room')||'DEMO'),120)}
