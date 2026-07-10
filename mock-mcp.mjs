/**
 * YPmcn MCP Server — DB-backed read & write 2.1.4
 *
 * search_creators: 读真实 DB → 写入 creator_candidate_pool (kw_uid 列匹配)
 * rank_mcns: 读 creator_candidate_pool → 写入 mcn_recommendation_items (按 candidate_count 排序)
 * validate_requirement: 写入 customer_demands (真 DB)
 * create_with_distributions: 查询供应商企微群 → 真实发送企微通知 (webhook/corp API)
 * 其他写操作: mock 返回 + workflow_state
 */
import http from "node:http";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import mysql from "mysql2/promise";
import { lookupSupplierWecomGroup } from "./src/send_wecom.mjs";

const PORT = 19876, LOG = "/tmp/mock-mcp-log.jsonl";

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}
const DB = { host:"d-oa-test.eshypdata.com",port:3306,user:"ypmcn",password:requiredEnv("MYSQL_PASSWORD"),database:"ypmcn",connectTimeout:5000 };

// 后端 API 配置 — 转发 create_with_distributions 到后端，由后端发送企微
const BACKEND_API_URL = process.env.YPMCN_BACKEND_URL || "https://ypmcn.eshypdata.com";
const BACKEND_API_KEY = requiredEnv("YPMCN_API_KEY", "YP_WECOM_API_KEY");

let pool=null;
async function getPool(){if(!pool)pool=mysql.createPool({...DB,waitForConnections:true,connectionLimit:3});return pool;}
function tid(p){return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;}
function log(id,m,p){writeFileSync(LOG,JSON.stringify({t:Date.now(),id,method:m,params:p})+"\n",{flag:"a"});}

const TOOLS=[
  {name:"validate_requirement",description:"写入 customer_demands (真DB)",inputSchema:{type:"object",properties:{platform:{type:"string"},quantity_total:{type:"number"},submission_deadline_at:{type:"string"},budget_min_cents:{type:"number"},budget_max_cents:{type:"number"},budget_raw:{type:"string"},rebate_min_rate:{type:"number"},rebate_max_rate:{type:"number"},rebate_raw:{type:"string"},raw_messages:{type:"array",items:{type:"object"}},raw_messages_json:{type:"string"},category_requirements:{type:"array",items:{type:"string"}},project_name:{type:"string"},brand:{type:"string"},product:{type:"string"},existing_demand_id:{type:"string"},existing_demand_version:{type:"integer"}}}},
  {name:"search_creators",description:"搜索创作者 (真DB: 读需求表 + 匹配创作者 + 写入候选池)",inputSchema:{type:"object",properties:{id:{type:"string"},demand_id:{type:"string"},demand_version:{type:"number"},platform:{type:"string"}}}},
  {name:"rank_mcns",description:"MCN排序 (真DB: 读候选池聚合; mock写)",inputSchema:{type:"object",properties:{id:{type:"string"},demand_id:{type:"string"},demand_version:{type:"number"},platform:{type:"string"},medium_risk_confirmed:{type:"boolean"}}}},
  {name:"create_with_distributions",description:"创建分发",inputSchema:{type:"object",properties:{id:{type:"string"},projectName:{type:"string"},deadline:{type:"string"},remindAt:{type:"string"},usageScope:{type:"string"},supplierIds:{type:"array",items:{type:"string"}},sendWechatNotification:{type:"boolean"},preview_only:{type:"boolean"},prefillRowsBySupplier:{type:"object"}},required:["deadline","supplierIds"]}},
  {name:"ingest_mcn_submissions",description:"导入回填",inputSchema:{type:"object",properties:{inquiry_id:{type:"string"},items:{type:"array",items:{type:"object"}}}}},
  {name:"manual_source_creators",description:"达人拓展导入",inputSchema:{type:"object",properties:{id:{type:"string"},manual_results:{type:"array",items:{type:"object"}}}}},
  {name:"rank_creators",description:"精排",inputSchema:{type:"object",properties:{id:{type:"string"},ranking_strategy:{type:"string"},demand_id:{type:"string"},demand_version:{type:"number"}}}},
  {name:"create_submission_batch",description:"创建提报批次",inputSchema:{type:"object",properties:{run_id:{type:"string"},allow_need_confirm_with_risk:{type:"boolean"}}}},
  {name:"record_client_feedback",description:"客户反馈",inputSchema:{type:"object",properties:{run_id:{type:"string"},feedback_items:{type:"array",items:{type:"object"}}}}},
  {name:"get_creator_detail",description:"获取创作者详情 (真DB)",inputSchema:{type:"object",properties:{creator_id:{type:"string"},platform:{type:"string"},platform_account_id:{type:"string"}}}},
  {name:"get_recommendation_run_detail",description:"推荐运行详情",inputSchema:{type:"object",properties:{run_id:{type:"string"}}}},
  {name:"audit_manual_adjustment",description:"审核调整",inputSchema:{type:"object",properties:{run_id:{type:"string"},adjustments:{type:"array",items:{type:"object"}},operator_id:{type:"string"}}}},
  {name:"business_health",description:"系统状态 (含真DB统计)",inputSchema:{type:"object",properties:{}}},
];

// ---- DB operations ----

