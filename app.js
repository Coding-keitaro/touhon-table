import * as pdfjsLib from "./pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

const BOX = /[┃│┏┓┗┛┠┨┯┷┬┴┼━─]/g;
const OWNER_PURPOSES = ["所有権保存","所有権移転","共有者全員持分全部移転","合併による所有権登記"];
const state={files:[],rows:[]};
const OCR_URLS={
  workerPath:new URL("./tesseract-worker.min.js",import.meta.url).href,
  langPath:new URL("./",import.meta.url).href,
  corePath:new URL("./",import.meta.url).href
};
let ocrWorkerPromise=null,ocrProgressSink=null;
const $=s=>document.querySelector(s);
const nfkc=v=>(v??"").normalize("NFKC");
const compact=v=>nfkc(v).replace(/[\s　]+/g,"");
const cleanLine=v=>nfkc(v).replace(BOX," ").replace(/\s+/g," ").trim();
const stripPrivate=v=>v.replace(/[\uE000-\uF8FF]/g,"");

async function extractPdf(file){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const doc=await pdfjsLib.getDocument({data:bytes,useWorkerFetch:false,isEvalSupported:false}).promise;
  const pages=[];
  for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
    const page=await doc.getPage(pageNo);const content=await page.getTextContent();
    const positioned=content.items.filter(i=>typeof i.str==="string"&&i.str.length).map(i=>({text:i.str,x:i.transform[4],y:i.transform[5],w:i.width||0}));
    positioned.sort((a,b)=>Math.abs(b.y-a.y)>1.8?b.y-a.y:a.x-b.x);
    const rows=[];
    for(const item of positioned){let row=rows.find(r=>Math.abs(r.y-item.y)<1.8);if(!row){row={y:item.y,items:[]};rows.push(row)}row.items.push(item)}
    rows.sort((a,b)=>b.y-a.y);
    pages.push(rows.map(r=>r.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(" ")).join("\n"));
  }
  return pages.join("\n\f\n");
}

const CIRCLED={"⓪":"0","①":"1","②":"2","③":"3","④":"4","⑤":"5","⑥":"6","⑦":"7","⑧":"8","⑨":"9","⑩":"10"};
function normalizeOcr(text){return nfkc(text).replace(/[⓪①②③④⑤⑥⑦⑧⑨⑩]/g,c=>CIRCLED[c]).replace(/[ー―−–—]/g,"-").replace(/用\s*区/g,"甲区")}
function textQuality(text){const c=compact(text);return ["表題部","権利部","所有権","不動産番号","所在","地番","家屋番号"].filter(x=>c.includes(x)).length}
async function getOcrWorker(){
  if(!ocrWorkerPromise){
    if(!globalThis.Tesseract)throw new Error("OCR部品を読み込めませんでした");
    ocrWorkerPromise=Tesseract.createWorker("jpn",1,{...OCR_URLS,gzip:true,logger:m=>{if(ocrProgressSink&&m.status==="recognizing text")ocrProgressSink(m.progress||0)}});
  }
  return ocrWorkerPromise;
}
async function ocrPdf(file,onProgress){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const doc=await pdfjsLib.getDocument({data:bytes,useWorkerFetch:false,isEvalSupported:false}).promise;
  const worker=await getOcrWorker(),pages=[],conf=[];
  for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
    const page=await doc.getPage(pageNo),viewport=page.getViewport({scale:4}),canvas=document.createElement("canvas");
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    await page.render({canvasContext:canvas.getContext("2d",{alpha:false}),viewport}).promise;
    ocrProgressSink=p=>onProgress?.(pageNo,doc.numPages,p);
    const result=await worker.recognize(canvas);
    ocrProgressSink=null;pages.push(result.data.text||"");conf.push(Number(result.data.confidence)||0);
    canvas.width=0;canvas.height=0;page.cleanup();
  }
  await doc.destroy();
  return{text:normalizeOcr(pages.join("\n\f\n")),confidence:conf.length?conf.reduce((a,b)=>a+b,0)/conf.length:0};
}

