/**
 * YPmcn MCP Server — DB-backed read, mock write 2.1.2
 *
 * 只读操作查真实 MySQL (d-oa-test.eshypdata.com/ypmcn)
 * 写操作对已有表结构兼容则落库，否则返回 mock 结果 + workflow_state
 */
import http from "node:http";
import { writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

const PORT = 19876, LOG = "/tmp/mock-mcp-log.jsonl";
const DB = { host:"d-oa-test.eshypdata.com",port:3306,user:"ypmcn",password:"Yp123456!@#",database:"ypmcn",connectTimeout:5000 };

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
  {name:"manual_source_creators",description:"手扒导入",inputSchema:{type:"object",properties:{id:{type:"string"},manual_results:{type:"array",items:{type:"object"}}}}},
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
    await db.query("INSERT INTO customer_demands (id,demand_id,demand_version,platform,submission_deadline_at,submission_deadline_raw,raw_messages_json,budget_min_cents,budget_max_cents,budget_raw,rebate_min_rate,rebate_max_rate,rebate_raw,quantity_total,status,project_name,brand,product,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?,NOW(),NOW())",[demandId,demandId,p.platform,p.submission_deadline_at,p.submission_deadline_at||"",rawJson,p.budget_min_cents||0,p.budget_max_cents,p.budget_raw||"",p.rebate_min_rate||0,p.rebate_max_rate||0,p.rebate_raw||"",p.quantity_total,p.project_name||null,p.brand||null,p.product||null]);
    return{success:true,data:{id:demandId,demand_id:demandId,demand_version:1,status:"ready",requirement_parsed:{platform:p.platform,quantity_total:p.quantity_total,budget_min_cents:p.budget_min_cents||0,budget_max_cents:p.budget_max_cents,budget_raw:p.budget_raw||"",rebate_min_rate:p.rebate_min_rate||0,rebate_max_rate:p.rebate_max_rate||0,rebate_raw:p.rebate_raw||"",submission_deadline_at:p.submission_deadline_at}},error:null,workflow_state:{phase:"requirement_ready",pending_gate:"confirm-structured-brief",allowed_actions:["search_creators"]}};
  }catch(e){return{success:false,data:null,error:`DB: ${e.message}`};}
}

async function dbSearchCreators(p){
  if(!p?.id)return{success:false,data:null,error:"missing id"};
  try{
    const db=await getPool();
    const [dems]=await db.query("SELECT * FROM customer_demands WHERE id=?",[p.id]);
    if(!dems[0])return{success:false,data:null,error:`demand not found: ${p.id}`};
    const demand=dems[0],platform=p.platform||demand.platform||"xhs";
    const table=platform==="dy"?"dy_creator_accounts":"xhs_creator_accounts";
    const [rows]=await db.query(`SELECT * FROM \`${table}\` WHERE date IS NOT NULL LIMIT 100`);
    if(!Array.isArray(rows))return{success:false,data:null,error:"query failed"};
    const poolId=tid("cpool");let inserted=0,mcnC=0,nonMcnC=0;
    // First clean old pool for this demand
    await db.query("DELETE FROM creator_candidate_pool WHERE id=?",[poolId]);
    for(const r of rows.slice(0,50)){
      const hasOrg=r.organization&&r.organization!=="";
      try{
        await db.query("INSERT INTO creator_candidate_pool (id,platform,platform_account_id,mcn_id,candidate_source,hard_filter_passed,content_match_score,created_at,updated_at) VALUES (?,?,?,?,'rate_card',1,0.50,NOW(),NOW())",[poolId,platform,String(r.id||""),hasOrg?r.organization:null]);
        inserted++;if(hasOrg)mcnC++;else nonMcnC++;
      }catch(_){}
    }
    return{success:true,data:{id:poolId,candidate_pool_written:true,total_matched:inserted,supply_assessment:{candidate_count:inserted,quantity_total:demand.quantity_total||10,supply_multiplier:inserted/(demand.quantity_total||10),supply_risk_level:inserted>=5?"low_risk":"high_risk",should_start_manual_sourcing:inserted<(demand.quantity_total||10)}},error:null,workflow_state:{phase:"candidate_pool_ready",pending_gate:null,allowed_actions:["rank_mcns"]}};
  }catch(e){return{success:false,data:null,error:`DB: ${e.message}`};}
}