async function dbValidateRequirement(p){
  const missing=[];
  if(!p?.platform)missing.push("platform");
  if(!p?.submission_deadline_at)missing.push("submission_deadline_at");
  if(!(p?.quantity_total>0))missing.push("quantity_total");
  if(!(p?.budget_max_cents>0||p?.budget_min_cents>=0))missing.push("budget_max_cents");
  if(!(p?.rebate_max_rate>=0||p?.rebate_min_rate>=0))missing.push("rebate_max_rate");
  if(!(p?.raw_messages||p?.raw_messages_json))missing.push("raw_messages");
  if(missing.length)return{success:true,data:{status:"draft",missing_fields:missing,clarifying_questions:missing.map(f=>`请补充 ${f}`)},error:null};
  try{
    const db=await getPool(),demandId=tid("dmd"),rawJson=p.raw_messages?JSON.stringify(p.raw_messages):(p.raw_messages_json||"[]");

    // 从需求文本推断表单字段
    const rawText = (p.raw_messages||[]).map(m=>m.content||"").join(" ") + (p.raw_messages_json||"");
    const suggestedColumns = buildSuggestedColumns(rawText, p.platform);

    await db.query("INSERT INTO customer_demands (id,demand_id,demand_version,platform,submission_deadline_at,submission_deadline_raw,raw_messages_json,budget_min_cents,budget_max_cents,budget_raw,rebate_min_rate,rebate_max_rate,rebate_raw,quantity_total,status,project_name,brand,product,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?,NOW(),NOW())",[demandId,demandId,p.platform,p.submission_deadline_at,p.submission_deadline_at||"",rawJson,p.budget_min_cents||0,p.budget_max_cents,p.budget_raw||"",p.rebate_min_rate||0,p.rebate_max_rate||0,p.rebate_raw||"",p.quantity_total,p.project_name||null,p.brand||null,p.product||null]);
    return{success:true,data:{id:demandId,demand_id:demandId,demand_version:1,status:"ready",suggested_columns:suggestedColumns,requirement_parsed:{platform:p.platform,quantity_total:p.quantity_total,budget_min_cents:p.budget_min_cents||0,budget_max_cents:p.budget_max_cents,budget_raw:p.budget_raw||"",rebate_min_rate:p.rebate_min_rate||0,rebate_max_rate:p.rebate_max_rate||0,rebate_raw:p.rebate_raw||"",submission_deadline_at:p.submission_deadline_at}},error:null,workflow_state:{phase:"requirement_ready",pending_gate:"confirm-structured-brief",allowed_actions:["search_creators"]}};
  }catch(e){return{success:false,data:null,error:`DB: ${e.message}`};}
}

// 从需求文本推断表单字段
function buildSuggestedColumns(rawText, platform){
  const cols = [
    {key:"talentName",name:"达人名称",type:"text",required:true,sort_order:1},
  ];
  let order = 2;
  if(platform==="xhs"||platform==="dy"||rawText.includes("平台")){
    cols.push({key:"platform",name:"平台",type:"single_select",required:true,options:["小红书","抖音"],sort_order:order++});
  }
  if(rawText.includes("粉丝")||rawText.includes("follower")){
    cols.push({key:"followers",name:"粉丝数",type:"number",required:false,sort_order:order++});
  }
  if(rawText.includes("互动")||rawText.includes("点赞")||rawText.includes("评论")||rawText.includes("engagement")){
    cols.push({key:"avgInteract",name:"近30天互动量",type:"number",required:false,sort_order:order++});
  }
  if(rawText.includes("内容类型")||rawText.includes("图文")||rawText.includes("视频")){
    cols.push({key:"contentType",name:"内容类型",type:"single_select",required:false,options:["图文","视频","直播","混合"],sort_order:order++});
  }
  if(rawText.includes("垂类")||rawText.includes("赛道")||rawText.includes("品类")){
    cols.push({key:"category",name:"垂类/赛道",type:"text",required:false,sort_order:order++});
  }
  cols.push({key:"price",name:"报价",type:"number",required:true,sort_order:order++});
  cols.push({key:"homepage",name:"主页链接",type:"link",required:false,sort_order:order++});
  return cols;
}

// --- Vector Search Module (real BAAI/bge-large-zh-v1.5, 1024-dim) ---

const VECTOR_INDEX_PATH = "/tmp/ypmcn-vectors-real.json";

function cosineSim(a,b){
  let dot=0,nA=0,nB=0;
  for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];nA+=a[i]*a[i];nB+=b[i]*b[i];}
  return nA>0&&nB>0?dot/(Math.sqrt(nA)*Math.sqrt(nB)):0;
}
function tokenizeVec(text){
  const tokens=[];
  const words=text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
  tokens.push(...words);
  for(const ch of text){if(ch.trim().length>0)tokens.push(ch);}
  return tokens;
}

let _vectorIndex=null;
function loadVectorIndex(){
  if(_vectorIndex)return _vectorIndex;
  if(!existsSync(VECTOR_INDEX_PATH)){console.error("[vector] index not found at",VECTOR_INDEX_PATH);return null;}
  const data=JSON.parse(readFileSync(VECTOR_INDEX_PATH,"utf-8"));
  _vectorIndex=data.points;
  console.error(`[vector] loaded ${_vectorIndex.length} vectors (${_vectorIndex[0]?.vector?.length||'?'}-dim, ${data.model||'unknown'})`);
  return _vectorIndex;
}