function section(text,start,end){const a=text.search(start);if(a<0)return"";const tail=text.slice(a);if(!end)return tail;const b=tail.search(end);return b>0?tail.slice(0,b):tail}
function cells(line){return line.split(/[┃│|｜]/).map(cleanLine).filter(v=>v&&!/^[┠┨┯┷┬┴┼━─]+$/.test(v))}
function baseResult(filename){return{filename,management_number:"",property_kind:"",document_type:"",as_of:"",real_estate_number:"",location:"",lot_number:"",house_number:"",one_building_name:"",exclusive_building_name:"",lot_or_building_number:"",land_category_or_building_type:"",area_sqm:"",structure:"",current_owner_name:"",current_owner_address:"",ownership_share:"",share:"",site_right_share:"",acquisition_cause:"",registration_date:"",registration_number:"",latest_rank:"",source_method:"文字データ",ocr_confidence:"",flags:"",status:"要確認",review_reason:"",evidence:""}}

function filenameMeta(filename,r){
  const f=nfkc(filename),no=f.match(/【\s*(\d+)/);if(no)r.management_number=no[1];
  if(f.includes("土地全部事項"))r.property_kind="土地";else if(f.includes("建物全部事項"))r.property_kind="建物";
  const m=f.replace(/^.*?】/,"").match(/^(.+?丁目)([0-9]+(?:-[0-9]+)*)不動産登記/);
  if(!m)return;r.location=m[1];const number=m[2];
  if(r.property_kind==="土地")r.lot_number=number;
  else{r.house_number=number;const parts=number.split("-");r.lot_number=parts.slice(0,Math.min(2,parts.length)).join("-")}
}
function valueAfterLabel(lines,label){for(const raw of lines){const cs=cells(raw),cc=cs.map(compact);for(let i=0;i<cc.length;i++)if(cc[i]===label&&cs[i+1])return compact(cs[i+1]).replace(/余白/g,"")}return""}
function supplementalTitle(text,r){const c=compact(text),sr=c.match(/[敷整]地権の割合.{0,120}?([0-9]+)分の([0-9]+)/);if(sr)r.site_right_share=`${sr[1]}分の${sr[2]}`;if(!r.as_of){const m=nfkc(text.slice(0,300)).match(/([0-9]{4})\s*\/\s*([0-9]{2})\s*\/\s*([0-9]{2})/);if(m)r.as_of=`${m[1]}-${m[2]}-${m[3]}`}}

