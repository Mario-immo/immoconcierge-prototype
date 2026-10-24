const http=require('http'),fs=require('fs'),path=require('path');
const PROPS=require('./props');
const KEY=process.env.LLM_API_KEY, PORT=process.env.PORT||8787, MODEL=process.env.LLM_MODEL||'gpt-4o-mini';
if(!KEY){console.error('LLM_API_KEY fehlt');process.exit(1)}
const SYS=`Du bist der KI-Concierge von ImmoConcierge, einem neutralen Immobilien-Service an der Costa del Sol (Pilot: Marbella und Umgebung). Du bist unabhängig vom Portfolio einzelner Makler.
Stil: Deutsch (oder Sprache des Nutzers), du-Form (bei Paaren/Familien "ihr" ist ok), warm, persönlich, kurz: 1-3 Sätze, immer nur EINE Frage pro Nachricht. Kurz auf die Antwort eingehen, dann die nächste Frage. Kein Markdown außer **fett**.
Gesprächsablauf (insgesamt ca. 6-8 Fragen; überspringe, was der Nutzer schon gesagt hat):
1. Lebenssituation & Zweck (wer zieht/kommt, Eigennutzung/Ferien/Investment/Ruhestand).
2. Budget.
3. Region(en) – wenn unsicher, kurz 2-3 passende Regionen nennen (Marbella, Nueva Andalucía, Estepona, Benahavís, Mijas, Fuengirola, Benalmádena, Sotogrande, Málaga).
4. Objektart – nenne immer alle drei: "Was suchst du: Haus/Villa, Reihenhaus/Townhouse oder Wohnung? Und wie viele Schlafzimmer?"
5. Ausstattung in EINER Frage, passend zur Objektart. Nenne immer Fitnessstudio mit. Bei Wohnung z.B.: "Viele Wohnungen liegen in gepflegten Wohnanlagen mit Pools, Fitnessstudio und Gärten – da musst du dich um nichts kümmern. Was ist dir wichtig: Pool, Fitnessstudio, Parkplatz/Auto, Fahrstuhl, Gartenwohnung?" Bei Haus: eigener Pool, Garten, Parkplatz/Garage, Wohnanlage mit Security?
6. Lebensstil in EINER Frage: Strand zu Fuß, oft Besuch (Gästezimmer), Sport (Golf, Tennis oder Padel – an der Costa del Sol sehr verbreitet, Padel ist der Schlägersport), Homeoffice, Schule für Kinder (nur fragen, was noch offen ist; Flughafennähe darf mit rein).
7. Zeitrahmen & Finanzierung in EINER Frage: Wann möchtest du kaufen, und ist die Finanzierung/das Eigenkapital schon geklärt?
Sobald Frage 7 beantwortet ist, MUSST du SOFORT search_properties mit dem kompletten Profil aufrufen – frage NIE nach Name oder Kontakt, bevor die Karten gezeigt wurden. Die UI zeigt 3 Objekte als Karten mit Scoring. Deine Antwort danach: NIEMALS Objekte, Preise, Regionen oder Scores der Karten wiederholen oder aufzählen. Sag sinngemäß nur: "Hier sind schon mal ein paar gute Angebote – es sind Beispielobjekte (Demo). Unsere Kollegen vor Ort schauen sich das nochmal an und machen ggf. weitere Vorschläge. Hast du schon selbst Objekte gefunden? Dann schick uns gern den Link, wir prüfen sie und nehmen sie mit in die Auswahl auf."
Wenn der Nutzer Links schickt: kurz bestätigen ("Danke, notiert – wir prüfen das Objekt und nehmen es in die Auswahl auf"), nichts über den Inhalt erfinden, fragen ob es noch weitere gibt. Wenn keine (weiteren) Links: zum Kontakt übergehen.
Kontakt: Frage zuerst nach dem Vornamen ("Damit wir dir die Auswahl schicken können: Wie heißt du?"). Dann: "Möchtest du die Angebote per E-Mail oder WhatsApp?" Sobald Name und Kanal bekannt sind, rufe request_contact auf (die UI zeigt dann Eingabefeld, Datenschutz-Einwilligung und Verifizierung). Danach antworte nur mit einem kurzen Satz wie "Super, trag deine Daten einfach unten ein."
Erfinde nie Objekte außerhalb des Tools. Rufe search_properties erneut nur, wenn sich das Profil ändert oder neue Vorschläge gewünscht sind. Keine Rechts- oder Steuerberatung (Verweis auf Partner-Anwälte; der Due-Diligence-Check ist nur eine Vorprüfung).`;