async function realEmbed(texts){
  const apiKey=process.env.SILICONFLOW_API_KEY;
  if(!apiKey){console.error("[vector] SILICONFLOW_API_KEY not set");return null;}
  const resp=await fetch("https://api.siliconflow.cn/v1/embeddings",{
    method:"POST",
    headers:{"Authorization":`Bearer ${apiKey}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:"BAAI/bge-large-zh-v1.5",input:texts,encoding_format:"float"}),
    signal:AbortSignal.timeout(15000),
  });
  if(!resp.ok)throw new Error(`embedding HTTP ${resp.status}`);
  return (await resp.json()).data.sort((a,b)=>a.index-b.index).map(d=>d.embedding);
}

async function vectorSearch(queryText,limit=200){
  const points=loadVectorIndex();
  if(!points||points.length===0)return new Map();

  // Real embedding for query
  let qVec;
  try{
    const vecs=await realEmbed([queryText]);
    if(!vecs||!vecs[0])return new Map();
    qVec=vecs[0];
  }catch(e){console.error("[vector] embed failed:",e.message);return new Map();}

  // Cosine similarity search
  const denseResults=points.map(p=>({kw_uid:p.payload.kw_uid,score:cosineSim(qVec,p.vector)}));
  denseResults.sort((a,b)=>b.score-a.score);

  // BM25 search (unchanged)
  const k1=1.2,b=0.75;
  const queryTokens=tokenizeVec(queryText);
  const dm=points.map(p=>({kw_uid:p.payload.kw_uid,tokens:tokenizeVec([...p.payload.raw_tags,p.payload.normalized_text].join(" "))}));
  const N=dm.length,totalLen=dm.reduce((s,d)=>s+d.tokens.length,0),avgDocLen=totalLen/N;
  const dfMap=new Map();
  for(const doc of dm){const seen=new Set();for(const t of doc.tokens){if(!seen.has(t)){seen.add(t);dfMap.set(t,(dfMap.get(t)??0)+1);}}}
  const idfMap=new Map();
  for(const [term,df] of dfMap)idfMap.set(term,Math.log((N-df+0.5)/(df+0.5)+1));
  const bm25Results=dm.map(doc=>{
    const tfMap=new Map();for(const t of doc.tokens)tfMap.set(t,(tfMap.get(t)??0)+1);
    let score=0;
    for(const qt of queryTokens){const idf=idfMap.get(qt)??0;if(idf===0)continue;const tf=tfMap.get(qt)??0;score+=idf*(tf*(k1+1))/(tf+k1*(1-b+b*(doc.tokens.length/avgDocLen)));}
    return{kw_uid:doc.kw_uid,score};
  });
  bm25Results.sort((a,b)=>b.score-a.score);

  // RRF fusion
  const K=60,rrfMap=new Map();
  for(let i=0;i<denseResults.length;i++){const k=denseResults[i].kw_uid;rrfMap.set(k,(rrfMap.get(k)??0)+1/(K+i+1));}
  for(let i=0;i<bm25Results.length;i++){const k=bm25Results[i].kw_uid;rrfMap.set(k,(rrfMap.get(k)??0)+1/(K+i+1));}
  const fused=[...rrfMap.entries()].map(([kw_uid,score])=>({kw_uid,score}));
  fused.sort((a,b)=>b.score-a.score);

  const m=new Map();
  for(const r of fused.slice(0,limit))m.set(r.kw_uid,r.score);
  return m;
}

// --- Demand-aware keyword extraction ---

// Category keyword mappings for common demand types
const CATEGORY_KEYWORDS = {
  lifestyle: ["生活","日常","vlog","plog","好物","种草","分享","生活方式","lifestyle"],
  workplace: ["职场","办公","通勤","效率","打工","上班","工作"],
  relationship: ["情侣","家庭","亲子","朋友","闺蜜","夫妻"],
  growth: ["成长","女性","自我提升","学习","读书","自律"],
  home: ["家居","家装","装修","家具","软装","改造","roomtour","room tour"],
  appliance: ["家电","测评","电器","测评","评测","开箱","体验","使用感受","对比"],
  family_life: ["有娃","有宠","带娃","养娃","猫","狗","宠物","清洁","收纳","主妇","妈妈"],
  local: ["探店","打卡","本地","城市","美食","咖啡","展览","活动","逛街","周末"],
  fashion: ["穿搭","时尚","OOTD","ootd","搭配","美妆","护肤"],
};

function extractDemandProfile(demand) {
  // Parse raw_messages_json for requirement text
  let reqText = "";
  try {
    const raw = typeof demand.raw_messages_json === "string"
      ? JSON.parse(demand.raw_messages_json)
      : (demand.raw_messages_json || []);
    if (Array.isArray(raw)) reqText = raw.map(m => m.content || "").join(" ");
    else if (typeof raw === "string") reqText = raw;
  } catch (_) {
    reqText = String(demand.raw_messages_json || "");
  }

  // Combine with category_requirements if available
  let categories = [];
  try {
    if (typeof demand.category_requirements === "string") {
      categories = JSON.parse(demand.category_requirements);
    } else if (Array.isArray(demand.category_requirements)) {
      categories = demand.category_requirements;
    }
  } catch (_) {}
  const allText = (reqText + " " + categories.join(" ")).toLowerCase();

  // Extract target cities
  const CITY_NAMES = ["上海","北京","深圳","杭州","广州","成都","重庆","武汉","南京","苏州","西安","长沙","郑州","天津","厦门","青岛","大连","宁波","福州","合肥","济南","昆明","贵阳","南宁","沈阳","哈尔滨","石家庄","太原","南昌","长春","兰州","海口"];
  const foundCities = CITY_NAMES.filter(c => allText.includes(c));

  // Match category keywords
  let matchedKeywords = [];
  let matchedCategories = [];
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = keywords.filter(k => allText.includes(k));
    if (hits.length >= 2) {
      matchedCategories.push(cat);
      matchedKeywords.push(...hits);
    }
  }
  // If no category matched, use all individual keyword hits
  if (matchedKeywords.length === 0) {
    for (const [, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const hits = keywords.filter(k => allText.includes(k));
      if (hits.length > 0) matchedKeywords.push(...hits);
    }
  }

  // Budget range - convert cents to yuan for comparison with DB prices
  const budgetMinYuan = (demand.budget_min_cents || 0) / 100;
  const budgetMaxYuan = (demand.budget_max_cents || 99999999) / 100;

  return {
    cities: foundCities,
    keywords: [...new Set(matchedKeywords)],
    categories: matchedCategories,
    budgetMinYuan,
    budgetMaxYuan,
    demandText: allText
  };
}

function buildCreatorQuery(table, profile) {
  const clauses = ["date IS NOT NULL"];
  const params = [];

  // Try city + keyword combined first; fall back to keyword-only if too few results
  if (profile.cities.length > 0) {
    clauses.push(`kw_city IN (${profile.cities.map(() => '?').join(',')})`);
    params.push(...profile.cities);
  }

  if (profile.keywords.length > 0) {
    const kwClauses = profile.keywords.map(() => "content_type_label LIKE ?");
    clauses.push(`(${kwClauses.join(" OR ")})`);
    params.push(...profile.keywords.map(k => `%${k}%`));
  }

  const where = clauses.join(" AND ");
  const baseLimit = profile.keywords.length > 0 ? 300 : 100;
  const sql = `SELECT * FROM \`${table}\` WHERE ${where} LIMIT ${baseLimit}`;
  return { sql, params, hasCityFilter: profile.cities.length > 0 };
}

function computeContentMatchScore(creator, profile) {
  if (profile.keywords.length === 0) return 0.50;

  const typeLabel = (creator.content_type_label || "").toLowerCase();
  const themeLabel = (creator.content_theme_label || "").toLowerCase();
  const industryLabel = (creator.industry_tag_label || "").toLowerCase();
  const talentLabel = (creator.talent_type_label || "").toLowerCase();
  const desc = (creator.description || "").toLowerCase();
  const combined = typeLabel + " " + themeLabel + " " + industryLabel + " " + talentLabel + " " + desc;

  let hits = 0;
  for (const kw of profile.keywords) {
    if (combined.includes(kw.toLowerCase())) hits++;
  }
  return Math.round((hits / profile.keywords.length) * 100) / 100;
}

async function dbSearchCreators(p){
  if(!p?.id)return{success:false,data:null,error:"missing id"};
  try{
    const db=await getPool();
    const [dems]=await db.query("SELECT * FROM customer_demands WHERE id=?",[p.id]);
    if(!dems[0])return{success:false,data:null,error:`demand not found: ${p.id}`};
    const demand=dems[0],platform=p.platform||demand.platform||"xhs";
    const table=platform==="dy"?"dy_creator_accounts":"xhs_creator_accounts";

    // Extract demand profile and build filtered query
    const profile=extractDemandProfile(demand);
    const {sql,params:qParams,hasCityFilter}=buildCreatorQuery(table,profile);

    console.error(`[search_creators] cities=${profile.cities.join(',')||'none'} keywords=${profile.keywords.length} cats=${profile.categories.join(',')} budget=${profile.budgetMinYuan}-${profile.budgetMaxYuan}元 hasCity=${hasCityFilter}`);

    let [rows]=await db.query(sql,qParams);
    if(!Array.isArray(rows))return{success:false,data:null,error:"query failed"};

    // Fallback: if city filter yielded too few, drop city constraint
    if(hasCityFilter && rows.length < 5 && profile.keywords.length > 0){
      const {sql:sql2,params:p2}=buildCreatorQuery(table,{...profile,cities:[]});
      console.error(`[search_creators] city filter only got ${rows.length} results, falling back to keyword-only`);
      [rows]=await db.query(sql2,p2);
    }

    // Phase 1: Keyword scoring
    const keywordScored=rows.map(r=>({...r,_kwScore:computeContentMatchScore(r,profile)}))
      .filter(r=>{
        const price1=Number(r.kol_official_price_l1)||0;
        const price2=Number(r.kol_official_price_l2)||0;
        const bestPrice=price1>0&&price2>0?Math.min(price1,price2):Math.max(price1,price2);
        return !bestPrice||(bestPrice>=profile.budgetMinYuan*0.5&&bestPrice<=profile.budgetMaxYuan*2);
      });

    // Phase 2: Vector recall — build semantic query from demand + keywords
    const vecQuery=profile.demandText+" "+profile.keywords.join(" ");
    const vScores=await vectorSearch(vecQuery,200);

    // Phase 3: Fuse keyword + vector scores (normalize vec scores to [0,1])
    const KW_WEIGHT=0.4,VEC_WEIGHT=0.6;
    // Collect vector scores for normalization
    const vecScores=[];
    for(const r of keywordScored){
      const kw=r.kw_uid||r.id;
      const v=vScores.get(kw)??0;
      r._rawVec=v;vecScores.push(v);
    }
    const maxVec=Math.max(...vecScores,0.001),minVec=Math.min(...vecScores);
    const vecRange=maxVec-minVec||1;

    let vHits=0;
    for(const r of keywordScored){
      const vNorm=vecRange>0?(r._rawVec-minVec)/vecRange:0;
      if(r._rawVec>0)vHits++;
      r._vecScore=vNorm;
      r._score=Math.round((r._kwScore*KW_WEIGHT+vNorm*VEC_WEIGHT)*10000)/10000;
    }
    console.error(`[search_creators] vector: ${vHits}/${keywordScored.length} candidates, vecRange=[${minVec.toFixed(4)},${maxVec.toFixed(4)}]`);

    // Sort by fused score
    keywordScored.sort((a,b)=>b._score-a._score);
    const scored=keywordScored;

    // Stable pool ID based on demand so rank_mcns can find it
    const poolId=`pool_${demand.id}`;let inserted=0,mcnC=0,nonMcnC=0;
    await db.query("DELETE FROM creator_candidate_pool WHERE id=?",[poolId]);
    const take=Math.min(scored.length,50);
    for(let i=0;i<take;i++){
      const r=scored[i];
      const hasOrg=r.organization&&r.organization!=="";
      try{
        await db.query("INSERT INTO creator_candidate_pool (id,platform,kw_uid,mcn_id,candidate_source,hard_filter_passed,content_match_score,created_at,updated_at) VALUES (?,?,?,?,'rate_card',1,?,NOW(),NOW())",
          [poolId,platform,String(r.kw_uid||r.id||""),hasOrg?r.organization:null,r._score||0.50]);
        inserted++;if(hasOrg)mcnC++;else nonMcnC++;
      }catch(_){}
    }

    const supplyMultiplier=inserted/(demand.quantity_total||10);
    return{success:true,data:{id:poolId,candidate_pool_written:true,total_matched:inserted,total_scanned:rows.length,matched_categories:profile.categories,matched_cities:profile.cities,demand_keywords_count:profile.keywords.length,supply_assessment:{candidate_count:inserted,quantity_total:demand.quantity_total||10,supply_multiplier:Math.round(supplyMultiplier*10)/10,supply_risk_level:inserted>=5?"low_risk":"high_risk",should_start_manual_sourcing:inserted<(demand.quantity_total||10)}},error:null,workflow_state:{phase:"candidate_pool_ready",pending_gate:null,allowed_actions:["rank_mcns"]}};
  }catch(e){return{success:false,data:null,error:`DB: ${e.message}`};}
}

async function dbRankMcns(p){
  if(!p?.id)return{success:false,data:null,error:"missing id"};
  try{
    const db=await getPool();
    const [candidates]=await db.query("SELECT * FROM creator_candidate_pool WHERE id=?",[p.id]);
    if(candidates.length===0)return{success:false,data:null,error:`no candidates in pool: ${p.id}`};
    // Group by mcn_id
    const mcnMap=new Map();let nonMcnC=0;
    for(const c of candidates){
      if(c.mcn_id){if(!mcnMap.has(c.mcn_id))mcnMap.set(c.mcn_id,[]);mcnMap.get(c.mcn_id).push(c);}
      else nonMcnC++;
    }
    // Query all suppliers by name (pool stores MCN names, not UUIDs)
    const mcnNames=[...mcnMap.keys()];
    const [suppliers]=await db.query(
      `SELECT id, name, cooperation_status, default_rebate_rate, policy_rating, response_rate, valid_submission_rate, selected_rate
       FROM core_supplier WHERE name IN (${mcnNames.map(()=>'?').join(',')})`,mcnNames);
    const supplierMap=new Map(suppliers.map(s=>[s.name,s]));
    // Calculate scoring: candidate_count (weight 0.5) + rebate_rate (weight 0.5)
    // Filter out inactive/blacklisted suppliers
    const rawList=[];let maxCount=0,maxRebate=0;
    for(const [mcnId,crews] of mcnMap){
      const s=supplierMap.get(mcnId);
      // Skip inactive or blacklisted MCNs
      if(s&&(s.cooperation_status==='inactive'||s.cooperation_status==='blacklist'))continue;
      const count=crews.length;
      const rebate=s?.default_rebate_rate?Number(s.default_rebate_rate):0;
      if(count>maxCount)maxCount=count;
      if(rebate>maxRebate)maxRebate=rebate;
      rawList.push({mcn_id:mcnId,agency_name:s?.name||mcnId,supplier_name:s?.name||mcnId,count,rebate,policy_rating:s?.policy_rating||'unknown',response_rate:s?.response_rate?Number(s.response_rate):null,valid_submission_rate:s?.valid_submission_rate?Number(s.valid_submission_rate):null,selected_rate:s?.selected_rate?Number(s.selected_rate):null,cooperation_status:s?.cooperation_status||'unknown'});
    }
    const filteredOut=mcnMap.size-rawList.length;
    // Normalize and compute weighted score
    for(const r of rawList){
      const countScore=maxCount>0?r.count/maxCount:0;
      const rebateScore=maxRebate>0?r.rebate/maxRebate:0;
      r.candidate_count_score=Math.round(countScore*10000)/10000;
      r.rebate_score=Math.round(rebateScore*10000)/10000;
      r.mcn_rank_score=Math.round((countScore*0.5+rebateScore*0.5)*10000)/10000;
    }
    // Sort by composite score descending
    rawList.sort((a,b)=>b.mcn_rank_score-a.mcn_rank_score);
    // Build output list
    const mcnList=rawList.map((r,idx)=>({mcn_id:r.mcn_id,agency_name:r.agency_name,supplier_name:r.supplier_name,estimated_creator_count:r.count,rebate_rate:r.rebate,mcn_rank_score:r.mcn_rank_score,risk_notes:[]}));
    const total=candidates.length,mcnTotal=total-nonMcnC;
    const runId=tid("mcnrun");
    // Extract demand ID from pool ID: pool_dmd_xxx → dmd_xxx
    const demandId=(p.id||"").startsWith("pool_")?p.id.slice(5):p.id;
    // Write ranking results with full scoring details
    for(let i=0;i<rawList.length;i++){
      const r=rawList[i];
      const formula=JSON.stringify({weights:{candidate_count:0.5,rebate_rate:0.5},raw:{candidate_count:r.count,rebate_rate:r.rebate},normalized:{candidate_count_score:r.candidate_count_score,rebate_score:r.rebate_score}});
      const ratingInputs=JSON.stringify({policy_rating:r.policy_rating,response_rate:r.response_rate,valid_submission_rate:r.valid_submission_rate,selected_rate:r.selected_rate});
      try{
        await db.query("INSERT INTO mcn_recommendation_items (mcn_run_id,customer_demand_id,platform,mcn_id,estimated_creator_count,creator_count_score,rebate_score,rating_score,mcn_rank_score,formula_snapshot_json,rating_inputs_json,rank_order,recommend_reason,review_status,created_at) VALUES (?,?,?,?,?,?,?,0,?,CAST(? AS JSON),CAST(? AS JSON),?,?,'draft',NOW())",
          [runId,demandId,p.platform||candidates[0]?.platform||"xhs",r.mcn_id,r.count,r.candidate_count_score,r.rebate_score,r.mcn_rank_score,formula,ratingInputs,i+1,r.cooperation_status==='active'||r.cooperation_status==='unknown'?null:`filtered: ${r.cooperation_status}`]);
      }catch(e){console.error("mcn_recommendation_items insert failed:",e.message);}
    }
    return{success:true,data:{id:runId,candidate_pool_id:p.id,mcn_recommendation_written:true,filtered_out:filteredOut,scoring_method:"weighted: candidate_count(0.5) + rebate_rate(0.5)",source_mix_summary:{required_creator_count:10,matched_creator_count:total,mcn_creator_count:mcnTotal,non_mcn_creator_count:nonMcnC,mcn_ratio:total>0?mcnTotal/total:0,non_mcn_ratio:total>0?nonMcnC/total:0,manual_sourcing_recommended:nonMcnC>0,manual_sourcing_reason:nonMcnC>0?`非MCN达人占比${Math.round(nonMcnC/total*100)}%，建议同步达人拓展`:"供给充足"},mcns:mcnList,inquiry_advice:{selected_mcn_ids:mcnList.map(m=>m.mcn_id),cumulative_candidate_count:mcnTotal,cumulative_supply_multiplier:mcnTotal/10,should_continue_adding:false}},error:null,workflow_state:{phase:"mcn_planning",pending_gate:"confirm-supply-ratio",allowed_actions:["create_with_distributions","manual_source_creators"]}};
  }catch(e){return{success:false,data:null,error:`DB: ${e.message}`};}
}

async function dbGetCreator(p){
  const cid=p?.creator_id||p?.platform_account_id,platform=p?.platform||"xhs";
  try{
    const db=await getPool();
    const table=platform==="dy"?"dy_creator_accounts":"xhs_creator_accounts";
    const [rows]=await db.query(`SELECT * FROM \`${table}\` WHERE id=? LIMIT 1`,[cid]);
    if(rows.length>0){const r=rows[0];return{success:true,data:{creator_id:r.id,nickname:r.nickname,platform:r.platform||platform,followers:r.followercount,organization:r.organization,estimated_price:Number(r.kol_official_price_l1)||0,content_type_label:r.content_type_label,kw_user_url:r.kw_user_url,avglike:r.avglike,avginteract:r.avginteract},error:null};}
    return{success:true,data:{creator_id:cid,nickname:"未知达人"},error:null};
  }catch(e){return{success:false,data:null,error:e.message};}
}

async function dbHealth(){
  try{
    const db=await getPool();
    const [t]=await db.query("SHOW TABLES");
    const [x]=await db.query("SELECT COUNT(*) as c FROM xhs_creator_accounts");
    const [d]=await db.query("SELECT COUNT(*) as c FROM dy_creator_accounts");
    const [r]=await db.query("SELECT COUNT(*) as c FROM customer_demands");
    const [cp]=await db.query("SELECT COUNT(*) as c FROM creator_candidate_pool");
    return{success:true,data:{status:"ok",server:"YPmcn MCP 2.1.4 (DB-backed, 后端转发)",timestamp:new Date().toISOString(),database:{host:DB.host,database:DB.database,tables:t.length,xhs_creators:x[0].c,dy_creators:d[0].c,demands:r[0].c,candidates:cp[0].c},backend:{url:BACKEND_API_URL,configured:!!BACKEND_API_KEY},tools:TOOLS.map(t=>t.name)},error:null};
  }catch(e){return{success:true,data:{status:"degraded",server:"YPmcn MCP 2.1.4 (DB down, 后端转发)",database:{error:e.message},tools:TOOLS.map(t=>t.name)},error:null};}
}

async function dbCreateWithDistributions(p){
  const supplierIds = p?.supplierIds || p?.supplier_ids || [];
  const projectName = p?.projectName || p?.project?.projectName || "未命名项目";
  const deadline = p?.deadline || p?.remindAt || p?.remind_at || "";
  const description = p?.description || p?.project?.description || "";
  const sendWechat = p?.sendWechatNotification !== false;
  const platform = p?.platform || p?.project?.platform || "小红书";
  const mcnPlanId = p?.id || "";  // from rank_mcns.data.id
  const db = await getPool();

  // 默认表单字段（来自达人提报标准模板）
  const defaultColumns = [
    {key:"talentName",name:"达人名称",type:"text",required:true,sort_order:1},
    {key:"platform",name:"平台",type:"single_select",required:true,options:["小红书","抖音"],sort_order:2},
    {key:"homepage",name:"主页链接",type:"link",required:false,sort_order:3},
    {key:"price",name:"报价",type:"number",required:true,sort_order:4},
  ];
  let columns = p?.columns || p?.project?.columns || null;

  // 未传 columns 时，从需求文本推断
  if (!columns && mcnPlanId) {
    const [mcnItems] = await db.query(
      "SELECT customer_demand_id FROM mcn_recommendation_items WHERE mcn_run_id = ? LIMIT 1",
      [mcnPlanId]
    );
    if (mcnItems[0]?.customer_demand_id) {
      const [demands] = await db.query(
        "SELECT raw_messages_json, platform FROM customer_demands WHERE id = ?",
        [mcnItems[0].customer_demand_id]
      );
      if (demands[0]) {
        // JSON 列被 mysql2 自动解析，需提取实际文本
        const rawData = demands[0].raw_messages_json;
        const rawText = typeof rawData === "string" ? rawData :
          Array.isArray(rawData) ? rawData.map(m => m.content || "").join(" ") :
          JSON.stringify(rawData || "");
        columns = buildSuggestedColumns(rawText, demands[0].platform);
      }
    }
  }
  if (!columns) columns = defaultColumns;

  if (p?.preview_only) {
    return {
      success: true,
      data: {
        preview: true,
        projectName,
        deadline,
        columns,
        suppliers: await Promise.all(supplierIds.map(async (sid) => {
          const db = await getPool();
          const group = await lookupSupplierWecomGroup(db, sid);
          return {
            supplierId: sid,
            supplierName: group?.supplierName || sid,
            groupName: group?.groupName || "未知",
            candidateCount: 0,
          };
        })),
      },
      error: null,
    };
  }

  // 解析供应商名称 → UUID + 名称
  const supplierMap = new Map(); // name → {id, name}
  for (const sid of supplierIds) {
    const [rows] = await db.query("SELECT id, name FROM core_supplier WHERE id = ? OR name = ?", [sid, sid]);
    if (rows.length > 0) supplierMap.set(sid, rows[0]);
  }
  const resolvedSupplierIds = [...new Set([...supplierMap.values()].map(s => s.id))];

  // 从候选池构建预填数据（prefillRowsBySupplier）
  let prefillRowsBySupplier = p?.prefillRowsBySupplier || p?.prefill_rows_by_supplier || {};

  if (!p?.prefillRowsBySupplier && !p?.prefill_rows_by_supplier && mcnPlanId) {
    // 1. 查 MCN 推荐结果，获取推荐的 MCN 列表
    const [mcnItems] = await db.query(
      "SELECT DISTINCT mcn_id FROM mcn_recommendation_items WHERE mcn_run_id = ?",
      [mcnPlanId]
    );
    const recommendedMcnIds = new Set(mcnItems.map(m => m.mcn_id).filter(Boolean));

    if (recommendedMcnIds.size > 0) {
      // 2. 对每个供应商，找匹配的 MCN → 查候选池达人 → 查详情 → 构建预填行
      prefillRowsBySupplier = {};

      for (const [supplierName, supplier] of supplierMap) {
        // 找到该供应商对应的 mcn_id（候选池里的 organization）
        const matchingMcnId = [...recommendedMcnIds].find(mid =>
          mid === supplier.id || mid === supplier.name || mid === supplierName
        );

        if (matchingMcnId) {
          const [candidates] = await db.query(
            "SELECT platform, kw_uid FROM creator_candidate_pool WHERE mcn_id = ? LIMIT 30",
            [matchingMcnId]
          );

          const rows = [];
          for (const c of candidates) {
            const table = c.platform === "dy" ? "dy_creator_accounts" : "xhs_creator_accounts";
            const [creators] = await db.query(
              `SELECT nickname, followercount, kol_official_price_l1, kw_user_url FROM \`${table}\` WHERE id = ? LIMIT 1`,
              [c.kw_uid]
            );
            if (creators[0]) {
              rows.push({
                talentName: creators[0].nickname || "未知达人",
                platform: c.platform === "dy" ? "抖音" : "小红书",
                homepage: creators[0].kw_user_url || "",
                price: Number(creators[0].kol_official_price_l1) || 0,
              });
            }
          }
          if (rows.length > 0) {
            // 后端需要带连字符的 UUID 作为 key
            const uuidKey = supplier.id.includes("-") ? supplier.id : supplier.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
            prefillRowsBySupplier[uuidKey] = rows;
          }
        }
      }
    }
  }

  // 通过后端 API 转发
  if (BACKEND_API_URL && BACKEND_API_KEY) {
    const body = {
      projectName,
      description,
      deadline,
      usageScope: p?.usageScope || "project",
      platform,
      columns,
      supplierIds: resolvedSupplierIds,
      sendWechatNotification: sendWechat,
    };
    if (Object.keys(prefillRowsBySupplier).length > 0) {
      body.prefillRowsBySupplier = prefillRowsBySupplier;
    }
    if (p?.notification_template) body.notification_template = p.notification_template;

    try {
      const resp = await fetch(`${BACKEND_API_URL}/api/projects/create-with-distributions/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": BACKEND_API_KEY },
        body: JSON.stringify(body),
      });
      const backendResult = await resp.json();

      if (resp.ok && backendResult.project) {
        const dists = backendResult.distributions?.created || [];
        const sent = dists.filter(d => d.notification_status === "sent").length;
        const failed = dists.filter(d => d.notification_error).length;
        const totalPrefilled = Object.values(prefillRowsBySupplier).reduce((sum, rows) => sum + rows.length, 0);

        const created = dists.map(d => ({
          id: d.id,
          supplier: d.supplier_name,
          supplier_id: d.supplier,
          token: d.token,
          status: d.status,
          row_count: d.row_count,
          notification_status: d.notification_status,
          form_url: `https://ypmcn.eshypdata.com/form?projectId=${backendResult.project.id}&channelId=${d.supplier}&token=${d.token}`,
        }));

        return {
          success: true,
          data: {
            id: backendResult.project.id,
            status: "sent",
            columns_used: columns.length,
            prefill_rows_total: totalPrefilled,
            prefill_by_supplier: Object.fromEntries(
              Object.entries(prefillRowsBySupplier).map(([k, v]) => [k, v.length])
            ),
            distributions: {
              created,
              skipped: backendResult.distributions?.skipped || [],
            },
            wecom_summary: `企微通知: ${sent}/${dists.length} 发送成功 | 预填: ${totalPrefilled} 行`,
          },
          error: null,
          workflow_state: {
            phase: "waiting_mcn_return",
            allowed_actions: ["ingest_mcn_submissions", "manual_source_creators"],
          },
        };
      }
      return { success: false, data: null, error: `后端返回异常: HTTP ${resp.status} — ${JSON.stringify(backendResult).slice(0, 200)}` };
    } catch (e) {
      return { success: false, data: null, error: `后端 API 调用失败: ${e.message}` };
    }
  }

  return {
    success: false,
    data: null,
    error: "缺少后端 API 凭据，已拒绝创建分发",
  };
}

