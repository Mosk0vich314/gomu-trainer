// Lift models adapted from the supplied Big Three Technique Manual.
// DOM access is scoped to the guide; stop all players when it closes or changes section.
export function initTechniqueModels(root) {

const $=id=>root.getElementById(id);
const players = [];
const rad=d=>d*Math.PI/180, deg=r=>r*180/Math.PI, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), r0=v=>Math.round(v);
const ease=x=>x<.5?2*x*x:1-Math.pow(-2*x+2,2)/2;
function mkMap(xmin,ymax,S){return (x,y)=>[((x-xmin)*S).toFixed(1),((ymax-y)*S).toFixed(1)];}
function L(P,a,b,c){const p=P(a[0],a[1]),q=P(b[0],b[1]);return `<line class="${c}" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"/>`;}
function J(P,a,r=5){const p=P(a[0],a[1]);return `<circle class="joint" cx="${p[0]}" cy="${p[1]}" r="${r}"/>`;}
function T(P,a,txt,c="",dx=0,dy=0){const p=P(a[0],a[1]);return `<text class="${c}" x="${+p[0]+dx}" y="${+p[1]+dy}">${txt}</text>`;}
function PL(P,pts,c){return `<polyline class="${c}" points="${pts.map(q=>P(q[0],q[1]).join(',')).join(' ')}"/>`;}
function foot(P,ax,ay){const pts=[[ax-7,0],[ax+20,0],[ax+18,3],[ax+4,ay-2],[ax-6,ay-1]].map(q=>P(q[0],q[1]).join(','));
  return `<polygon points="${pts.join(' ')}" class="ink" opacity=".85"/>`;}
function head(P,H,r=17){const p=P(H[0],H[1]);return `<circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="var(--surface)" stroke="var(--ink)" stroke-width="3"/>`;}
function setSeg(a,b,first){a.setAttribute('aria-pressed',first?'true':'false');b.setAttribute('aria-pressed',first?'false':'true');}
function seg(a,b,cb){a.onclick=()=>{setSeg(a,b,true);cb();};b.onclick=()=>{setSeg(a,b,false);cb();};}
function ik(K,Sh,Lt,Lb){const dx=Sh[0]-K[0],dy=Sh[1]-K[1],D=Math.hypot(dx,dy);
  const ok=D<=Lt+Lb+0.01&&D>=Math.abs(Lt-Lb);const aa=(Lt*Lt-Lb*Lb+D*D)/(2*D),h=Math.sqrt(Math.max(0,Lt*Lt-aa*aa));
  const mx=K[0]+aa*dx/D,my=K[1]+aa*dy/D;const c1=[mx+h*dy/D,my-h*dx/D],c2=[mx-h*dy/D,my+h*dx/D];return {H:c1[0]<c2[0]?c1:c2,ok};}
const RINGS=81;
function ringTxt(g){const d=(g-RINGS)/2;if(Math.abs(d)<1)return 'index fingers on the rings';return `index fingers ≈ ${Math.abs(d).toFixed(0)} cm ${d<0?'inside':'outside'} the rings`;}

/* ===== body model (shared) ===== */
const BODY={H:178,W:178,B:41,F:43.6,Lb:51.3,Ls:43.8,reach:63,Lu:33,est:{}};

/* ===== pure kinematics ===== */
function sqCalc(Lt,Lb,Ls,shinDeg,depDeg,low,ph){
  const a=rad(shinDeg*ph), phi=rad(-90+(90+depDeg)*ph), A=[0,8], MF=7;
  const K=[Ls*Math.sin(a), A[1]+Ls*Math.cos(a)];
  const H=[K[0]-Lt*Math.cos(phi), K[1]-Lt*Math.sin(phi)];
  const d=low?Lb-5:Lb+2, o=low?7:6;
  const bar=b=>[H[0]+d*Math.sin(b)-o*Math.cos(b), H[1]+d*Math.cos(b)+o*Math.sin(b)];
  let lo=rad(-10),hi=rad(88);const ok=(bar(lo)[0]-MF)*(bar(hi)[0]-MF)<=0;
  for(let i=0;i<46;i++){const m=(lo+hi)/2; if(bar(m)[0]<MF) lo=m; else hi=m;}
  const b=(lo+hi)/2, B=bar(b), Sh=[H[0]+Lb*Math.sin(b),H[1]+Lb*Math.cos(b)];
  return {A,K,H,B,Sh,b,ok,MF};
}
function dlCalc(arm,Lt0,Lb,Ls,sumo,ph){
  const A=[0,8], MF=7, by0=22.5, c45=Math.cos(rad(45)), Lt=sumo?Lt0*(c45+(1-c45)*ph):Lt0;
  let a0;
  if(sumo)a0=rad(4);
  else{let lo=0,hi=rad(40);for(let i=0;i<40;i++){const m=(lo+hi)/2;const dd=(MF-A[0])*Math.cos(m)-(by0-A[1])*Math.sin(m);if(dd>5)lo=m;else hi=m;}a0=(lo+hi)/2;}
  const a=a0*Math.max(0,1-ph/0.5);
  const K=[Ls*Math.sin(a),A[1]+Ls*Math.cos(a)];
  const delta=2+(-7-2)*ph, vy=Math.sqrt(arm*arm-delta*delta);
  const byLock=8+Ls+Lt0+Lb-vy;
  let by=by0+(byLock-by0)*ph, Sh=[MF+delta,by+vy], r=ik(K,Sh,Lt,Lb);
  if(!r.ok){const maxD=Lt+Lb,dx=Sh[0]-K[0],dy=Math.sqrt(Math.max(0,maxD*maxD-dx*dx));Sh=[Sh[0],K[1]+dy];by=Sh[1]-vy;r=ik(K,Sh,Lt,Lb);}
  const tor=Math.atan2(Sh[0]-r.H[0],Sh[1]-r.H[1]);
  return {A,K,H:r.H,Sh,B:[MF,by],MF,tor,travel:byLock-by0};
}
function bpCalc(grip,arch,reach,B){
  const s=B/2-2, g=grip/2+4;
  const hLock=Math.sqrt(Math.max(0,reach*reach-(g-s)*(g-s)));
  const chest=14+arch;return {s,g,hLock,chest,rom:hLock-chest};
}

