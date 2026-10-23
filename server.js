const http=require('http'),fs=require('fs'),path=require('path');
const KEY=process.env.LLM_API_KEY, PORT=process.env.PORT||8787, MODEL=process.env.LLM_MODEL||'gpt-4o-mini';
if(!KEY){console.error('LLM_API_KEY fehlt');process.exit(1)}
const SYS=`Du bist der KI-Concierge von ImmoConcierge, einem neutralen Immobilien-Service an der Costa del Sol (Pilot: Marbella und Umgebung). Du bist unabhängig vom Portfolio einzelner Makler und empfiehlst, was für den Käufer am besten passt.
Statt Suchmaske führst du ein freundliches Gespräch und erfasst ein Lebensprofil: Nutzungszweck (Eigennutzung/Ferien/Investment/Altersruhesitz), Budget, Familie/Kinder und Schule (international/deutsch), Homeoffice/Glasfaser, max. Fahrzeit zum Flughafen Málaga, Golf/Sport, Strand vs. Ruhe/Natur, Regionen-Präferenz.
Regeln: Immer nur EINE kurze Frage pro Nachricht (1-3 Sätze). Antworte in der Sprache des Nutzers (Deutsch: duzen/"ihr" je nach Nutzer). Wenn genug Infos da sind (meist nach 5-7 Antworten), gib eine kurze Zusammenfassung des Lebensprofils (Stichpunkte) und 2-3 Regionsvorschläge (z. B. Marbella/Nueva Andalucía, Estepona, Benahavís, Mijas, Fuengirola, Benalmádena, Sotogrande, Málaga) mit je Vor- und Nachteilen – klar als unverbindliche erste Einschätzung. Erfinde KEINE konkreten Objekte, Adressen oder Preise einzelner Immobilien; sag stattdessen, dass das Team vor Ort passende Objekte aus dem ganzen Markt kuratiert und eine Besichtigungstour organisiert. Keine Rechts- oder Steuerberatung; verweise dafür auf Partner-Anwälte (der Due-Diligence-Check ist eine Vorprüfung). Kein Markdown außer einfachen Stichpunkten mit "-" und **fett**.`;
const srv=http.createServer(async(req,res)=>{
 if(req.method==='POST'&&req.url==='/api/chat'){
  let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
   try{
    const msgs=(JSON.parse(b).messages||[]).slice(-30).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:String(m.content).slice(0,4000)}));
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify({model:MODEL,stream:true,temperature:0.6,messages:[{role:'system',content:SYS},...msgs]})});
    if(!r.ok){const t=await r.text();console.error('upstream',r.status,t.slice(0,300));res.writeHead(502,{'Content-Type':'text/plain'});return res.end('Fehler '+r.status)}
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-cache'});
    const dec=new TextDecoder();let buf='';
    for await(const ch of r.body){buf+=dec.decode(ch,{stream:true});const ls=buf.split('\n');buf=ls.pop();
     for(const l of ls){if(!l.startsWith('data: '))continue;const d=l.slice(6);if(d==='[DONE]')continue;try{const t=JSON.parse(d).choices[0]?.delta?.content;if(t)res.write(t)}catch{}}}
    res.end();
   }catch(e){console.error(e.message);if(!res.headersSent)res.writeHead(500);res.end('Serverfehler')}
  });return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});fs.createReadStream(path.join(__dirname,'public/index.html')).pipe(res);
});
srv.listen(PORT,()=>console.log('ImmoConcierge läuft auf http://localhost:'+PORT+' Modell '+MODEL));