function mock(tool,p){
  switch(tool){
    case"ingest_mcn_submissions":return{success:true,data:{id:tid("ingest"),accepted_count:(p?.items||[]).length,rejected_count:0,created_candidate_count:(p?.items||[]).length},error:null};
    case"manual_source_creators":return{success:true,data:{id:tid("manual"),imported_count:(p?.manual_results||[]).length,created_candidate_count:(p?.manual_results||[]).length},error:null};
    case"rank_creators":return{success:true,data:{run_id:tid("run"),ranked_count:5,dedupe_summary:{before_count:8,after_count:5}},error:null,workflow_state:{phase:"recommendation_ready",pending_gate:"confirm-risky-submission",allowed_actions:["create_submission_batch"]}};
    case"create_submission_batch":return{success:true,data:{id:tid("sb"),batch_no:1,submitted_count:4,need_confirm_count:1,status:"created"},error:null};
    case"record_client_feedback":return{success:true,data:{updated_count:(p?.feedback_items||[]).length,next_action:"continue_submission"},error:null};
    case"get_recommendation_run_detail":return{success:true,data:{run_id:p?.run_id||"unknown",status:"completed",candidate_count:6,ranked_count:5},error:null};
    case"audit_manual_adjustment":return{success:true,data:{id:tid("audit"),status:"approved",applied_count:(p?.adjustments||[]).length},error:null};
    default:return{success:true,data:{status:"ok"},error:null};
  }
}