/* ===== Rep player ===== */
function player(key,timeline,render){
  const btn=$(key+'Play'),sl=$(key+'Phase'),stage=$(key+'Stage');
  let raf=0,t0=0;const total=timeline.reduce((s,x)=>s+x[0],0);
  function at(ms){let t=ms%total;for(const [d,a,b,lab] of timeline){if(t<=d)return [a+(b-a)*ease(t/d),lab];t-=d;}return [timeline[0][1],timeline[0][3]];}
  function frame(now){const [ph,lab]=at(now-t0);sl.value=Math.round(ph*100);stage.textContent=lab;render(ph);raf=requestAnimationFrame(frame);}
  function stop(){cancelAnimationFrame(raf);raf=0;btn.setAttribute('aria-pressed','false');btn.querySelector('.pl').textContent='Play rep';}
  players.push(stop);
  btn.onclick=()=>{if(raf){stop();return;}btn.setAttribute('aria-pressed','true');btn.querySelector('.pl').textContent='Stop';t0=performance.now();raf=requestAnimationFrame(frame);};
  sl.addEventListener('input',()=>{if(raf)stop();stage.textContent='scrub';render(sl.value/100);});
  return ()=>+sl.value/100;
}

/* ===== SQUAT model ===== */
const sq={low:true};
const sqSolve=ph=>sqCalc(+$('sqFemur').value,+$('sqTorso').value,BODY.Ls,+$('sqShin').value,+$('sqDepth').value,sq.low,ph);
let sqPh=()=>1;
function squat(ph){
  if(ph===undefined) ph=sqPh();
  $('sqFemurO').value=$('sqFemur').value+' cm';$('sqTorsoO').value=$('sqTorso').value+' cm';$('sqShinO').value=$('sqShin').value+'°';
  $('sqDepthO').value=(+$('sqDepth').value>0?'+':'')+$('sqDepth').value+'°';$('sqPhaseO').value=Math.round(ph*100)+'%';
  const {A,K,H,B,Sh,b,ok,MF}=sqSolve(ph);
  const tr=[];for(let i=0;i<=24;i++)tr.push(sqSolve(i/24));
  const Hd=[Sh[0]+14*Math.sin(b)+3, Sh[1]+14*Math.cos(b)+2], hand=[B[0]-2,B[1]+1], elbow=[B[0]-14,B[1]-14];
  const P=mkMap(-60,175,2.0);
  let s=L(P,[-60,0],[90,0],'ground')+L(P,[MF,0],[MF,172],'mf');
  s+=PL(P,tr.map(r=>r.H),'trace')+PL(P,tr.map(r=>r.K),'trace')+PL(P,tr.map(r=>r.B),'btrace');
  const bp=P(B[0],B[1]);
  s+=`<circle class="plate" cx="${bp[0]}" cy="${bp[1]}" r="45"/>`;
  s+=foot(P,A[0],A[1])+L(P,A,K,'bone')+L(P,K,H,'bone')+L(P,H,Sh,'bone')+L(P,Sh,Hd,'bone')+head(P,Hd);
  s+=L(P,Sh,elbow,'bone2')+L(P,elbow,hand,'bone2');
  s+=L(P,H,[B[0],H[1]],'marm')+L(P,K,[B[0],K[1]],'marm');
  s+=J(P,A,4)+J(P,K,6)+J(P,H,6)+J(P,Sh,5)+`<circle class="barc" cx="${bp[0]}" cy="${bp[1]}" r="7"/>`;
  s+=T(P,H,'hip','k',-26,18)+T(P,K,'knee','k',8,-8)+T(P,[MF,170],'midfoot','p',6,0);
  if(Math.abs(B[0]-H[0])>4) s+=T(P,[Math.min(H[0],B[0]),H[1]],Math.abs(B[0]-H[0]).toFixed(0)+' cm','a',4,-8);
  if(Math.abs(K[0]-B[0])>4) s+=T(P,[Math.min(K[0],B[0]),K[1]],Math.abs(K[0]-B[0]).toFixed(0)+' cm','a',4,-8);
  s+=T(P,[-56,172],sq.low?'LOW BAR':'HIGH BAR','r',0,10);
  if(!ok) s+=T(P,[-56,162],'no balanced solution','r',0,10);
  else if(deg(b)>68) s+=T(P,[-56,162],'extreme lean: add knee travel','r',0,10);
  $('sqSvg').innerHTML=s;
  $('sqR1').textContent=deg(b).toFixed(0)+'° from vertical';
  $('sqR2').textContent=Math.abs(B[0]-H[0]).toFixed(1)+' cm';
  $('sqR3').textContent=Math.abs(K[0]-B[0]).toFixed(1)+' cm';
  const dep=+$('sqDepth').value;
  $('sqR4').textContent=dep>=2?'below parallel ✓':(dep>=0?'≈ borderline':'high ✕');
  $('sqR4').style.color=dep>=2?'var(--good)':(dep>=0?'var(--arm)':'var(--accent)');
}
sqPh=player('sq',[[700,0,0,'squat'],[1700,0,1,'descent'],[350,1,1,'bottom'],[1300,1,0,'drive'],[700,0,0,'rack']],squat);
seg($('sqLow'),$('sqHigh'),()=>{sq.low=$('sqLow').getAttribute('aria-pressed')==='true';squat();});
['sqFemur','sqTorso','sqShin','sqDepth'].forEach(id=>$(id).addEventListener('input',()=>squat()));

