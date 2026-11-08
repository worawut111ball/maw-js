import {test,expect} from 'bun:test';
import {mergeOwnedInventory} from '../src/mobile/continuity/protocol/inventory';
import type {Room} from '../src/mobile/continuity/types';
import type {OwnedTransportStatus} from '../src/mobile/features/continuity';
const room:Room={id:'logical',workspace:'workspace',room:'pane',backend:'herdr',cwd:'/fixture/project',revision:3,active:'claude',bindings:{claude:{agent:'claude',nativeId:'native',generation:'generation',cursor:4,model:'model',route:'mind'}}};
const transport:OwnedTransportStatus={kind:'owned-protocol',roomId:room.id,revision:3,binding:room.bindings.claude!,state:'idle',capabilities:{textTurn:true,attachments:false,keys:false}};
test('owned projection preserves logical aliases/title and disables TUI capabilities without mutating source',()=>{
 const projects=[{name:'Existing',source:'herdr',workspaces:[{id:'workspace',name:'Workspace',branch:null,rooms:[{id:'pane',title:'Room title',agent:'codex',generation:'old'}]}]}];
 const result=mergeOwnedInventory(projects,[{room,transport}]);
 expect(result).toHaveLength(1);expect(result[0].workspaces[0].rooms).toHaveLength(1);
 expect(result[0].workspaces[0].rooms[0]).toMatchObject({id:'pane',title:'Room title',agent:'claude',logicalRoomId:'logical',transportKind:'owned-protocol',generation:'generation',capabilities:{keys:false,screen:false,prompt:true}});
 expect(projects[0].workspaces[0].rooms[0].agent).toBe('codex');
});
test('only trusted supplied scopes create inventory, stale or duplicate mapping is rejected',()=>{
 const result=mergeOwnedInventory([],[{room,transport}]);expect(result[0].path).toBe(room.cwd);expect(result[0].workspaces[0].id).toBe(room.workspace);
 expect(()=>mergeOwnedInventory([],[{room,transport:{...transport,revision:2}}])).toThrow('owned_inventory_invalid');
 expect(()=>mergeOwnedInventory([],[{room,transport},{room,transport}])).toThrow('owned_inventory_invalid');
 expect(()=>mergeOwnedInventory([{workspaces:[{id:'workspace',rooms:[]}]},{workspaces:[{id:'workspace',rooms:[]}]}],[{room,transport}])).toThrow('owned_inventory_alias_conflict');
});