async function handleCall(tool,args){
  switch(tool){
    case"validate_requirement":return dbValidateRequirement(args);
    case"search_creators":return dbSearchCreators(args);
    case"rank_mcns":return dbRankMcns(args);
    case"create_with_distributions":return dbCreateWithDistributions(args);
    case"get_creator_detail":return dbGetCreator(args);
    case"business_health":return dbHealth();
    default:return mock(tool,args);
  }
}

const server=http.createServer(async(req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, Accept");
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  if(req.method!=="POST"){res.writeHead(405);res.end("Method Not Allowed");return;}
  let body="";req.on("data",c=>body+=c);req.on("end",async()=>{
    try{
      const msg=JSON.parse(body);
      if(msg.method==="initialize"){
        const initResp = { jsonrpc:"2.0", id:msg.id, result:{ protocolVersion:"2024-11-05", capabilities:{ tools:new Object() }, serverInfo:{ name:"ypmcn-mcp-db", version:"2.1.4" } } };
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify(initResp));
        return;
      }
      if(msg.method==="tools/list"){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{tools:TOOLS}}));return;}
      if(msg.method==="tools/call"){
        const t=msg.params?.name||"",args=msg.params?.arguments||{};
        log(msg.id,t,typeof args==="object"?Object.keys(args):args);
        const r=await handleCall(t,args);
        log(msg.id,`${t}_reply`,{success:r.success});
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{content:[{type:"text",text:JSON.stringify(r)}],isError:false}}));
        return;
      }
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{}}));
    }catch(e){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:e.message}}));}
  });
});

writeFileSync(LOG,"");
server.listen(PORT,()=>{
  console.log(`YPmcn MCP 2.1.4 (DB-backed, 企微后端转发)`);
  console.log(`  URL: http://localhost:${PORT}/sse`);
  console.log(`  DB:  ${DB.host}/${DB.database}`);
  console.log(`  API: ${BACKEND_API_KEY ? BACKEND_API_URL + ' ✓' : '未配置 YPMCN_API_KEY（企微不会实际发送）'}`);
  console.log(`  Log: ${LOG}`);
});