/* ===== BENCH model ===== */
let bpPh=()=>1;
const sidePath=$('bpSidePath'),dot=$('bpDot');
function bench(ph){
  if(ph===undefined) ph=bpPh();
  const grip=+$('bpGrip').value, arch=+$('bpArch').value, Larm=+$('bpArm').value;
  $('bpGripO').value=grip+' cm';$('bpArchO').value=arch+' cm';$('bpArmO').value=Larm+' cm';$('bpPhaseO').value=Math.round(ph*100)+'%';
  const {s,g,hLock,chest,rom}=bpCalc(grip,arch,Larm,BODY.B), touch=chest+2, hy=hLock+(touch-hLock)*ph;
  const P=mkMap(-60,82,2.6);
  let o=`<rect x="${P(-14,-6)[0]}" y="${P(-14,-6)[1]}" width="${28*2.6}" height="${8*2.6}" class="ink" opacity=".8"/>`;
  const c=P(0,(chest-4)/2), ry=((chest+4)/2+3)*2.6;
  o+=`<ellipse cx="${c[0]}" cy="${c[1]}" rx="${(s+4)*2.6}" ry="${ry.toFixed(1)}" fill="var(--surface)" stroke="var(--ink)" stroke-width="2.5"/>`;
  o+=L(P,[-58,hLock],[58,hLock],'ghost')+L(P,[-58,touch],[58,touch],'ghost');
  const e0=[(s+g)/2+1.5,hLock/2], e1=[g+5,chest*0.3];
  const eX=e0[0]+(e1[0]-e0[0])*ph, eY=e0[1]+(e1[1]-e0[1])*ph;
  o+=L(P,[-s,0],[-eX,eY],'bone')+L(P,[-eX,eY],[-g,hy],'bone')+L(P,[s,0],[eX,eY],'bone')+L(P,[eX,eY],[g,hy],'bone');
  o+=`<line x1="${P(-58,0)[0]}" y1="${P(0,hy)[1]}" x2="${P(58,0)[0]}" y2="${P(0,hy)[1]}" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/>`;
  [-RINGS/2,RINGS/2].forEach(x=>{const p=P(x,hy);o+=`<line x1="${p[0]}" y1="${+p[1]-7}" x2="${p[0]}" y2="${+p[1]+7}" stroke="var(--ink)" stroke-width="1.5"/>`;});
  o+=J(P,[-s,0])+J(P,[s,0])+J(P,[-eX,eY],4)+J(P,[eX,eY],4);
  o+=L(P,[50,touch],[50,hLock],'marm')+T(P,[50,(hLock+touch)/2],'ROM','a',-34,4);
  o+=T(P,[-58,hLock],'lockout','',0,-8)+T(P,[-58,touch],'touch','r',0,-10)+T(P,[-s,0],'shoulder joints','',-6,20);
  $('bpSvg').innerHTML=o;
  $('bpR1').textContent=hLock.toFixed(1)+' cm';$('bpR2').textContent=chest.toFixed(1)+' cm';$('bpR3').textContent=rom.toFixed(1)+' cm';
  if(sidePath&&sidePath.getTotalLength){const len=sidePath.getTotalLength(),pt=sidePath.getPointAtLength(len*ph);dot.setAttribute('cx',pt.x.toFixed(1));dot.setAttribute('cy',pt.y.toFixed(1));}
}
bpPh=player('bp',[[600,0,0,'start'],[1500,0,1,'descent'],[900,1,1,'pause · press!'],[1300,1,0,'press'],[600,0,0,'rack']],bench);
['bpGrip','bpArch','bpArm'].forEach(id=>$(id).addEventListener('input',()=>bench()));