async function dbRankMcns(p){
  if(!p?.id)return{success:false,data:null,error:"missing id"};
  try{
    const db=await getPool();
    const [candidates]=await db.query("SELECT * FROM creator_candidate_pool WHERE id=?",[p.id]);
    const mcnMap=new Map();let nonMcnC=0;
    for(const c of candidates){
      if(c.mcn_id){if(!mcnMap.has(c.mcn_id))mcnMap.set(c.mcn_id,[]);mcnMap.get(c.mcn_id).push(c);}
      else nonMcnC++;
    }
    const mcnList=[];let idx=0;
    for(const [name,crews] of mcnMap){
      const [suppliers]=await db.query("SELECT id,name FROM core_supplier WHERE name=?",[name]);
      const s=suppliers[0];
      mcnList.push({mcn_id:s?.id||name,agency_name:name,supplier_name:s?.name||name,estimated_creator_count:crews.length,mcn_rank_score:Math.round((0.95-idx*0.05)*100)/100,risk_notes:[]});
      idx++;
    }
    mcnList.sort((a,b)=>b.mcn_rank_score-a.mcn_rank_score);
    const total=candidates.length,mcnTotal=total-nonMcnC;
    return{success:true,data:{id:tid("mcnrec"),candidate_pool_id:p.id,source_mix_summary:{required_creator_count:10,matched_creator_count:total,mcn_creator_count:mcnTotal,non_mcn_creator_count:nonMcnC,mcn_ratio:total>0?mcnTotal/total:0,non_mcn_ratio:total>0?nonMcnC/total:0,manual_sourcing_recommended:nonMcnC>0,manual_sourcing_reason:nonMcnC>0?`非MCN达人占比${Math.round(nonMcnC/total*100)}%，建议同步手扒`:"供给充足"},mcns:mcnList,inquiry_advice:{selected_mcn_ids:mcnList.map(m=>m.mcn_id),cumulative_candidate_count:mcnTotal,cumulative_supply_multiplier:mcnTotal/10,should_continue_adding:false}},error:null,workflow_state:{phase:"mcn_planning",pending_gate:"confirm-supply-ratio",allowed_actions:["create_with_distributions","manual_source_creators"]}};
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
    return{success:true,data:{status:"ok",server:"YPmcn MCP 2.1.2 (DB-backed)",timestamp:new Date().toISOString(),database:{host:DB.host,database:DB.database,tables:t.length,xhs_creators:x[0].c,dy_creators:d[0].c,demands:r[0].c,candidates:cp[0].c},tools:TOOLS.map(t=>t.name)},error:null};
  }catch(e){return{success:true,data:{status:"degraded",server:"YPmcn MCP 2.1.2 (DB down)",database:{error:e.message},tools:TOOLS.map(t=>t.name)},error:null};}
}

function mock(tool,p){
  switch(tool){
    case"create_with_distributions":
      if(p?.preview_only)return{success:true,data:{preview:true,suppliers:p.supplierIds||[]},error:null};
      return{success:true,data:{id:tid("dist"),inquiry_ids:(p.supplierIds||[]).map((_,i)=>tid("inq")),status:"sent",distributions:{created:(p.supplierIds||[]).map(s=>({supplier:s,token:"tok-"+s.slice(0,6),status:"pending"}))}},error:null,workflow_state:{phase:"waiting_mcn_return",allowed_actions:["ingest_mcn_submissions","manual_source_creators"]}};
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
        const initResp = { jsonrpc:"2.0", id:msg.id, result:{ protocolVersion:"2024-11-05", capabilities:{ tools:new Object() }, serverInfo:{ name:"ypmcn-mcp-db", version:"2.1.2" } } };
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
server.listen(PORT,()=>{console.log(`YPmcn MCP 2.1.2 (DB-backed)`);console.log(`  URL: http://localhost:${PORT}/sse`);console.log(`  DB:  ${DB.host}/${DB.database}`);console.log(`  Log: ${LOG}`);});
