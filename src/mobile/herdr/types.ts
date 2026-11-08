export type Runner = (args: string[], timeoutMs?: number) => Promise<string>;
export class HerdrError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'HerdrError'; }
}
export interface ConversationRef { agent: 'claude'|'codex'; kind: 'id'|'path'; value: string; source: string }
export interface Capabilities { history: boolean; screen: boolean; prompt: boolean; keys: boolean; answer: boolean; stop: boolean; close: boolean; create: boolean }
export interface HerdrChannel {
  kind: 'herdr'; endpointId: 'local'; session: 'default'; workspaceId: string; paneId: string; terminalId: string;
  label: string; agent: string|null; generation: string; conversation: ConversationRef|null; continuityToken: string|null;
  capabilities: Capabilities;
}
export interface HerdrRoom { id:string; title:string; agent:string|null; status:'working'|'waiting'|'done'|'idle'|'unknown'; claudeSessionId:null; generation:string; capabilities:Capabilities; continuityToken:string|null }
export interface HerdrProject { name:string; source:'herdr'; workspaces:{id:string;name:string;branch:null;rooms:HerdrRoom[]}[] }
export interface DispatchRequest {
  id:string; action:'prompt'|'key'|'literal'|'answer'|'stop'|'bootstrap'; expectedGeneration:string;
  text?:string; key?:string; n?:number; expectedDialogToken?:string; continuityToken?:string;
  offline?:boolean; createdAt?:number; parentId?:string; resolveParent?:boolean;
}
export type DeliveryState = 'dispatching'|'acknowledged'|'definitely-rejected'|'uncertain'|'unknown';
export interface DeliveryResult { id:string; state:DeliveryState; ok:boolean; code?:string; generation?:string; parentId?:string }
export interface HistoryQuery { before?:string|number; limit?:string|number; epoch?:string }
export interface HistoryItem { i:number; role:'user'|'assistant'|'tool'|'agent'|'system'; text?:string; ts?:string|null; images?:string[]; queued?:boolean; tool?:{name:string;summary:string;input:string;output:string|null;error:boolean} }
export type HistoryResult = {ok:true;kind:'messages';epoch:string;total:number;start:number;items:HistoryItem[];conversation:string} | {ok:true;kind:'none';available:false;reason:string};
export interface Dialog { kind?:string; sig?:string; question?:string; options?:{n:number;label:string;free?:boolean;sel?:boolean;[key:string]:unknown}[]; tab?:number|null; [key:string]:unknown }
export interface DialogResult { ok:true; prompt:Dialog|null; generation:string; dialogToken?:string }
export interface HistoryOptions { claudeRoot?:string; codexRoot?:string; allowedSources?:string[]; maxBytes?:number; maxFiles?:number }
export interface RuntimeOptions {
  runner?:Runner; now?:()=>number; ledgerPath?:string; history?:HistoryOptions; continuityMs?:number;
  canDispatch?:(channel:HerdrChannel)=>boolean|Promise<boolean>;
  beforeDispatch?:(channel:HerdrChannel)=>Promise<void>;
  parseDialog?:(text:string)=>Dialog|null;
}
export interface HerdrRuntime {
  listProjects():Promise<HerdrProject[]>; resolve(ws:string,room:string):HerdrChannel|null;
  screen(channel:HerdrChannel,lines?:number):Promise<string>;
  history(channel:HerdrChannel,query?:HistoryQuery):Promise<HistoryResult>;
  dispatch(channel:HerdrChannel,request:DispatchRequest):Promise<DeliveryResult>;
  deliveryStatus(id:string,channel?:HerdrChannel):DeliveryResult;
  resolveDelivery(id:string,channel:HerdrChannel):DeliveryResult;
  dialog(channel:HerdrChannel):Promise<DialogResult>; refresh():Promise<void>; close():void;
  setDialogParser(parser:(text:string)=>Dialog|null):void;
  setDispatchGuard(guard:(channel:HerdrChannel)=>boolean|Promise<boolean>):void;
}
