const http=require('http'),fs=require('fs'),path=require('path');
const PROPS=require('./props');
const KEY=process.env.LLM_API_KEY, PORT=process.env.PORT||8787, MODEL=process.env.LLM_MODEL||'gpt-4o-mini';
if(!KEY){console.error('LLM_API_KEY fehlt');process.exit(1)}
const SYS=`Du bist der KI-Concierge von ImmoConcierge, einem neutralen Immobilien-Service an der Costa del Sol (Pilot: Marbella und Umgebung). Du bist unabhängig vom Portfolio einzelner Makler und empfiehlst, was für den Käufer am besten passt.
Statt Suchmaske führst du ein freundliches Gespräch und erfasst ein Lebensprofil: Nutzungszweck (Eigennutzung/Ferien/Investment/Altersruhesitz), Budget, Familie/Kinder und Schule (international/deutsch), Homeoffice/Glasfaser, max. Fahrzeit zum Flughafen Málaga, Golf/Sport, Strand vs. Ruhe/Natur, Regionen-Präferenz.
Regeln: Immer nur EINE kurze Frage pro Nachricht (1-3 Sätze). Antworte in der Sprache des Nutzers (Deutsch: duzen/"ihr" je nach Nutzer). Stelle insgesamt nur 4-6 Fragen (fasse ggf. zusammen). Spätestens dann, oder sobald Budget und Nutzungszweck bekannt sind und der Nutzer Vorschläge will, rufe das Tool search_properties mit dem Profil auf. Nach dem Tool-Ergebnis (die UI zeigt die 3 Objekte als Karten mit Scoring): schreibe 2-4 Sätze: kurze Profil-Zusammenfassung, Hinweis dass es Beispielobjekte (Demo) sind, und dass ein lokaler ImmoConcierge-Berater das Profil verfeinert und weitere reale Angebote aus dem ganzen Markt aller Partner-Makler neutral ergänzt und eine Besichtigungstour organisieren kann. Liste die Objekte NICHT erneut auf. Erfinde nie eigene Objekte außerhalb des Tools. Rufe das Tool erneut nur auf, wenn sich das Profil ändert oder der Nutzer neue Vorschläge will. Keine Rechts- oder Steuerberatung; verweise dafür auf Partner-Anwälte (der Due-Diligence-Check ist eine Vorprüfung). Kein Markdown außer einfachen Stichpunkten mit "-" und **fett**.`;

const TOOLS=[{type:'function',function:{name:'search_properties',description:'Sucht und bewertet Objekte passend zum Lebensprofil. Gibt Top 3 zurück.',parameters:{type:'object',properties:{
 budget_max:{type:'number',description:'Max. Budget in EUR'},bedrooms_min:{type:'number'},purpose:{type:'string',enum:['eigennutzung','ferien','investment','ruhestand']},
 kids_school:{type:'boolean',description:'Kinder/Schule wichtig'},homeoffice:{type:'boolean'},airport_max_min:{type:'number',description:'Max. Minuten zum Flughafen Málaga'},
 golf:{type:'boolean'},sea_view:{type:'boolean'},beach_near:{type:'boolean'},quiet:{type:'boolean',description:'Ruhe/Natur bevorzugt'},regions:{type:'array',items:{type:'string'}}},required:['budget_max']}}}];