/* ===== DEADLIFT model ===== */
const dl={sumo:false};
const dlSolve=ph=>dlCalc(+$('dlArm').value,+$('dlFemur').value,+$('dlTorso').value,BODY.Ls,dl.sumo,ph);
let dlPh=()=>0;
function dead(ph){
  if(ph===undefined) ph=dlPh();
  $('dlArmO').value=$('dlArm').value+' cm';$('dlFemurO').value=$('dlFemur').value+' cm';$('dlTorsoO').value=$('dlTorso').value+' cm';$('dlPhaseO').value=Math.round(ph*100)+'%';
  const X=dlSolve(ph),{A,K,H,Sh,B,MF,tor}=X;
  const tr=[];for(let i=0;i<=24;i++)tr.push(dlSolve(i/24));
  const Hd=[Sh[0]+14*Math.sin(tor)+3,Sh[1]+14*Math.cos(tor)];
  const P=mkMap(-55,175,1.9);
  let s=L(P,[-55,0],[118,0],'ground')+L(P,[MF,0],[MF,170],'mf');
  s+=PL(P,tr.map(r=>r.H),'trace')+PL(P,tr.map(r=>r.Sh),'trace')+PL(P,tr.map(r=>r.B),'btrace');
  const bp=P(B[0],B[1]);
  s+=`<circle class="plate" cx="${bp[0]}" cy="${bp[1]}" r="${(22.5*1.9).toFixed(1)}"/>`;
  s+=foot(P,A[0],A[1])+L(P,A,K,'bone')+L(P,K,H,'bone')+L(P,H,Sh,'bone')+L(P,Sh,Hd,'bone')+L(P,Sh,[B[0],B[1]+2],'bone2')+head(P,Hd);
  if(Math.abs(B[0]-H[0])>3){s+=L(P,H,[B[0],H[1]],'marm');s+=T(P,[Math.min(H[0],B[0]),H[1]],Math.abs(B[0]-H[0]).toFixed(0)+' cm','a',4,-8);}
  s+=J(P,A,4)+J(P,K,6)+J(P,H,6)+J(P,Sh,5)+`<circle class="barc" cx="${bp[0]}" cy="${bp[1]}" r="7"/>`;
  s+=T(P,H,'hip','k',-28,4)+T(P,K,'knee','k',8,4)+T(P,Sh,'shoulder','k',8,-6);
  s+=T(P,[-52,172],dl.sumo?'SUMO':'CONVENTIONAL','r',0,10);
  if(deg(tr[0].tor)>85) s+=T(P,[-52,162],'hips above shoulders: try sumo','r',0,10);
  $('dlSvg').innerHTML=s;
  $('dlR1').textContent=deg(tor).toFixed(0)+'° from vertical';
  $('dlR2').textContent=H[1].toFixed(0)+' cm';
  $('dlR3').textContent=Math.abs(B[0]-H[0]).toFixed(1)+' cm';
  $('dlR4').textContent='≈ '+X.travel.toFixed(0)+' cm';
}
dlPh=player('dl',[[700,0,0,'slack out'],[2000,0,1,'pull'],[600,1,1,'lockout'],[1500,1,0,'down'],[500,0,0,'reset']],dead);
seg($('dlConv'),$('dlSumo'),()=>{dl.sumo=$('dlSumo').getAttribute('aria-pressed')==='true';dead();});
['dlArm','dlFemur','dlTorso'].forEach(id=>$(id).addEventListener('input',()=>dead()));

/* ===== YOUR BUILD ===== */
const FORM=['inH','inW','inB','inF','inS','inKTW','inHip','inShoe','inShould','inArch','inPain','inSqS','inBpS','inDlS'];
const KEY='techniqueBody';
try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved)FORM.forEach(id=>{if(saved[id]!==undefined && (typeof saved[id]==='string' || typeof saved[id]==='number')) {
    const el=$(id), value=String(saved[id]);
    if(el.tagName!=='SELECT' || [...el.options].some(o=>o.value===value)) el.value=value;
  }});}catch(e){}