function parseTitle(text,r){
  const all=compact(text).replace(BOX,"");let m=all.match(/不動産番号([0-9]{13})/);if(m)r.real_estate_number=m[1];
  m=nfkc(text.slice(0,180)).match(/([0-9]{4})\/([0-9]{2})\/([0-9]{2})/);if(m)r.as_of=`${m[1]}-${m[2]}-${m[3]}`;
  const land=/表\s*題\s*部\s*[（(]土地の表示[）)]/.test(text),building=/表\s*題\s*部\s*[（(](?:主である建物|一棟の建物|専有部分の建物)の表示[）)]/.test(text);
  r.document_type=land?"土地全部事項":building?"建物全部事項":"対象外";if(r.document_type==="対象外")return;
  r.property_kind=land?"土地":"建物";
  const title=section(text,/表\s*題\s*部/,/権\s*利\s*部\s*[（(]\s*甲\s*区\s*[）)]/),lines=title.split("\n");
  for(const line of lines){const cs=cells(line),cc=cs.map(compact);cc.forEach((v,i)=>{if(v==="所在"&&cs[i+1])r.location=stripPrivate(compact(cs[i+1]));if(building&&v==="家屋番号"&&cs[i+1])r.house_number=compact(cs[i+1]).replace(/番地?/g,"-").replace(/の/g,"-").replace(/-+/g,"-").replace(/-$/,"")})}
  if(land){let started=false,lot="",cat="",area="";for(const line of lines){const cs=cells(line),cc=cs.map(compact);if(cc.some(v=>v.includes("地番"))&&compact(line).includes("地目")){started=true;continue}if(!started)continue;for(const v of cc.slice(0,2)){if(/^[0-9]+番(?:[0-9]+)?$/.test(v))lot=v.replace("番","-").replace(/-$/,"")}for(const v of cc){if(["宅地","田","畑","山林","原野","雑種地","公衆用道路","境内地","墓地","池沼"].includes(v))cat=v;const a=v.match(/([0-9]+):([0-9]{2})/);if(a)area=`${Number(a[1])}.${a[2]}`}}r.lot_or_building_number=lot;r.land_category_or_building_type=cat;r.area_sqm=area;
  }else{for(const line of lines){const cs=cells(line);if(cs.length>=3&&compact(line).includes("階建")){r.land_category_or_building_type=compact(cs[0]);r.structure=compact(cs[1]);const a=compact(cs[2]).match(/([0-9]+):([0-9]{2})/);if(a)r.area_sqm=`${Number(a[1])}.${a[2]}`;for(const x of cs.slice(3)){if(/^[^0-9]{1,3}$/.test(compact(x)))r.land_category_or_building_type+=compact(x)}break}}
    const whole=section(text,/一\s*棟\s*の\s*建\s*物\s*の\s*表\s*示/,/専\s*有\s*部\s*分\s*の\s*建\s*物\s*の\s*表\s*示/),exclusive=section(text,/専\s*有\s*部\s*分\s*の\s*建\s*物\s*の\s*表\s*示/,/敷\s*地\s*権\s*の\s*表\s*示|権\s*利\s*部/);
    r.one_building_name=valueAfterLabel(whole.split("\n"),"建物の名称");r.exclusive_building_name=valueAfterLabel(exclusive.split("\n"),"建物の名称");
  }
  r.lot_number=r.lot_number|| (land?r.lot_or_building_number:"");r.house_number=r.house_number||(!land?r.lot_or_building_number:"");r.lot_or_building_number=land?r.lot_number:r.house_number;
  supplementalTitle(text,r);
}

function purposeAtStart(rest){if(rest.startsWith("所有権移転請求権仮登記"))return"所有権移転請求権仮登記";for(const p of OWNER_PURPOSES)if(rest.startsWith(p))return p;const pm=rest.match(/^(.+?持分全部移転)/);if(pm)return pm[1];const generic=rest.match(/^(.+?)(?=(?:明治|大正|昭和|平成|令和)[0-9]+年|第[0-9]+号|所有者|共有者|受託者|原因|$)/);return generic?.[1]||""}
function eventBlocksStandard(kouku){const lines=kouku.split("\n"),out=[];let current=null;for(const raw of lines){const line=cleanLine(raw),m=line.match(/^([0-9]+)\s+(.+?)(?=\s+(?:明治|大正|昭和|平成|令和)[0-9]+年|\s+所有者|\s+共有者|$)/);if(m){if(current)out.push(current);current={rank:m[1],purpose:compact(m[2]),lines:[raw]}}else if(current)current.lines.push(raw)}if(current)out.push(current);return out.map(x=>({...x,block:x.lines.join("\n")}))}
function eventBlocksOcr(kouku){const lines=kouku.split("\n"),out=[];let current=null;for(const raw of lines){const line=compact(cleanLine(raw)),ranked=line.match(/^([0-9]+)(.+)$/);let rank="",purpose="";if(ranked){rank=ranked[1];purpose=purposeAtStart(ranked[2])}else{purpose=purposeAtStart(line);if(!OWNER_PURPOSES.includes(purpose)&&!purpose.includes("持分全部移転"))purpose="";rank=current?.rank||""}if(purpose){if(current)out.push(current);current={rank,purpose,lines:[raw]}}else if(current)current.lines.push(raw)}if(current)out.push(current);return out.map(x=>({...x,block:x.lines.join("\n")}))}
function entityFrom(block,label){const lines=block.split("\n").map(cleanLine).filter(Boolean);let start=-1,tail="";for(let i=0;i<lines.length;i++){const c=compact(lines[i]),at=c.indexOf(label);if(at>=0){start=i;tail=c.slice(at+label.length);break}}if(start<0)return["","",""];const candidates=[];if(tail)candidates.push(tail);for(const raw of lines.slice(start+1)){let c=compact(raw);const num=c.match(/^第[0-9]+号(.*)$/);if(num){c=num[1];if(!c)continue}if(/^(順位|原因|受付|会社法人等番号|信託目録)/.test(c))continue;if(/(?:付記[0-9]+号|[0-9]+番.*登記名義人|権利部)/.test(c))break;if(c)candidates.push(c)}let share="";const filtered=[];for(let x of candidates){const s=x.match(/持分([0-9]+分の[0-9]+)/);if(s){share=s[1];x=x.replace(s[0],"")}if(/^[0-9]+分の[0-9]+$/.test(x)){share=x;continue}if(x)filtered.push(x)}const entity=/(株式会社|有限会社|合同会社|学校法人|宗教法人|一般社団法人|公益社団法人|財団法人|銀行|組合|機構|公社)/;let idx=-1;filtered.forEach((x,i)=>{if(entity.test(x))idx=i});if(idx<0&&filtered.length>=2)idx=filtered.length-1;if(idx<0)return["","",share];let name=filtered[idx],addressParts=filtered.slice(0,idx);const combined=name.match(/^(.+?(?:号|番地(?:の[0-9]+)?))(.+)$/);if(combined&&entity.test(combined[2])){addressParts.push(combined[1]);name=combined[2]}return[name,addressParts.join(""),share]}