const B=d=>({type:'boolean',description:d});
const TOOLS=[{type:'function',function:{name:'search_properties',description:'Sucht und bewertet Objekte passend zum Profil. Gibt Top 3 zurück.',parameters:{type:'object',properties:{
 situation:{type:'string',description:'Kurz: Lebenssituation, z.B. Familie mit 2 Kindern aus München'},
 purpose:{type:'string',enum:['eigennutzung','ferien','investment','ruhestand']},budget_max:{type:'number',description:'Max. Budget in EUR'},
 regions:{type:'array',items:{type:'string'}},property_type:{type:'string',enum:['haus','reihenhaus','wohnung','egal']},bedrooms_min:{type:'number'},
 pool:B('Pool wichtig'),gym:B('Fitnessstudio wichtig'),parking:B('Auto/Parkplatz nötig'),elevator:B('Fahrstuhl wichtig'),garden:B('Garten/Gartenwohnung wichtig'),community:B('Gepflegte Wohnanlage mit Annehmlichkeiten gewünscht'),
 beach_near:B('Strand zu Fuß'),guests:B('Oft Besuch, Gästezimmer'),golf:B(''),tennis:B('Tennis wichtig'),padel:B('Padel (Schlägersport) wichtig'),homeoffice:B(''),kids_school:B('Kinder/Schule wichtig'),sea_view:B(''),quiet:B('Ruhe/Natur'),
 airport_max_min:{type:'number',description:'Max. Minuten zum Flughafen Málaga'},
 timeline:{type:'string',description:'Wann kaufen, z.B. in 3-6 Monaten'},financing:{type:'string',description:'z.B. Eigenkapital vorhanden / Finanzierung offen'}},required:['budget_max','property_type','timeline','financing']}}},
 {type:'function',function:{name:'request_contact',description:'Zeigt das Kontaktformular mit Einwilligung und Verifizierung, sobald Name und Kanal bekannt sind.',parameters:{type:'object',properties:{name:{type:'string'},channel:{type:'string',enum:['email','whatsapp']}},required:['name','channel']}}}];