function save(){try{const o={};FORM.forEach(id=>o[id]=$(id).value);localStorage.setItem(KEY,JSON.stringify(o));}catch(e){}}

const STANCE={
  narrow:{f:.97,name:'Narrow',heels:[.8,.95],toes:'5–15°'},
  shoulder:{f:.9,name:'Shoulder width',heels:[1.0,1.15],toes:'15–30°'},
  wide:{f:.8,name:'Wide',heels:[1.3,1.55],toes:'25–40°'}};
const STICK={
  sq:{none:'Film your top sets from the side to find where the bar slows down most.',
      hole:'Pause squats (2–3 s), pin squats from the bottom, tempo squats with a slow descent, front squats.',
      mid:'Safety-bar or high-bar squats, pause squats, belt squats. Cue "chest up into the bar" so the hips don\'t rise first.',
      top:'A true lockout miss is rare. It usually comes from losing position earlier, so check bar path and brace on video.'},
  bp:{none:'Film from the side: note where the bar slows down most.',
      chest:'Long-pause bench, Spoto press, a slightly wider grip in training, DB press.',
      mid:'Pin press set at your sticking height, Larsen press, tempo bench.',
      top:'Close-grip bench, board press, JM press, triceps volume.'},
  dl:{none:'Film from the side and note where the bar slows down.',
      floor:'Deficit pulls (2–5 cm), pause just off the floor, quad work (front squat, leg press).',
      knee:'Pause below the knee, RDLs, tempo deadlifts with a slow lowering.',
      top:'Block pulls, hip thrusts, banded pulls, heavy holds.'}};

let RX=null;
function computeBody(){
  const num=id=>{const v=parseFloat($(id).value);return isFinite(v)?v:null;};
  const est={};
  const H=clamp(num('inH')||178,140,215);
  let W=num('inW');if(!W||W<H*0.9||W>H*1.15){W=H;est.W=1;}
  let B=num('inB');if(!B||B<H*0.17||B>H*0.3){B=0.23*H;est.B=1;}
  let F=num('inF');if(!F||F<H*0.19||F>H*0.31){F=0.245*H;est.F=1;}
  const S=num('inS');let Lb;if(S&&S>H*0.44&&S<H*0.6){Lb=S-0.232*H;}else{Lb=0.288*H;est.S=1;}
  const ktwRaw=num('inKTW'), ktw=ktwRaw===null?10:clamp(ktwRaw,0,20); if(ktwRaw===null)est.K=1;
  Object.assign(BODY,{H,W,B,F,Lb,Ls:0.246*H,reach:(W-B)/2-6,Lu:0.186*W,ktw,est});
  return BODY;
}

