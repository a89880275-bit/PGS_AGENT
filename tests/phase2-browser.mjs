import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireLocal } from '../apps/phase2/common.mjs';

const {chromium}=requireLocal('playwright-core','PGS_BROWSER_MODULES');
const origin='http://127.0.0.1:'+(process.env.PGS_PORT??4180);
const agentOrigin='http://127.0.0.1:'+(process.env.PGS_AGENT_PORT??4181);
const screenshots=process.env.PGS_SCREENSHOTS;
if(screenshots) await mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PGS_BROWSER_EXE,args:['--disable-background-networking']});
const desktop=await browser.newContext({viewport:{width:1440,height:960}});
const mobile=await browser.newContext({viewport:{width:320,height:800},isMobile:true,hasTouch:true});
for(const context of [desktop,mobile]){
  context.setDefaultTimeout(15000);
  await context.route('**/*',route=>[origin,agentOrigin].some(base=>route.request().url().startsWith(base+'/'))?route.continue():route.abort());
}
const agent=await desktop.newPage(), admin=await desktop.newPage(), patient=await mobile.newPage();
const observations=[];
for(const page of [agent,admin,patient]) page.on('pageerror',error=>observations.push(error.message));
const heading=(page,name)=>page.getByRole('heading',{name,exact:true}).waitFor();
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const link=(page,name)=>page.getByRole('link',{name,exact:true});
const capture=async(page,file)=>{if(screenshots) await page.screenshot({path:resolve(screenshots,file),fullPage:true});};
try{
  await agent.goto(origin+'/agent');
  await heading(agent,'내부 저장소 및 중계');
  await agent.getByText('연결됨',{exact:true}).waitFor();
  await capture(agent,'agent-storage.png');
  await link(agent,'수동등록').click();
  const sample=await fetch(agentOrigin+'/mock/sample');
  await agent.getByLabel('테스트 PDF 선택').setInputFiles({name:'0100111120261124a01.pdf',mimeType:'application/pdf',buffer:Buffer.from(await sample.arrayBuffer())});
  await button(agent,'파일명 분석 및 환자 확인').click();
  await agent.getByText('1 / 2',{exact:true}).waitFor();
  await button(agent,'내부 저장 및 등록').click();
  const url=await link(agent,'환자 시연 링크 열기').getAttribute('href');
  assert.ok(url.startsWith(origin+'/v/'));
  await capture(agent,'agent-registration.png');

  await admin.goto(origin+'/admin#settings');
  await heading(admin,'기본 보관 정책');
  assert.equal(await admin.getByLabel('PDF 보관일').inputValue(),'30');
  await admin.getByLabel('PDF 보관일').fill('90');
  await admin.getByLabel('링크 유효일').fill('30');
  await button(admin,'정책 저장').click();
  await admin.getByText('DEFAULT · 90일 / 30일',{exact:true}).waitFor();
  await capture(admin,'admin-policy.png');
  await link(admin,'안내문 종류').click();
  await heading(admin,'문서 종류별 보관 정책');
  await admin.getByLabel('PDF 보관일').fill('1');
  await admin.getByLabel('링크 유효일').fill('1');
  await button(admin,'정책 저장').click();
  await admin.getByText('G001 · 1일 / 1일',{exact:true}).waitFor();
  await link(admin,'안내문 관리').click();
  await heading(admin,'안내문 목록');
  const row=admin.getByRole('row').filter({has:admin.locator('a[href="'+new URL(url).pathname+'"]')});
  await row.getByRole('button',{name:'미리보기',exact:true}).click();
  await admin.getByText('1 / 2',{exact:true}).waitFor();

  await patient.goto(url);
  assert.equal(await patient.getByText('외래 안내문',{exact:true}).count(),0);
  await patient.getByLabel('생년월일').fill('19550203');
  await button(patient,'확인').click();
  await heading(patient,'외래 안내문');
  await patient.getByText('1 / 2',{exact:true}).waitFor();
  await patient.waitForFunction(()=>{
    const canvas=document.querySelector('canvas');
    return canvas?.getContext('2d')?.getImageData(10,10,1,1).data[3]>0;
  });
  await button(patient,'다음').click();
  await patient.getByText('2 / 2',{exact:true}).waitFor();
  assert.equal(await patient.evaluate(()=>document.documentElement.scrollWidth),320);
  const download=patient.waitForEvent('download');
  await link(patient,'PDF 다운로드').click();
  assert.equal((await download).suggestedFilename(),'pgs-test.pdf');
  await capture(patient,'patient-relay.png');
  assert.deepEqual(observations,[]);
  console.log('Phase 2 Edge UI passed: Agent local PDF, administrator policies/preview, 320px patient view/download');
}finally{await browser.close();}