const cl=x=>Math.max(0,Math.min(100,Math.round(x)));
function score(p,q){
 const b=q.budget_max||1e9;const budget=p.price<=b?(p.price>=b*0.6?100:80):cl(100-(p.price/b-1)*250);
 let lage=60;if(q.regions&&q.regions.length){lage=q.regions.some(r=>p.region.toLowerCase().includes(String(r).toLowerCase().split(/[ –-]/)[0]))?100:45}
 if(q.sea_view)lage+=p.sea?10:-15;if(q.beach_near)lage+=p.beach<=1.5?10:-15;if(q.quiet)lage+=p.beach>3?10:-5;lage=cl(lage);
 const t=q.property_type&&q.property_type!=='egal'?q.property_type:null;const art=t?(p.kind===t?100:(t==='haus'&&p.kind==='reihenhaus')||(t==='reihenhaus'&&p.kind==='haus')?55:25):80;
 const want=[['pool','pool'],['gym','gym'],['parking','parking'],['elevator','elevator'],['garden','garden'],['community','community']].filter(([k])=>q[k]);
 const aus=want.length?cl(want.filter(([,f])=>p[f]).length/want.length*100):80;
 const fam=cl((q.kids_school?100-(p.school-3)*8:80)-(q.bedrooms_min&&p.bed<q.bedrooms_min?30:0)+(q.guests?(p.guest?10:-25):0));
 const ho=q.homeoffice?(p.fiber?(p.bed>=3?100:80):35):85;
 const golf=q.golf?cl(100-p.golf*10):75;
 const am=q.airport_max_min||60;const air=p.airport<=am?cl(100-p.airport/4+10):cl(70-(p.airport-am)*3);
 const tennis=q.tennis?cl(100-p.tennis*12):75;const padel=q.padel?cl(100-p.padel*12):75;
 const sp=[q.golf&&golf,q.tennis&&tennis,q.padel&&padel].filter(x=>x!==false&&x!==undefined);const sport=sp.length?sp.reduce((a,b)=>a+b,0)/sp.length:75;
 const lb=cl((sport+ho+air)/3);
 const w={budget:3,art:t?3:0.5,lage:2,aus:want.length?2:0.5,fam:(q.kids_school||q.guests)?1.5:0.5,lb:1.5};
 const sub={Budget:budget,Objektart:art,Lage:lage,Ausstattung:aus,'Familie/Gäste':fam,'Sport/Lifestyle':lb};
 const tw=w.budget+w.art+w.lage+w.aus+w.fam+w.lb;
 const total=Math.round((budget*w.budget+art*w.art+lage*w.lage+aus*w.aus+fam*w.fam+lb*w.lb)/tw);
 const why=[];if(p.price<=b)why.push('im Budget');if(t&&p.kind===t)why.push('gewünschte Objektart');if(p.community&&(q.community||q.gym||q.pool))why.push('gepflegte Anlage'+(p.gym?' mit Gym':''));
 if(q.garden&&p.garden)why.push('Garten');if(q.parking&&p.parking)why.push('Parkplatz');if(q.elevator&&p.elevator)why.push('Fahrstuhl');if(q.guests&&p.guest)why.push('Gästezimmer');
 if(q.golf&&p.golf<=1)why.push('Golf in '+p.golf+' km');if(q.tennis&&p.tennis<=1.5)why.push('Tennis in '+p.tennis+' km');if(q.padel&&p.padel<=1.5)why.push('Padel in '+p.padel+' km');if(q.kids_school&&p.school<=6)why.push('int. Schule in '+p.school+' km');
 if(q.homeoffice&&p.fiber)why.push('Glasfaser');if(q.beach_near&&p.beach<=1.5)why.push('Strand '+p.beach+' km');if(p.airport<=am)why.push(p.airport+' Min. Flughafen');
 return {...p,total,sub,why:why.length?'Passt, weil: '+why.slice(0,5).join(', ')+'.':'Solide Alternative zum Profil.'};
}
function search(q){return PROPS.map(p=>score(p,q)).sort((a,b)=>b.total-a.total).slice(0,3)}
async function oa(body){const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify(body)});if(!r.ok){const t=await r.text();throw new Error('upstream '+r.status+' '+t.slice(0,200))}return r}
const srv=http.createServer(async(req,res)=>{
 if(req.method==='POST'&&req.url==='/api/chat'){
  let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
   try{
    const msgs=(JSON.parse(b).messages||[]).slice(-30).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:String(m.content).slice(0,4000)}));
    const base=[{role:'system',content:SYS},...msgs];
    const shown=msgs.some(m=>m.role==='assistant'&&m.content.includes('[3 Beispielobjekte'));
    const lastA=[...msgs].reverse().find(m=>m.role==='assistant');
    const force=!shown&&(msgs.filter(m=>m.role==='user').length>=8||(lastA&&/finanzier|eigenkapital/i.test(lastA.content)));
    const j=await (await oa({model:MODEL,temperature:0.6,messages:base,tools:TOOLS,...(force?{tool_choice:{type:'function',function:{name:'search_properties'}}}:{})})).json();
    const m=j.choices[0].message;
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-cache'});
    if(!m.tool_calls){res.write(m.content||'');return res.end()}
    const tc=m.tool_calls[0];let q={};try{q=JSON.parse(tc.function.arguments)}catch{}
    let toolRes;
    if(tc.function.name==='request_contact'){res.write('\u0001'+JSON.stringify({kind:'contact',name:String(q.name||'').slice(0,60),channel:q.channel==='whatsapp'?'whatsapp':'email'})+'\u0002');toolRes={ok:true,ui:'Kontaktformular angezeigt'}}
    else{const top=search(q);res.write('\u0001'+JSON.stringify({kind:'cards',items:top,profile:q})+'\u0002');toolRes={demo:true,shown_as_cards:true,count:top.length,note:'Karten NICHT im Text wiederholen.'}}
    const r=await oa({model:MODEL,stream:true,temperature:0.6,messages:[...base,{role:'assistant',content:m.content||null,tool_calls:[tc]},{role:'tool',tool_call_id:tc.id,content:JSON.stringify(toolRes)}]});
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
    const r=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify({model:process.env.TTS_MODEL||'gpt-4o-mini-tts',voice:process.env.TTS_VOICE||'sage',instructions:process.env.TTS_INSTRUCTIONS||'Warm, freundlich, ruhig und natürlich, wie ein persönlicher Immobilienberater im Gespräch. Deutsche Aussprache, angenehmes Tempo, leichtes Lächeln in der Stimme.',input:text,response_format:'mp3'})});
    if(!r.ok){console.error('tts',r.status,(await r.text()).slice(0,300));res.writeHead(502);return res.end('Fehler '+r.status)}
    res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));
   }catch(e){console.error(e.message);if(!res.headersSent)res.writeHead(500);res.end('Serverfehler')}
  });return}
 const im=/^\/img\/([a-z0-9-]+\.webp)$/.exec(req.url.split('?')[0]);if(im){const f=path.join(__dirname,'public/img',im[1]);if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public, max-age=86400'});return fs.createReadStream(f).pipe(res)}res.writeHead(404);return res.end()}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(path.join(__dirname,'public/index.html')).pipe(res);
});
srv.listen(PORT,()=>console.log('ImmoConcierge läuft auf http://localhost:'+PORT+' Modell '+MODEL));