function compute(){
  const b=computeBody(), hip=$('inHip').value, heel=$('inShoe').value==='heel', shIssue=$('inShould').value==='issue';
  const arch=+$('inArch').value, pain=$('inPain').value==='yes';
  const DF=3.6*b.ktw+2, shinUse=clamp(DF-8+(heel?8:0),12,44);
  const shinFor=low=>Math.min(shinUse,low?27:36);
  const ratio=b.F/b.Lb, ape=b.W/b.H, armTorso=b.reach/b.Lb;

  /* ---- squat ---- */
  const lean={};
  for(const k in STANCE){lean[k]={low:deg(sqCalc(b.F*STANCE[k].f,b.Lb,b.Ls,shinFor(true),6,true,1).b),high:deg(sqCalc(b.F*STANCE[k].f,b.Lb,b.Ls,shinFor(false),6,false,1).b)};}
  let stance=hip==='unknown'?(ratio>0.92?'wide':'shoulder'):hip;
  let sqWhy=[];
  if(hip==='unknown') sqWhy.push(`Stance picked from your femur:torso ratio (${ratio.toFixed(2)}). Do the hip-socket test to confirm it.`);
  else sqWhy.push(`Stance from your hip-socket test: that's where your hips have room to reach depth without the pelvis tucking.`);
  let low=true;
  if(shIssue){low=false;sqWhy.push('High or mid bar because low bar bothers your elbows, wrists or shoulders. A position just below the traps keeps most of the leverage benefit.');}
  else if(lean[stance].low>60){low=false;sqWhy.push(`Low bar would put your torso at ≈${r0(lean[stance].low)}° at this stance, close to horizontal. High bar (≈${r0(lean[stance].high)}°) or raised heels will be easier to control.`);}
  else sqWhy.push(`Low bar gives the shortest hip moment arm for powerlifting; at your proportions it puts your torso at ≈${r0(lean[stance].low)}° from vertical.`);
  if(b.ktw<8&&!heel) sqWhy.push(`Your knee-to-wall (${b.ktw} cm) limits knee travel. Raised-heel shoes or ankle mobility work will let you sit more upright.`);
  if(ratio>0.92) sqWhy.push('Long femurs relative to torso: expect a forward lean even with good technique. Keep the upper back strong and don\'t try to force an upright squat.');
  else if(ratio<0.78) sqWhy.push('Short femurs relative to torso: you can squat quite upright. Narrow stances work well for you.');
  const st=STANCE[stance];
  const sqGrip=low?(shIssue?[b.B*1.9,b.B*2.3]:[b.B*1.6,b.B*1.9]):[b.B*1.35,b.B*1.65];
  const sqShin=shinFor(low);

  /* ---- bench ---- */
  const half=b.B/2-2+0.55*b.Lu, G0=clamp(2*(half-4),40,81);
  let gr, bpWhy=[];
  const bs=$('inBpS').value;
  if(pain){gr=[G0-5,G0];bpWhy.push('Kept at or a bit inside forearms-vertical because wide grips bother your shoulders or pecs.');}
  else if(bs==='top'){gr=[G0-2,G0+4];bpWhy.push('Kept moderate since you miss at lockout: very wide grips cut triceps involvement, which is your weak range.');}
  else {gr=[G0,G0+9];bpWhy.push('Forearms vertical at the bottom is the base. Going a few cm wider cuts range of motion if your shoulders tolerate it.');}
  gr=[clamp(gr[0],40,81),clamp(gr[1],40,81)];
  const gPick=clamp(r0((gr[0]+gr[1])/2),40,81);
  const romA=bpCalc(gr[0],arch,b.reach,b.B).rom, romB=bpCalc(gr[1],arch,b.reach,b.B).rom, rom81=bpCalc(81,arch,b.reach,b.B).rom;
  bpWhy.push(`Your range of motion: ≈${romA.toFixed(0)} cm at ${r0(gr[0])} cm grip, ≈${romB.toFixed(0)} cm at ${r0(gr[1])} cm${gr[1]<80?`, ≈${rom81.toFixed(0)} cm at the 81 cm limit`:''}.`);
  if(ape>1.03) bpWhy.push(`Long arms (ape index ${ape.toFixed(2)}): your ROM is longer than average, so arch and grip width give you more than they give most lifters. Lockout strength matters a lot for you.`);
  else if(ape<0.98) bpWhy.push(`Short arms (ape index ${ape.toFixed(2)}): a naturally short bench stroke. You can afford a slightly narrower, more triceps-friendly grip.`);
  const tuck=ape>1.03?'45–60°':'55–70°';

  /* ---- deadlift ---- */
  const C=dlCalc(b.reach,b.F,b.Lb,b.Ls,false,0), Su=dlCalc(b.reach,b.F,b.Lb,b.Ls,true,0);
  const tc=deg(C.tor), ts=deg(Su.tor), hc=Math.abs(C.B[0]-C.H[0]), hs=Math.abs(Su.B[0]-Su.H[0]);
  let score=(tc-60)/7 + (hip==='wide'?0.7:hip==='narrow'?-0.7:0);
  const style=score>0.6?'sumo':score<-0.6?'conv':'both';
  let dlWhy=[`Start position with your proportions: conventional torso ≈${r0(tc)}° from vertical, hip ≈${r0(hc)} cm behind the bar; sumo ≈${r0(ts)}°, ≈${r0(hs)} cm.`];
  const driver=ratio>0.92?'long femurs relative to your torso':ape<0.98?'short arms':armTorso<1.15?'short arms relative to your torso':'your overall proportions';
  const helper=ape>1.03?'long arms':ratio<0.78?'short femurs relative to your torso':'your overall proportions';
  if(tc>=66) dlWhy.push(`Your conventional start is close to horizontal, mainly because of ${driver}: the hips have to sit far behind the bar. Sumo shortens the femur in side view and lets you sit more upright.`);
  else if(tc<=56) dlWhy.push(`Your conventional start is fairly upright thanks to ${helper}, which keeps the hips close to the bar.`);
  if(ape>1.03) dlWhy.push('Long arms shorten your bar travel in both styles.');
  else if(ape<0.98) dlWhy.push('Short arms lengthen your bar travel; sumo recovers some of it.');
  if(hip==='wide') dlWhy.push('Your hips are comfortable wide, which sumo needs.');
  if(hip==='narrow') dlWhy.push('Your hips prefer a narrow position, which suits conventional. Sumo needs a lot of hip external rotation.');
  if(style==='both') dlWhy.push('Neither style has a clear mechanical edge for you. Train both for 4–6 weeks and keep the one that moves more weight at the same effort.');
  const dlGrip=style==='sumo'?[b.B*1.0,b.B*1.15]:[b.B*1.15,b.B*1.3];
  const sumoHeels=[b.B*1.7,b.B*2.1], convHeels=[b.B*0.55,b.B*0.75];

  RX={stance,low,sqShin,gPick,arch,style,lean};

  /* ---- render: segments ---- */
  const e=k=>b.est[k]?' <i class="est">est.</i>':'';
  $('segOut').innerHTML=[
    ['Femur',b.F.toFixed(1)+' cm'+e('F')],['Torso (hip→shoulder)',b.Lb.toFixed(1)+' cm'+e('S')],['Shin',b.Ls.toFixed(1)+' cm <i class="est">est.</i>'],
    ['Arm reach (shoulder→grip)',b.reach.toFixed(1)+' cm'+e('W')],['Shoulder width',b.B.toFixed(1)+' cm'+e('B')],['Usable shin angle',r0(shinUse)+'°'+e('K')],
    ['Femur : torso',ratio.toFixed(2)+(ratio>0.92?' long femurs':ratio<0.78?' short femurs':' average')],['Ape index',ape.toFixed(2)+(ape>1.03?' long arms':ape<0.98?' short arms':' average')],
    ['Reach : torso',armTorso.toFixed(2)+(armTorso>1.28?' long':armTorso<1.15?' short':' average')]
  ].map(([k,v])=>`<div><span>${k}</span><b>${v}</b></div>`).join('');
  const nEst=Object.keys(b.est).length;
  $('segNotes').innerHTML=nEst?`<p class="note">${nEst} value${nEst>1?'s are':' is'} estimated from height. Measure ${b.est.F&&b.est.S?'thigh length and sitting height':b.est.F?'thigh length':b.est.S?'sitting height':b.est.W?'wingspan':'shoulder width'} first: ${b.est.F||b.est.S?'they decide your squat and deadlift positions':'it changes your grip numbers'}.</p>`:'';

  /* ---- render: you-figure ---- */
  drawYou(b);

  /* ---- render: rx cards ---- */
  const row=(k,v)=>`<div class="rxrow"><span>${k}</span><b>${v}</b></div>`;
  const why=a=>`<ul class="tick why">${a.map(x=>`<li>${x}</li>`).join('')}</ul>`;
  $('rxSq').innerHTML=`<div class="rxhead"><b>S</b><h3>Your squat</h3></div>`+
    row('Bar position',low?'Low bar':'High / mid bar')+
    row('Stance',`${st.name}: heels ≈ ${r0(b.B*st.heels[0])}–${r0(b.B*st.heels[1])} cm apart`)+
    row('Toe angle',st.toes)+
    row('Grip (index to index)',`≈ ${r0(sqGrip[0])}–${r0(sqGrip[1])} cm · ${ringTxt((sqGrip[0]+sqGrip[1])/2)}`)+
    row('Shoes',heel||b.ktw<8?'Raised heel':'Flat or raised, by preference')+
    row('Expected torso lean',`≈ ${r0(low?lean[stance].low:lean[stance].high)}° from vertical`)+
    why(sqWhy)+`<div class="stickbox"><span class="eyebrow">Your sticking point</span><p>${STICK.sq[$('inSqS').value]}</p></div>`;
  $('rxBp').innerHTML=`<div class="rxhead"><b>B</b><h3>Your bench</h3></div>`+
    row('Grip (index to index)',`≈ ${r0(gr[0])}–${r0(gr[1])} cm`)+
    row('On the bar',ringTxt(gPick)+` (at ${gPick} cm)`)+
    row('Elbow angle at the bottom',tuck+' from torso')+
    row('Arch',arch>=12?'Large: feet back, chest high':arch>=7?'Moderate: build it from the upper back':'Small: focus on scapular retraction')+
    row('Range of motion',`≈ ${bpCalc(gPick,arch,b.reach,b.B).rom.toFixed(0)} cm`)+
    why(bpWhy)+`<div class="stickbox"><span class="eyebrow">Your sticking point</span><p>${STICK.bp[$('inBpS').value]}</p></div>`;
  $('rxDl').innerHTML=`<div class="rxhead"><b>D</b><h3>Your deadlift</h3></div>`+
    row('Style',style==='sumo'?'Sumo favoured':style==='conv'?'Conventional favoured':'Both viable: test')+
    row('Stance',style==='sumo'?`Heels ≈ ${r0(sumoHeels[0])}–${r0(sumoHeels[1])} cm, toes 30–45°`:`Heels ≈ ${r0(convHeels[0])}–${r0(convHeels[1])} cm, toes 0–15°`)+
    row('Grip (index to index)',`≈ ${r0(dlGrip[0])}–${r0(dlGrip[1])} cm`)+
    row('Bar travel',`conv ≈ ${r0(C.travel)} cm · sumo ≈ ${r0(Su.travel-8)} cm`)+
    why(dlWhy)+`<div class="stickbox"><span class="eyebrow">Your sticking point</span><p>${STICK.dl[$('inDlS').value]}</p></div>`;

  /* ---- matrix ---- */
  let m='<table style="min-width:420px"><thead><tr><th>Stance</th><th>Low bar</th><th>High bar</th></tr></thead><tbody>';
  for(const k in STANCE){m+=`<tr><td>${STANCE[k].name}</td>`;
    for(const bar of ['low','high']){const v=lean[k][bar],pick=k===stance&&(bar==='low')===low;
      m+=`<td class="${pick?'pick':''}"><span class="mono">${r0(v)}°</span> <span class="lean" style="--w:${clamp(v/80*100,4,100).toFixed(0)}%"></span>${pick?' <b class="pk">your setup</b>':''}</td>`;}
    m+='</tr>';}
  $('sqMatrix').innerHTML=m+'</tbody></table>';

  /* ---- per-lift summaries ---- */
  $('sqMine').innerHTML=`<b>Your setup</b><span>${low?'Low bar':'High/mid bar'} · ${st.name.toLowerCase()} stance (heels ≈ ${r0(b.B*st.heels[0])}–${r0(b.B*st.heels[1])} cm), toes ${st.toes} · grip ≈ ${r0((sqGrip[0]+sqGrip[1])/2)} cm</span><a href="#you">Edit</a>`;
  $('bpMine').innerHTML=`<b>Your setup</b><span>Grip ≈ ${r0(gr[0])}–${r0(gr[1])} cm (${ringTxt(gPick)}) · elbows ${tuck} · ROM ≈ ${bpCalc(gPick,arch,b.reach,b.B).rom.toFixed(0)} cm</span><a href="#you">Edit</a>`;
  $('dlMine').innerHTML=`<b>Your setup</b><span>${style==='sumo'?'Sumo':style==='conv'?'Conventional':'Conventional or sumo: test both'} · grip ≈ ${r0((dlGrip[0]+dlGrip[1])/2)} cm</span><a href="#you">Edit</a>`;
}

