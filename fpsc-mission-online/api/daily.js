// Shared, date-based FPSC content cache. Requires OPENAI_API_KEY, SUPABASE_URL,
// and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.
const OFFICIAL = [
  {title:"FPSC General Recruitment Syllabi",url:"https://fpsc.gov.pk/Syllabuses?section=GR+Syllabus",note:"Official post-specific syllabus documents; match the exact advertisement and case number."},
  {title:"FPSC official homepage",url:"https://fpsc.gov.pk/",note:"Official advertisements, notices and recruitment updates."},
  {title:"FPSC Information Desk",url:"https://www.fpsc.gov.pk/InformationDesk",note:"Official recruitment instructions and candidate information."}
];
const schema = {
  type:"object",additionalProperties:false,
  properties:{status:{type:"string",enum:["ok","insufficient_verified_questions"]},message:{type:"string"},sourceStatus:{type:"string"},sources:{type:"array",items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},url:{type:"string"},note:{type:"string"}},required:["title","url","note"]}},questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{id:{type:"string"},topic:{type:"string"},question:{type:"string"},options:{type:"array",items:{type:"string"}},answerIndex:{type:"integer"},explanation:{type:"string"},verified:{type:"boolean"},sourceTitle:{type:"string"},sourceUrl:{type:"string"},evidence:{type:"string"}},required:["id","topic","question","options","answerIndex","explanation","verified","sourceTitle","sourceUrl","evidence"]}},targetDate:{type:"string"}},
  required:["status","message","sourceStatus","sources","questions","targetDate"]
};
const interviewSchema = {type:"object",additionalProperties:false,properties:{message:{type:"string"},questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{id:{type:"string"},topic:{type:"string"},question:{type:"string"},answer:{type:"string"},tip:{type:"string"},sourceTitle:{type:"string"},sourceUrl:{type:"string"}},required:["id","topic","question","answer","tip","sourceTitle","sourceUrl"]}},targetDate:{type:"string"}},required:["message","questions","targetDate"]};
function cleanUrl(u){try{const x=new URL(u);return x.protocol==="https:"&&(x.hostname==="fpsc.gov.pk"||x.hostname==="www.fpsc.gov.pk");}catch{return false}}
function stableId(q){return String(q.id||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,100)}
function validDate(d){return /^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+"T00:00:00Z"))&&new Date(d+"T00:00:00Z").toISOString().slice(0,10)===d}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function dbHeaders(extra={}){return {apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,"Content-Type":"application/json",...extra}}
async function db(path,options={}){
  const base=String(process.env.SUPABASE_URL||"").replace(/\/$/,"");
  const r=await fetch(base+path,{...options,headers:dbHeaders(options.headers||{})});
  const raw=await r.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok)throw new Error(`Shared database error (${r.status}): ${typeof data==="string"?data:JSON.stringify(data)}`);
  return data;
}
async function getSaved(date,kind){
  const rows=await db(`/rest/v1/fpsc_daily_sets?set_date=eq.${encodeURIComponent(date)}&kind=eq.${encodeURIComponent(kind)}&select=set_date,kind,focus,data,generated_at`);
  return Array.isArray(rows)&&rows.length?rows[0]:null;
}
async function markJob(date,kind,status){
  await db(`/rest/v1/fpsc_daily_jobs?set_date=eq.${encodeURIComponent(date)}&kind=eq.${encodeURIComponent(kind)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({status,updated_at:new Date().toISOString()})});
}
module.exports = async (req,res)=>{
  res.setHeader("Cache-Control","no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="POST")return res.status(405).json({error:"Use POST."});
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:"Daily online service is not configured. Add OPENAI_API_KEY in Vercel environment variables."});
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:"Shared cache is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables, then redeploy."});
  const body=req.body||{};
  const kind=body.kind==="interview"?"interview":"mcq";
  const date=String(body.date||new Date().toISOString().slice(0,10));
  if(!validDate(date))return res.status(400).json({error:"Choose a valid date in YYYY-MM-DD format."});
  const focus=String(body.focus||"customs").slice(0,80);
  const count=Math.max(1,Math.min(kind==="interview"?8:30,Number(body.count)||30));
  const model=process.env.OPENAI_MODEL||"gpt-4.1-mini";
  try{
    let saved=await getSaved(date,kind);
    if(saved)return res.status(200).json({...saved.data,cached:true,targetDate:date,savedFocus:saved.focus,generatedAt:saved.generated_at});

    // Atomic SQL RPC coordinates all visitors and enforces a global maximum of
    // two generation attempts per UTC calendar day across all dates and users.
    const claim=await db("/rest/v1/rpc/fpsc_claim_generation",{method:"POST",body:JSON.stringify({p_target_date:date,p_kind:kind})});
    const claimStatus=typeof claim==="string"?claim:claim?.status;
    if(claimStatus==="cached"){
      saved=await getSaved(date,kind);
      if(saved)return res.status(200).json({...saved.data,cached:true,targetDate:date,savedFocus:saved.focus,generatedAt:saved.generated_at});
    }
    if(claimStatus==="busy"){
      for(let i=0;i<12;i++){await pause(750);saved=await getSaved(date,kind);if(saved)return res.status(200).json({...saved.data,cached:true,targetDate:date,savedFocus:saved.focus,generatedAt:saved.generated_at});}
      return res.status(202).json({error:"Another visitor is generating this date's shared set. Please load this date again in a few seconds.",targetDate:date,busy:true});
    }
    if(claimStatus==="limit_reached")return res.status(429).json({error:"Today's shared generation limit (2 new sets per UTC day) has been reached. Already saved dates remain available to everyone. Try again after the UTC day resets, or choose a date with a saved set.",targetDate:date,limitReached:true});
    if(claimStatus!=="claimed")return res.status(503).json({error:"Could not reserve a shared generation slot. Please retry shortly."});

    const priorRows=await db(`/rest/v1/fpsc_daily_sets?kind=eq.${encodeURIComponent(kind)}&select=data&limit=1000`);
    const seen=[...new Set((Array.isArray(priorRows)?priorRows:[]).flatMap(row=>(row.data?.questions||[]).map(q=>String(q.id||"")).filter(Boolean)))].slice(-500);
    const common=`You are an evidence-first FPSC preparation researcher. The requested study-set date is ${date}; this is the date label the user selected, not a claim that sources were published on that date. Browse using web_search. Prioritize official FPSC domains (fpsc.gov.pk and www.fpsc.gov.pk). The official FPSC general recruitment syllabus page is ${OFFICIAL[0].url}. Never invent a source, official paper, answer key, quote, or question. If official past-paper wording cannot be found in an accessible official FPSC source, do not label a generated question as an official past-paper question. Do not use coaching websites, social media, unofficial solved papers, or memory as proof of official wording. Never claim a source contains exact question wording when it does not. Exclude IDs supplied as seen. Keep answers evidence-based and explain them clearly.`;
    let instructions,format,input;
    if(kind==="interview"){
      instructions=`${common}\nCreate up to ${count} interview preparation questions relevant to FPSC BS-16/17 recruitment, prioritizing ${focus}, Customs/Intelligence, ASF, investigation and public-service ethics. FPSC generally does not publish a universal official interview question bank. Clearly treat prompts and model answers as original preparation, not official verbatim questions. Browse official job descriptions, syllabi and laws when useful. Return JSON only.`;
      format={type:"json_schema",name:"fpsc_interview_set",strict:true,schema:interviewSchema};
      input=`Create the shared interview preparation set for ${date}.`;
    }else{
      instructions=`${common}\nTask: create a shared MCQ feed for date=${date}, focus=${focus}; target=${count}. The user wants VERIFIED FPSC PAST-PAPER QUESTIONS ONLY when official wording is available. Include only question wording visibly present in an official FPSC-published paper, answer key or official source that genuinely includes the question. Link the original official source and state a precise page/section locator in evidence. If wording or answer cannot be verified, omit the item. Do not pad to target with invented questions. If fewer than target can be verified, set status=insufficient_verified_questions, explain the shortage and return only verified items. Four options, one answer index 0-3, detailed explanation, stable unique ID and source URL/title. Avoid seen IDs. The set may contain zero questions. Return JSON only.`;
      format={type:"json_schema",name:"fpsc_daily_mcqs",strict:true,schema};
      input=`Find official FPSC past-paper questions for the shared study set labelled ${date}. Seen IDs: ${JSON.stringify(seen)}`;
    }
    const upstream=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,tools:[{type:"web_search"}],tool_choice:"auto",instructions,input,text:{format}})});
    const raw=await upstream.json();
    if(!upstream.ok){await markJob(date,kind,"failed");return res.status(502).json({error:raw?.error?.message||"The online question provider failed. Check API key, billing and model access."});}
    const out=(raw.output||[]).filter(x=>x.type==="message").flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text||raw.output_text;
    if(!out){await markJob(date,kind,"failed");return res.status(502).json({error:"The online provider returned no structured answer. Please retry if a daily slot remains."});}
    let data;try{data=JSON.parse(out)}catch{await markJob(date,kind,"failed");return res.status(502).json({error:"Could not parse the online provider response. Please retry if a daily slot remains."});}
    data.targetDate=date;
    if(kind==="mcq"){
      data.questions=(data.questions||[]).filter(q=>{q.id=stableId(q);return q.id&&q.verified===true&&cleanUrl(q.sourceUrl)&&Array.isArray(q.options)&&q.options.length===4&&Number.isInteger(q.answerIndex)&&q.answerIndex>=0&&q.answerIndex<4;});
      if(data.questions.length<count){data.status="insufficient_verified_questions";if(!data.message)data.message=`Only ${data.questions.length} questions passed source checks; no unverified questions were added.`;}
      data.sources=[...(data.sources||[]),...OFFICIAL].filter((s,i,a)=>s.url&&a.findIndex(t=>t.url===s.url)===i);
    }else data.questions=(data.questions||[]).filter(q=>q.question&&q.answer);

    const generatedAt=new Date().toISOString();
    await db("/rest/v1/fpsc_daily_sets",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({set_date:date,kind,focus,data,generated_at:generatedAt})});
    await markJob(date,kind,"done");
    return res.status(200).json({...data,cached:false,targetDate:date,savedFocus:focus,generatedAt});
  }catch(e){
    // Don't leak credentials. A DB outage should be visible enough to diagnose in Vercel logs.
    console.error("FPSC daily API error:",e?.message||e);
    return res.status(503).json({error:"The shared daily service is temporarily unavailable. Check Supabase configuration and Vercel function logs."});
  }
};
