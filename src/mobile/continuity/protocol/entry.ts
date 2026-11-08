import { ProtocolError, type ProtocolPolicy, type ProtocolWire, type ProtocolHooks } from './types';
import { CodexProtocolSession } from './codex';
import { ClaudeProtocolSession } from './claude';
import {createHash} from 'node:crypto';

/** Internal DI seam for the frozen buildProtocolLaunch result, never a user API.
 * Mapping does not attest native binaries, approve config, or grant launch authority.
 * Deliberately never retains, returns or logs candidate.env (credentials).
 */
export interface ProtocolEntryBinding {
  kind:'codex-app-server-stdio'|'claude-stream-json';
  route:'mind'|'direct'; model:string; provider:string; endpoint:string|null;
  home:string; toolHome:string; cwd:string;
  nativeBinary:string; nativeSha256:string; nativeVersion:string; sessionId:string|null;
}
export interface ProtocolEntryCandidate {
  tool:'codex'|'claude'; model:string; route:string; cwd:string; binary:string;
  binding:ProtocolEntryBinding;
  eligibility:{candidateOnly:true;liveEligible:false};
}
export type HomeEnvironment={state:'absent'}|{state:'present';value:string};
export interface ProtocolEntryBindingV2 extends Omit<ProtocolEntryBinding,'toolHome'> {
  version:2; effectiveToolHome:string; homeEnvironment:HomeEnvironment;
}
export interface ProtocolEntryCandidateV2 extends Omit<ProtocolEntryCandidate,'binding'> {
  version:2; binding:ProtocolEntryBindingV2;
  session:{mode:'fresh'}|{mode:'resume';id:string};
}
export interface ProtocolPilotPolicy {kind:'claude-context-only-safe';version:1}
export interface ProtocolPilotBinding extends Omit<ProtocolEntryBindingV2,'version'> {
  version:3;pilotPolicy:ProtocolPilotPolicy;policyArgvHash:string;
}
export interface ProtocolPilotCandidate extends Omit<ProtocolEntryCandidateV2,'version'|'binding'> {
  version:3;binding:ProtocolPilotBinding;pilotPolicy:ProtocolPilotPolicy;
  policyArgvHash:string;finalArgvHash:string;args:readonly string[];
}
export type ProtocolRuntimeCandidate=ProtocolEntryCandidateV2|ProtocolPilotCandidate;
export type ProtocolRuntimeBinding=ProtocolEntryBindingV2|ProtocolPilotBinding;
const policyHash=createHash('sha256').update(JSON.stringify(['--safe-mode','--tools',''])).digest('hex');
export function protocolPolicyFromPilotEntry(candidate:ProtocolPilotCandidate,timeoutMs:number):Readonly<ProtocolPolicy> {
  const b=candidate.binding;
  const valid=(p:ProtocolPilotPolicy)=>p?.kind==='claude-context-only-safe'&&p.version===1;
  if(candidate.version!==3||b?.version!==3||candidate.tool!=='claude'||b.kind!=='claude-stream-json'
    ||!valid(candidate.pilotPolicy)||!valid(b.pilotPolicy)||candidate.policyArgvHash!==policyHash||b.policyArgvHash!==policyHash
    ||!Array.isArray(candidate.args)||candidate.args.some(a=>typeof a!=='string')
    ||JSON.stringify(candidate.args.slice(-3))!==JSON.stringify(['--safe-mode','--tools',''])
    ||createHash('sha256').update(JSON.stringify(candidate.args)).digest('hex')!==candidate.finalArgvHash)
    throw new ProtocolError('protocol_pilot_binding_invalid');
  // Validate shared scalar mapping; original v3 policy binding must remain in host journal/admission.
  return protocolPolicyFromEntryV2({...candidatePolicyFields(candidate),version:2,session:candidate.session,binding:{...b,version:2}},timeoutMs);
}
export function protocolRuntimePolicy(candidate:ProtocolRuntimeCandidate,timeoutMs:number):Readonly<ProtocolPolicy> {
  if(candidate.version===3)return protocolPolicyFromPilotEntry(candidate,timeoutMs);
  return protocolPolicyFromEntryV2(candidate,timeoutMs);
}
export function protocolRuntimeDriver(candidate:ProtocolRuntimeCandidate,wire:ProtocolWire,timeoutMs:number,hooks:ProtocolHooks={}) {
  const policy=protocolRuntimePolicy(candidate,timeoutMs);
  return policy.agent==='codex'?new CodexProtocolSession(wire,policy,hooks):new ClaudeProtocolSession(wire,policy,hooks);
}
/** Explicit versioned mapping, never fallback/retry through the v1 entry builder.
 * Original v2 binding including presence remains the runtime host's durable identity.
 */