function drawYou(b){
  const P=mkMap(-30,b.H*0.95,290/(b.H*0.95));
  // draw ghost (average) then you; use simple manual since fig returns concat strings
  const avg={F:0.245*b.H,Lb:0.288*b.H,Ls:b.Ls,reach:(b.H-0.23*b.H)/2-6};
  const draw=(d,cls,joints)=>{const A=[0,6],K=[0,6+d.Ls],H=[-1,6+d.Ls+d.F],S=[0,H[1]+d.Lb],Hd=[1,S[1]+0.07*b.H];
    let s=L(P,A,K,cls)+L(P,K,H,cls)+L(P,H,S,cls)+L(P,S,Hd,cls)+L(P,[S[0]+3,S[1]],[8,S[1]-d.reach],cls==='bone'?'bone2':cls);
    if(joints){s+=head(P,Hd,10)+J(P,K,4)+J(P,H,4)+J(P,S,4);
      s+=T(P,[(K[0]),(K[1]+H[1])/2],'femur '+d.F.toFixed(0),'k',-82,4)+T(P,[0,(H[1]+S[1])/2],'torso '+d.Lb.toFixed(0),'k',-82,4)+T(P,[8,S[1]-d.reach],'reach '+d.reach.toFixed(0),'p',10,0);}
    return s;};
  let s=L(P,[-30,0],[140,0],'ground');
  s+=`<g transform="translate(215 0)">${draw(avg,'ghost',false)}</g>`;
  s+=`<g transform="translate(85 0)">${draw(b,'bone',true)}</g>`;
  s+=`<text class="k" x="20" y="16">YOU</text><text x="205" y="16">AVERAGE</text>`;
  $('youSvg').innerHTML=s;
}

function applyToModels(){
  if(!RX)return;const b=BODY;
  const set=(id,v)=>{const el=$(id);el.value=clamp(r0(v),+el.min,+el.max);};
  sq.low=RX.low;setSeg($('sqLow'),$('sqHigh'),RX.low);
  set('sqFemur',b.F*STANCE[RX.stance].f);set('sqTorso',b.Lb);set('sqShin',RX.sqShin);
  set('bpGrip',RX.gPick);set('bpArch',RX.arch);set('bpArm',b.reach);
  dl.sumo=RX.style==='sumo';setSeg($('dlConv'),$('dlSumo'),!dl.sumo);
  set('dlArm',b.reach);set('dlFemur',b.F);set('dlTorso',b.Lb);
  squat();bench();dead();
  $('bodyStatus').textContent='models show your body';
}
function onForm(){save();compute();applyToModels();}
FORM.forEach(id=>$(id).addEventListener('input',onForm));
FORM.forEach(id=>$(id).addEventListener('change',onForm));
$('bodyApply').onclick=applyToModels;
$('bodyForm').addEventListener('submit', event=>event.preventDefault());
compute();applyToModels();
return { stop: () => players.forEach(stop => stop()) };

}
