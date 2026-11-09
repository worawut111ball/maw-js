/** Explicit trusted startup, never called by HTTP or automatic discovery. */
import {loadProtocolHostComposition,type ProtocolHostConfig,type ProtocolHostAuthority,type ProtocolHostBootstrap,type ProtocolHostMechanisms} from '../mobile/continuity/protocol/host-composition';
import {ContinuityError} from '../mobile/continuity/types';
import {ProtocolProcessSupervisor} from '../mobile/continuity/protocol/process-supervisor';
export interface OneWayServerStartup {
  config:ProtocolHostConfig;authority:ProtocolHostAuthority;
  /** Operator-reviewed owned Codex rooms only. No shared-TUI adoption or implicit resume. */
  bootstrap:ProtocolHostBootstrap[];
}
export async function prepareOneWayServerHost(input:OneWayServerStartup,mechanisms:ProtocolHostMechanisms={}){
  if(input.config.activation?.mode!=='production'||input.config.activation.policy!=='codex-to-claude-v1'
    ||!input.authority.productionPolicy||!Array.isArray(input.bootstrap)||!input.bootstrap.length
    ||input.bootstrap.some(b=>b.agent!=='codex'||b.resume||!b.firstTurn)
    ||new Set(input.bootstrap.map(b=>b.scopeId)).size!==input.bootstrap.length
    ||input.bootstrap.length!==input.config.scopes?.length)throw new ContinuityError('production_startup_unverified');
  // Resolve no policy/token/config until the operator explicitly enters this function.
  const composition=loadProtocolHostComposition(input.config,input.authority,{...mechanisms,supervisor:mechanisms.supervisor??(options=>new ProtocolProcessSupervisor({...options,lifetimeMode:'owned-session'}))});
  if(composition.kind!=='configured')throw new ContinuityError('production_startup_unverified');
  try{
    const receipts=[];
    for(const request of input.bootstrap)receipts.push(await composition.bootstrapOwned(structuredClone(request)));
    return {mobile:{continuity:composition.featureOptions},receipts,close:()=>composition.close()};
  }catch(error){await composition.close();throw error;}
}