export function protocolPolicyFromEntryV2(candidate:ProtocolEntryCandidateV2,timeoutMs:number):Readonly<ProtocolPolicy> {
  const b=candidate.binding,p=b?.homeEnvironment;
  if(candidate.version!==2 || b?.version!==2 || Object.hasOwn(b,'toolHome') || !p
    || (p.state!=='absent'&&p.state!=='present')
    || (p.state==='absent'&&Object.hasOwn(p,'value'))
    || (p.state==='present'&&p.value!==b.effectiveToolHome)
    || (candidate.session?.mode==='fresh'?b.sessionId!==null:
        candidate.session?.mode!=='resume'||candidate.session.id!==b.sessionId||!b.sessionId))
    throw new ProtocolError('protocol_entry_v2_binding_invalid');
  // Reuse scalar policy validation only; never construct/launch a v1 candidate.
  return protocolPolicyFromEntry({...candidatePolicyFields(candidate),binding:{...b,toolHome:b.effectiveToolHome}},timeoutMs);
}
// Never spread the candidate: an enumerable env property may contain credentials
// or a lazy accessor. Policy mapping needs only these public scalar fields.
function candidatePolicyFields(candidate:Omit<ProtocolEntryCandidate,'binding'>) {
  return {tool:candidate.tool,model:candidate.model,route:candidate.route,cwd:candidate.cwd,
    binary:candidate.binary,eligibility:candidate.eligibility};
}
export function protocolDriverFromEntryV2(candidate:ProtocolEntryCandidateV2,wire:ProtocolWire,timeoutMs:number,hooks:ProtocolHooks={}) {
  const policy=protocolPolicyFromEntryV2(candidate,timeoutMs);
  return policy.agent==='codex'?new CodexProtocolSession(wire,policy,hooks):new ClaudeProtocolSession(wire,policy,hooks);
}
export function protocolPolicyFromEntry(candidate:ProtocolEntryCandidate,timeoutMs:number):Readonly<ProtocolPolicy> {
  const b=candidate.binding;
  const agent=b?.kind==='codex-app-server-stdio'?'codex':b?.kind==='claude-stream-json'?'claude':null;
  if(!agent || candidate.eligibility?.candidateOnly!==true || candidate.eligibility?.liveEligible!==false
    || candidate.tool!==agent || candidate.model!==b.model || candidate.route!==b.route
    || candidate.cwd!==b.cwd || candidate.binary!==b.nativeBinary
    || b.nativeVersion!==(agent==='codex'?'0.164.0':'2.1.220')
    || !/^[a-f0-9]{64}$/.test(b.nativeSha256)
    || !['mind','direct'].includes(b.route)
    || [b.home,b.toolHome,b.cwd,b.nativeBinary].some(p=>typeof p!=='string'||!p.startsWith('/')||p.includes('\0'))
    || !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000)
    throw new ProtocolError('protocol_entry_binding_invalid');
  // Claude account.apiProvider is a separate native vocabulary; do not pass the
  // entry label "anthropic" as an asserted native account/provider observation.
  return Object.freeze({agent,home:b.home,toolHome:b.toolHome,cwd:b.cwd,model:b.model,route:b.route,timeoutMs,
    ...(agent==='codex'?{modelProvider:b.provider}:{})});
}
export function protocolDriverFromEntry(candidate:ProtocolEntryCandidate,wire:ProtocolWire,timeoutMs:number,hooks:ProtocolHooks={}) {
  const policy=protocolPolicyFromEntry(candidate,timeoutMs);
  // Constructors have no I/O. Caller owns durable launch/prepare/turn boundaries.
  return policy.agent==='codex'?new CodexProtocolSession(wire,policy,hooks):new ClaudeProtocolSession(wire,policy,hooks);
}