const cl=x=>Math.max(0,Math.min(100,Math.round(x)));
function score(p,q){
 const b=q.budget_max||1e9;const budget=p.price<=b?(p.price>=b*0.6?100:80):cl(100-(p.price/b-1)*250);
 let lage=60;if(q.regions&&q.regions.length){lage=q.regions.some(r=>p.region.toLowerCase().includes(String(r).toLowerCase().split(/[ –-]/)[0]))?100:45}
 if(q.sea_view)lage+=p.sea?10:-15;if(q.beach_near)lage+=p.beach<=1.5?10:-10;if(q.quiet)lage+=p.beach>3?10:-5;lage=cl(lage);
 const fam=q.kids_school?cl(100-(p.school-3)*8-(q.bedrooms_min&&p.bed<q.bedrooms_min?30:0)):cl(80-(q.bedrooms_min&&p.bed<q.bedrooms_min?30:0));
 const ho=q.homeoffice?(p.fiber?(p.bed>=3?100:80):35):85;
 const golf=q.golf?cl(100-p.golf*10):75;
 const am=q.airport_max_min||60;const air=p.airport<=am?cl(100-p.airport/4+10):cl(70-(p.airport-am)*3);
 const w={budget:3,lage:2,fam:q.kids_school?2:0.5,ho:q.homeoffice?1.5:0.5,golf:q.golf?1.5:0.5,air:1.5};
 const total=Math.round((budget*w.budget+lage*w.lage+fam*w.fam+ho*w.ho+golf*w.golf+air*w.air)/(w.budget+w.lage+w.fam+w.ho+w.golf+w.air));
 const why=[];if(p.price<=b)why.push('im Budget');if(q.golf&&p.golf<=1)why.push('Golf in '+p.golf+' km');if(q.kids_school&&p.school<=6)why.push('internationale Schule in '+p.school+' km');
 if(q.homeoffice&&p.fiber)why.push('Glasfaser fürs Homeoffice');if(p.airport<=am)why.push(p.airport+' Min. zum Flughafen');if(q.sea_view&&p.sea)why.push('Meerblick');if(q.beach_near&&p.beach<=1.5)why.push('Strand '+p.beach+' km');
 return {...p,total,sub:{Budget:budget,Lage:lage,'Familie/Schule':fam,Homeoffice:ho,'Freizeit/Golf':golf,Flughafen:air},why:why.length?'Passt, weil: '+why.slice(0,4).join(', ')+'.':'Solide Alternative zum Profil.'};
}
function search(q){return PROPS.map(p=>score(p,q)).sort((a,b)=>b.total-a.total).slice(0,3)}
async function oa(body){const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify(body)});if(!r.ok){const t=await r.text();throw new Error('upstream '+r.status+' '+t.slice(0,200))}return r}
const srv=http.createServer(async(req,res)=>{
 if(req.method==='POST'&&req.url==='/api/chat'){
  let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
   try{
    const msgs=(JSON.parse(b).messages||[]).slice(-30).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:String(m.content).slice(0,4000)}));
    const base=[{role:'system',content:SYS},...msgs];
    const j=await (await oa({model:MODEL,temperature:0.6,messages:base,tools:TOOLS})).json();
    const m=j.choices[0].message;
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-cache'});
    if(!m.tool_calls){res.write(m.content||'');return res.end()}
    const tc=m.tool_calls[0];let q={};try{q=JSON.parse(tc.function.arguments)}catch{}
    const top=search(q);
    res.write('\u0001'+JSON.stringify(top)+'\u0002');
    const slim=top.map(p=>({id:p.id,type:p.type,region:p.region,price:p.price,match:p.total}));
    const r=await oa({model:MODEL,stream:true,temperature:0.6,messages:[...base,m,{role:'tool',tool_call_id:tc.id,content:JSON.stringify({demo:true,results:slim})}]});
    const dec=new TextDecoder();let buf='';
    for await(const ch of r.body){buf+=dec.decode(ch,{stream:true});const ls=buf.split('\n');buf=ls.pop();
     for(const l of ls){if(!l.startsWith('data: '))continue;const d=l.slice(6);if(d==='[DONE]')continue;try{const t=JSON.parse(d).choices[0]?.delta?.content;if(t)res.write(t)}catch{}}}
    res.end();
   }catch(e){console.error(e.message);if(!res.headersSent)res.writeHead(500);res.end('Serverfehler')}
  });return}
 if(req.method==='POST'&&req.url.startsWith('/api/transcribe')){
  const ch=[];let n=0;req.on('data',c=>{n+=c.length;if(n<25e6)ch.push(c)});req.on('end',async()=>{
   try{
    if(n>=25e6){res.writeHead(413,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Aufnahme zu lang')}
    const buf=Buffer.concat(ch);if(buf.length<500){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Aufnahme zu kurz')}
    const ct=(req.headers['content-type']||'audio/webm').split(';')[0];
    const ext=ct.includes('mp4')||ct.includes('m4a')||ct.includes('aac')?'mp4':ct.includes('ogg')?'ogg':ct.includes('wav')?'wav':ct.includes('mpeg')?'mp3':'webm';
    const fd=new FormData();fd.append('file',new Blob([buf],{type:ct}),'audio.'+ext);fd.append('model',process.env.STT_MODEL||'gpt-4o-mini-transcribe');
    const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+KEY},body:fd});
    const t=await r.text();
    if(!r.ok){console.error('stt',r.status,t.slice(0,300));res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Fehler '+r.status)}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:(JSON.parse(t).text||'').trim()}));
   }catch(e){console.error(e.message);if(!res.headersSent)res.writeHead(500);res.end('Serverfehler')}
  });return}
 if(req.method==='POST'&&req.url==='/api/tts'){
  let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
   try{
    const text=String(JSON.parse(b).text||'').replace(/\*\*/g,'').slice(0,3000);if(!text){res.writeHead(400);return res.end()}
    const r=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify({model:process.env.TTS_MODEL||'gpt-4o-mini-tts',voice:process.env.TTS_VOICE||'coral',instructions:process.env.TTS_INSTRUCTIONS||'Warm, freundlich, ruhig und natürlich, wie ein persönlicher Immobilienberater im Gespräch. Deutsche Aussprache, angenehmes Tempo, leichtes Lächeln in der Stimme.',input:text,response_format:'mp3'})});
    if(!r.ok){console.error('tts',r.status,(await r.text()).slice(0,300));res.writeHead(502);return res.end('Fehler '+r.status)}
    res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));
   }catch(e){console.error(e.message);if(!res.headersSent)res.writeHead(500);res.end('Serverfehler')}
  });return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(path.join(__dirname,'public/index.html')).pipe(res);
});
srv.listen(PORT,()=>console.log('ImmoConcierge läuft auf http://localhost:'+PORT+' Modell '+MODEL));
