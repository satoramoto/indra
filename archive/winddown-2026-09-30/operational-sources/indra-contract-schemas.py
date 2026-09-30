from pathlib import Path
import json
root=Path('/Users/ryan/.codex/worktrees/indra-remodel-contract/indra')
def obj(p):return {'type':'object','additionalProperties':False,'required':list(p),'properties':p}
def arr(p,minimum=0,maximum=None):
 r={'type':'array','items':p}
 if minimum:r['minItems']=minimum
 if maximum:r['maxItems']=maximum
 return r
text={'type':'string','pattern':r'\S'};ident={'type':'string','pattern':'^[a-z][a-z0-9-]*$'};sha={'type':'string','pattern':'^[0-9a-f]{40}$'};ver={'type':'integer','const':1}
strings=arr(text);owned=arr(text,1,128);pr={'type':'string','pattern':r'^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$'}
outcome=obj({'number':{'type':'integer','minimum':1},'title':text,'description':text,'reason':text,'currentCode':strings})
proposal=obj({'version':ver,'goalId':ident,'proposalId':ident,'productSeatId':ident,'rank':{'type':'integer','minimum':1},'mission':text,'summary':text,'outcomes':arr(outcome,1),'ownedFiles':owned,'risks':strings,'rationale':text,'basedOnRetros':strings})
report=obj({'version':ver,'goalId':ident,'teamId':ident,'seatId':ident,'sprintBranch':{'type':'string','pattern':'^sprint/[a-z][a-z0-9-]*$'},'headSha':sha,'lanePrs':arr(obj({'laneId':ident,'url':pr,'headSha':sha,'mergedSha':sha,'reviewer':{'type':'string','const':'satori-miyamoto'},'ci':{'type':'string','const':'passed'}}),1),'checks':arr(obj({'command':text,'exitCode':{'type':'integer'}}),1),'decisions':strings,'followUps':strings,'neededButUnowned':strings})
brief=obj({'version':ver,'goalId':ident,'teamId':ident,'seatId':ident,'header':obj({'repo':text,'baseBranch':text,'baseSha':sha,'branch':text,'prTarget':text}),'outcomes':arr(outcome,1),'ownedFiles':owned,'exclusions':arr(obj({'files':owned,'owner':text,'reason':text})),'swarm':text,'retros':arr(obj({'goalId':ident,'path':text,'summary':text}),0,3),'redirects':arr(obj({'postId':text,'userId':text,'at':{'type':'string','format':'date-time'},'message':text})),'reportFormat':text})
plan=obj({'version':ver,'goalId':ident,'lanes':arr(obj({'id':ident,'branch':text,'ownedFiles':owned,'dependsOn':arr(ident)}),1,128),'contractLaneId':{'anyOf':[ident,{'type':'null'}]}})
for name,contents in [('goal-brief',brief),('goal-report',report),('product-proposal',proposal),('lane-plan',plan)]: (root/f'schemas/{name}.json').write_text(json.dumps(contents,indent=2)+'\n')
p=root/'schema/v1/state.schema.json';schema=json.loads(p.read_text());defs=schema['$defs'];defs['seat']['properties']['roles']['items']['enum']=['Team Lead','Product','Developer'];defs['team']['properties']['workflowModel']={'const':'goals-v1'}
role=lambda r:{'type':'object','properties':{'roles':{'const':[r]}},'required':['roles']}
newteam={'properties':{'seats':{'allOf':[{'contains':role('Team Lead'),'minContains':1,'maxContains':1},{'contains':role('Product'),'minContains':1,'maxContains':1},{'contains':role('Developer'),'minContains':1}]}}}
defs['team']['allOf']=[{'if':{'required':['workflowModel']},'then':newteam,'else':{'properties':{'seats':{'not':{'contains':role('Product')}}}}}]
g=defs['planningGoal'];g['properties'].update({'workflowModel':{'const':'goals-v1'},'ownedFiles':owned,'goalProposal':proposal,'goalAssignment':obj({'seatId':ident,'status':{'enum':['assigned','running','reported','failed']},'updatedAt':{'type':'string','format':'date-time'}})})
g['allOf']=[{'if':{'required':['workflowModel']},'then':{'required':['ceremony'],'not':{'anyOf':[{'required':['proposal']},{'required':['assignments']}]},'allOf':[{'if':{'properties':{'stage':{'enum':['awaiting-review','approved']}}},'then':{'required':['goalProposal']},'else':{'not':{'required':['goalProposal']}}},{'if':{'properties':{'stage':{'const':'approved'}}},'then':{'required':['ownedFiles']},'else':{'not':{'anyOf':[{'required':['goalAssignment']},{'required':['integration']}]}}},{'if':{'required':['goalAssignment']},'then':{'required':['integration']}}]},'else':{'not':{'anyOf':[{'required':['goalProposal']},{'required':['goalAssignment']},{'required':['ownedFiles']}]},'allOf':g['allOf']}}]
p.write_text(json.dumps(schema,indent=2)+'\n')
# Keep one canonical assignment type, and require approved containment when the caller supplies a scope.
p=root/'src/planning.ts';s=p.read_text().replace('type ProductProposal }','type ProductProposal, type GoalAssignment }');s=s.replace('export interface GoalAssignment { seatId: string; status: "assigned" | "running" | "reported" | "failed"; updatedAt: string }','export type { GoalAssignment } from "./goal-contract.js";');p.write_text(s)
p=root/'src/goal-contract.ts';s=p.read_text().replace('export function validateLanePlan(value: unknown): LanePlan {','export function validateLanePlan(value: unknown, approvedOwnedFiles?: readonly string[]): LanePlan {').replace('  assertDisjointOwnedFiles(lanes);','  assertDisjointOwnedFiles(lanes);\n  if (approvedOwnedFiles) for (const lane of lanes) assertOwnedFilesWithin(lane.ownedFiles, approvedOwnedFiles);');p.write_text(s)
