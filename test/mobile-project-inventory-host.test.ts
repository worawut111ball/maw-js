import {test,expect} from 'bun:test';
import {createMobileApi} from '../src/mobile/api';
const cfg={token:'test-only-token',hookToken:'test-only-hook',allowedLogins:[]};
const request=(auth=true)=>new Request('http://localhost/mobile/projects',{headers:auth?{authorization:'Bearer test-only-token'}:{}});
test('host inventory uses real authenticated API without external discovery or fallback',async()=>{
  let reads=0,discovery=0;
  const api=createMobileApi(cfg,{projectInventory:async()=>{reads++;return [];},herdr:{setDialogParser(){},listProjects:async()=>{discovery++;throw Error('must not discover');}} as any});
  expect((await api.handle(request(false))).status).toBe(401);expect(reads).toBe(0);
  const response=await api.handle(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({projects:[]});
  expect(reads).toBe(1);expect(discovery).toBe(0);
});
test('host inventory failure is sanitized and never falls through to ambient discovery',async()=>{
  let discovery=0;
  const api=createMobileApi(cfg,{projectInventory:async()=>{throw Error('private source detail');},herdr:{setDialogParser(){},listProjects:async()=>{discovery++;return [];}} as any});
  const response=await api.handle(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('private source detail');expect(discovery).toBe(0);
});
test('host inventory still uses actual owned registry projection',async()=>{
  const binding={agent:'claude',nativeId:'native',generation:'gen',cursor:0,model:'model',route:'mind'};
  const room={id:'logical',workspace:'lab',room:'room',backend:'herdr',cwd:'/fixture',revision:1,active:'claude',bindings:{claude:binding}};
  const transport={kind:'owned-protocol',roomId:'logical',revision:1,binding,state:'idle',capabilities:{textTurn:false,attachments:false,keys:false}};
  const api=createMobileApi(cfg,{projectInventory:async()=>[],continuity:{owned:{inventory:async()=>[{room,transport}]}} as any});
  const response=await api.handle(request());expect(response.status).toBe(200);
  const body=await response.json();expect(body.projects[0].workspaces[0].rooms[0]).toMatchObject({logicalRoomId:'logical',transportKind:'owned-protocol',capabilities:{prompt:false,keys:false}});
});