const ENTITY_WORDS=/(株式会社|有限会社|合同会社|学校法人|宗教法人|一般社団法人|公益社団法人|財団法人|銀行|組合|機構|公社)/;
const ADDRESS_START=/^(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県|福岡市|北九州市|京都市)/;
const gcd=(a,b)=>{a=Math.abs(a);b=Math.abs(b);while(b)[a,b]=[b,a%b];return a||1};
function fraction(value){const m=compact(value).match(/([0-9]+)分の([0-9]+)/);return m?{n:Number(m[2]),d:Number(m[1])}:null}
function reduce(f){const g=gcd(f.n,f.d);return{n:f.n/g,d:f.d/g}}
function addFraction(a,b){return reduce({n:a.n*b.d+b.n*a.d,d:a.d*b.d})}
function fractionText(f){const x=reduce(f);return x.n===x.d?"全部":`${x.d}分の${x.n}`}
function parseEntities(block,label){const raw=block.split("\n").map(v=>compact(cleanLine(v))).filter(Boolean);let start=-1,tail="";for(let i=0;i<raw.length;i++){const at=raw[i].indexOf(label);if(at>=0){start=i;tail=raw[i].slice(at+label.length);break}}if(start<0)return[];const tokens=[];if(tail)tokens.push(tail);for(const original of raw.slice(start+1)){let c=original.replace(/^第[0-9]+号/,"");if(!c)continue;if(/^(付記[0-9]+号|順位|原因|受付|会社法人等番号|信託目録|権利部)/.test(c))break;if(c)tokens.push(c)}const out=[];let current={address:"",share:""};for(let token of tokens){const sm=token.match(/(?:持分)?([0-9]+分の[0-9]+)/);if(sm&&compact(token)===compact(sm[0])){current.share=sm[1];continue}const combined=token.match(/^(.+?(?:号|番地(?:の[0-9]+)?))(.+)$/);if(combined&&ENTITY_WORDS.test(combined[2])){current.address+=combined[1];out.push({name:combined[2],address:current.address,share:current.share});current={address:"",share:""};continue}if(ADDRESS_START.test(token)){current.address+=token;continue}if(current.address&&(/[0-9]/.test(token)||/^(?:号|番地|地の|丁目|番)/.test(token))&&!ENTITY_WORDS.test(token)){current.address+=token;continue}if(current.address){out.push({name:token,address:current.address,share:current.share});current={address:"",share:""}}}return out.filter(x=>x.name)}
function addOwner(ledger,owner,fallback=null){const f=fraction(owner.share)||fallback;if(!owner.name||!f)return false;const prior=ledger.get(owner.name);ledger.set(owner.name,{name:owner.name,address:owner.address||prior?.address||"",frac:prior?addFraction(prior.frac,f):reduce(f)});return true}
function updateAttachedAddresses(kouku,ledger){const c=compact(kouku).replace(BOX,""),escape=v=>v.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");for(const owner of ledger.values()){const re=new RegExp(`共有者${escape(owner.name)}の住所((?:東京都|北海道|(?:京都|大阪)府|.{2,3}県|福岡市|北九州市|京都市).+?(?:号|番地(?:の[0-9]+)?))`),m=c.match(re);if(m)owner.address=m[1]}}

function fallbackEntities(block){
  const banned=/(所有権|原因|順位|登記|移記|規定|受付|法務省|差押|相続|売買|本店|住所|権利部|余白|平成|令和|昭和|債権者|抵当権|番号)/;
  const out=[];
  for(const raw of block.split("\n")){
    const c=compact(cleanLine(raw)).replace(/[|｜]/g,"");if(!c||banned.test(c))continue;
    const corp=c.match(/([一-龯ぁ-んァ-ヶA-Za-zー]{1,30}(?:株式会社|有限会社|合同会社|学校法人|宗教法人|組合|機構|公社))/);if(corp){out.push({name:corp[1],address:"",share:""});continue}
    if(ADDRESS_START.test(c)||/[0-9]/.test(c))continue;
    if(/^[一-龯ぁ-んァ-ヶー]{2,14}$/.test(c))out.push({name:c,address:"",share:""});
  }
  return out.slice(-6);
}

function rightsSection(text,kind){const lines=text.split("\n"),normalized=lines.map(x=>compact(x).replace(/[。.・_]/g,"")),mark=kind==="甲"?/権利部[（(][甲用]区/:/権利部[（(]乙区/,start=normalized.findIndex(x=>mark.test(x));if(start<0)return"";let end=lines.length;if(kind==="甲"){const i=normalized.findIndex((x,n)=>n>start&&/権利部[（(]乙区/.test(x));if(i>start)end=i}return lines.slice(start,end).join("\n")}
function parseKouku(text,r,isOcr=false){const kouku=rightsSection(text,"甲");if(!kouku){r.review_reason="甲区を検出できません";return}const events=(isOcr?eventBlocksOcr(kouku):eventBlocksStandard(kouku)).filter(e=>OWNER_PURPOSES.includes(e.purpose)||(e.purpose.includes("持分")&&!e.purpose.includes("仮登記")));if(!events.length){r.review_reason="所有権に関する登記事件を検出できません";r.evidence=kouku.split("\n").slice(0,18).map(cleanLine).filter(Boolean).join("\n");return}const ledger=new Map(),relevant=[],ledgerReasons=[];let e=null;for(const ev of events){const cb=compact(ev.block),label=cb.includes("受託者")?"受託者":cb.includes("共有者")?"共有者":"所有者";if(OWNER_PURPOSES.includes(ev.purpose)){let owners=parseEntities(ev.block,label);if(!owners.length)owners=fallbackEntities(ev.block);if(!owners.length){ledgerReasons.push(`順位${ev.rank}番の所有者を読めません`);continue}ledger.clear();if(owners.length===1&&!owners[0].share)owners[0].share="1分の1";for(const owner of owners)if(!addOwner(ledger,owner))ledgerReasons.push(`順位${ev.rank}番の持分を読めません`);e=ev;relevant.push(ev);continue}const pm=ev.purpose.match(/^(.+?)持分全部移転$/);if(pm){const source=ledger.get(pm[1]);let recipients=parseEntities(ev.block,label);if(!recipients.length)recipients=fallbackEntities(ev.block);if(!source){ledgerReasons.push(`順位${ev.rank}番の移転元「${pm[1]}」を特定できません`);continue}let added=false;for(const owner of recipients)added=addOwner(ledger,owner,recipients.length===1?source.frac:null)||added;if(!added){ledgerReasons.push(`順位${ev.rank}番の移転先持分を読めません`);continue}ledger.delete(pm[1]);e=ev;relevant.push(ev);continue}ledgerReasons.push(`順位${ev.rank}番「${ev.purpose}」は持分再計算が必要`)}if(!e||!ledger.size){r.review_reason=ledgerReasons.join(" / ")||"現在所有者を確定できません";return}updateAttachedAddresses(kouku,ledger);const owners=[...ledger.values()].sort((a,b)=>b.frac.n/b.frac.d-a.frac.n/a.frac.d),total=owners.reduce((a,o)=>addFraction(a,o.frac),{n:0,d:1}),cb=compact(e.block);r.latest_rank=e.rank;r.current_owner_name=owners.map(o=>o.name).join(" / ");r.current_owner_address=owners.map(o=>o.address).join(" / ");r.ownership_share=owners.map(o=>fractionText(o.frac)).join(" / ");r.share=r.ownership_share;let m=cb.match(/原因([^┃│\n]+)/);if(m)r.acquisition_cause=m[1];m=cb.match(/((?:明治|大正|昭和|平成|令和)[0-9]+年[0-9]+月[0-9]+日)/);if(m)r.registration_date=m[1];m=cb.match(/第([0-9]+)号/);if(m)r.registration_number=m[1];
  const attached=cb.match(new RegExp(`付記[0-9]+号[┃│]*${e.rank}番登記名義人[^付記]*`));if(attached){const a=attached[0].match(/(?:本店|商号本店|主たる事務所名称)((?:東京都|北海道|(?:京都|大阪)府|.{2,3}県|福岡市|北九州市).+?(?:号|番地(?:の[0-9]+)?))/);if(a)r.current_owner_address=a[1]}
  const flags=[],all=compact(text);if(compact(kouku).includes("差押"))flags.push("差押履歴");if(compact(kouku).includes("仮登記"))flags.push("仮登記");if(compact(kouku).includes("信託"))flags.push("信託");if(all.includes("抵当権"))flags.push("抵当権等");if(owners.length>1)flags.push(`共有${owners.length}名`);r.flags=flags.join(" / ");r.evidence=relevant.flatMap(x=>x.block.split("\n")).map(cleanLine).filter(Boolean).slice(-24).join("\n");const reasons=[...ledgerReasons];if(total.n!==total.d)reasons.push(`持分合計が100%になりません（${fractionText(total)}）`);if(flags.includes("信託"))reasons.push("信託登記のため受託者・受益関係の確認を推奨");r.status=reasons.length?"要確認":"自動確定";r.review_reason=reasons.join(" / ")
}
function parseTitleOwner(text,r){const lines=text.split("\n").map(cleanLine);for(let i=0;i<lines.length;i++){const c=compact(lines[i]);if(!c.includes("所有者"))continue;const block=[lines[i],lines[i+1]||""].join("\n"),entities=parseEntities(block,"所有者"),fallback=fallbackEntities(block),owners=entities.length?entities:fallback;if(owners.length){r.current_owner_name=owners.map(x=>x.name).join(" / ");r.current_owner_address=owners.map(x=>x.address).filter(Boolean).join(" / ");r.ownership_share=owners.length===1?"全部":owners.map(x=>x.share||"要確認").join(" / ");r.share=r.ownership_share;return}}}
async function parseFile(file,onOcrProgress){const r=baseResult(file.name);filenameMeta(file.name,r);try{let text=await extractPdf(file),ocrUsed=false;if(textQuality(text)<3){const ocr=await ocrPdf(file,onOcrProgress);text=ocr.text;ocrUsed=true;r.source_method="端末内OCR";r.ocr_confidence=Math.round(ocr.confidence)}parseTitle(text,r);filenameMeta(file.name,r);supplementalTitle(text,r);if(r.document_type==="対象外"&&r.property_kind)r.document_type=`${r.property_kind}全部事項`;if(r.document_type==="対象外"){r.review_reason="土地・建物の全部事項証明書ではありません";return r}parseKouku(text,r,ocrUsed);if(!r.current_owner_name)parseTitleOwner(text,r);if(r.property_kind==="土地"&&compact(text).includes("敷地権")&&!r.current_owner_name){r.current_owner_name="敷地権化済み（専有部分の謄本参照）";r.flags=[r.flags,"敷地権化済み"].filter(Boolean).join(" / ")}if(r.property_kind==="建物"&&r.site_right_share&&!r.exclusive_building_name){const last=r.house_number.split("-").pop();if(last)r.exclusive_building_name=last}if(ocrUsed){const checks=[`OCR読取（精度目安${r.ocr_confidence}%）：所有者名・持分を原文確認`];if(compact(text).includes("一棟の建物")&&!r.one_building_name)checks.push("一棟の建物の名称を原文確認");r.status="要確認";r.review_reason=[...checks,r.review_reason].filter(Boolean).join(" / ");r.flags=[r.flags,"OCR"].filter(Boolean).join(" / ")}r.evidence=r.evidence||text.split("\n").map(cleanLine).filter(Boolean).slice(-30).join("\n")}catch(err){r.status="エラー";r.review_reason=`解析エラー: ${err?.message||err}`}return r}

const HEADERS=[["management_number","番号"],["property_kind","種別"],["one_building_name","一棟の建物の名称"],["location","所在"],["lot_number","地番"],["house_number","家屋番号"],["exclusive_building_name","専有部分の建物の名称"],["current_owner_name","現在所有者"],["ownership_share","所有権持分"],["site_right_share","敷地権割合"],["current_owner_address","所有者住所"],["as_of","証明書基準日"],["real_estate_number","不動産番号"],["land_category_or_building_type","地目・種類"],["area_sqm","地積・床面積㎡"],["structure","構造"],["acquisition_cause","取得原因"],["latest_rank","根拠順位番号"],["source_method","読取方法"],["ocr_confidence","OCR精度目安%"],["flags","注意事項"],["status","判定"],["review_reason","要確認理由"],["evidence","根拠原文"],["filename","ファイル名"]];
const xml=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));const col=n=>{let s="";while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};const cell=(ref,v,style=0)=>`<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
async function exportXlsx(rows){const z=new JSZip(),sheetRows=[];sheetRows.push(`<row r="1" ht="30" customHeight="1">${HEADERS.map(([,h],i)=>cell(`${col(i+1)}1`,h,1)).join("")}</row>`);rows.forEach((r,ri)=>sheetRows.push(`<row r="${ri+2}">${HEADERS.map(([k],i)=>cell(`${col(i+1)}${ri+2}`,r[k],k==="status"||k==="review_reason"?2:0)).join("")}</row>`));const maxRow=rows.length+1,maxCol=col(HEADERS.length),widths=HEADERS.map(([k])=>({management_number:9,property_kind:9,one_building_name:30,location:30,lot_number:14,house_number:24,exclusive_building_name:18,current_owner_name:28,ownership_share:20,site_right_share:18,current_owner_address:38,evidence:70,filename:46,review_reason:48}[k]||16)),cols=widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join("");z.file("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);z.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);z.file("xl/workbook.xml",`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="登記一覧" sheetId="1" r:id="rId1"/></sheets></workbook>`);z.file("xl/_rels/workbook.xml.rels",`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);z.file("xl/worksheets/sheet1.xml",`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${maxCol}${maxRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows.join("")}</sheetData><autoFilter ref="A1:${maxCol}${maxRow}"/></worksheet>`);z.file("xl/styles.xml",`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Yu Gothic"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Yu Gothic"/></font><font><sz val="10"/><name val="Yu Gothic"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173A57"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9E1E8"/></left><right style="thin"><color rgb="FFD9E1E8"/></right><top style="thin"><color rgb="FFD9E1E8"/></top><bottom style="thin"><color rgb="FFD9E1E8"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="1" xfId="0"><alignment vertical="center" wrapText="1"/></xf><xf fontId="2" fillId="3" borderId="1" xfId="0"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);const blob=await z.generateAsync({type:"blob",compression:"DEFLATE"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="謄本解析結果.xlsx";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

const drop=$("#dropzone"),input=$("#file-input"),analyze=$("#analyze"),clear=$("#clear"),status=$("#status"),queue=$("#queue"),progress=$("#progress");drop.onclick=()=>input.click();drop.ondragover=e=>{e.preventDefault();drop.classList.add("dragging")};drop.ondragleave=()=>drop.classList.remove("dragging");drop.ondrop=e=>{e.preventDefault();drop.classList.remove("dragging");setFiles(e.dataTransfer.files)};input.onchange=e=>setFiles(e.target.files);
function setFiles(list){state.files=[...list].filter(f=>f.name.toLowerCase().endsWith(".pdf")).slice(0,100);analyze.disabled=!state.files.length;clear.disabled=!state.files.length;queue.classList.toggle("hidden",!state.files.length);queue.innerHTML=`<b>${state.files.length}件を選択</b><br>${state.files.map(f=>xml(f.name)).join("<br>")}`;status.textContent=state.files.length?"準備できました。解析を開始できます。":"PDFを選択してください。"}
clear.onclick=()=>{state.files=[];state.rows=[];input.value="";analyze.disabled=true;clear.disabled=true;queue.classList.add("hidden");$("#results").classList.add("hidden");status.textContent="土地・建物・区分建物の全部事項に対応しています。"};
analyze.onclick=async()=>{analyze.disabled=true;state.rows=[];progress.classList.remove("hidden");for(let i=0;i<state.files.length;i++){status.textContent=`解析中 ${i+1}/${state.files.length}: ${state.files[i].name}`;state.rows.push(await parseFile(state.files[i],(page,total,p)=>{status.textContent=`OCR読取中 ${i+1}/${state.files.length}・${page}/${total}ページ（${Math.round(p*100)}%）`}));progress.firstElementChild.style.width=`${(i+1)/state.files.length*100}%`}render();status.textContent=`${state.rows.length}件の解析が完了しました。`;analyze.disabled=false};
const esc=xml;const inp=(r,k,i)=>`<input class="cell" data-i="${i}" data-k="${k}" value="${esc(r[k])}">`;
function render(){const auto=state.rows.filter(r=>r.status==="自動確定").length,excluded=state.rows.filter(r=>r.document_type==="対象外").length,review=state.rows.filter(r=>r.status==="要確認"&&r.document_type!=="対象外").length;$("#metrics").innerHTML=`<div class="metric"><b>${state.rows.length}</b>全件</div><div class="metric"><b>${auto}</b>自動確定</div><div class="metric"><b>${review}</b>要確認</div><div class="metric"><b>${excluded}</b>対象外</div>`;$("#result-body").innerHTML=state.rows.map((r,i)=>`<tr><td><span class="badge ${r.status==="自動確定"?"ok":r.status==="エラー"?"error":"review"}">${esc(r.status)}</span></td><td>${inp(r,"management_number",i)}</td><td>${esc(r.property_kind)}</td><td>${inp(r,"location",i)}</td><td>${inp(r,"lot_number",i)}</td><td>${inp(r,"one_building_name",i)}</td><td>${inp(r,"house_number",i)}</td><td>${inp(r,"exclusive_building_name",i)}</td><td>${inp(r,"current_owner_name",i)}</td><td>${inp(r,"ownership_share",i)}</td><td>${inp(r,"site_right_share",i)}</td><td>${inp(r,"current_owner_address",i)}</td><td>${esc([r.flags,r.review_reason].filter(Boolean).join(" / "))}</td><td><details><summary>原文を見る</summary><pre>${esc(r.evidence)}</pre></details></td><td>${esc(r.source_method)}</td><td>${esc(r.filename)}</td></tr>`).join("");document.querySelectorAll(".cell").forEach(el=>el.oninput=e=>state.rows[Number(e.target.dataset.i)][e.target.dataset.k]=e.target.value);$("#results").classList.remove("hidden");$("#results").scrollIntoView({behavior:"smooth",block:"start"})}
$("#export").onclick=()=>exportXlsx(state.rows);
